import { crm as crmConfig } from './config.js';
import { log } from './logger.js';
import { updateCrmStatus } from './database.js';
import type { EnrichedFiling } from './database.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CrmPushResult {
  success: boolean;
  method: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Generic webhook push
// ---------------------------------------------------------------------------

async function pushToWebhook(filing: EnrichedFiling): Promise<CrmPushResult> {
  if (!crmConfig.webhookUrl) {
    throw new Error(
      'CRM_WEBHOOK_URL is not set. Add it to your .env file.\n' +
      'Get a webhook URL from Ben\'s CRM or use an n8n webhook.'
    );
  }

  const payload = {
    grantee_name: filing.grantee_name,
    grantor_name: filing.grantor_name,
    legal_description: filing.legal_description,
    document_number: filing.document_number,
    document_type: filing.document_type,
    recording_date: filing.recording_date,
    phones: filing.phones,
    emails: filing.emails,
    mailing_address: filing.mailing_address,
    source: 'Orange County Lis Pendens - Auto',
    scraped_at: new Date().toISOString(),
  };

  const response = await fetch(crmConfig.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Webhook failed (${response.status}): ${errorText}`);
  }

  return { success: true, method: 'webhook' };
}

// ---------------------------------------------------------------------------
// GoHighLevel API push
// ---------------------------------------------------------------------------

async function pushToGoHighLevel(filing: EnrichedFiling): Promise<CrmPushResult> {
  if (!crmConfig.ghl.apiKey) {
    throw new Error(
      'GHL_API_KEY is not set. Add it to your .env file.\n' +
      'Get your GoHighLevel API key from Settings > Business Profile > API Keys.'
    );
  }

  // Parse name into first/last
  const nameParts = filing.grantee_name.trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Parse address components
  const addressParts = filing.property_address.split(',').map(p => p.trim());

  const contactPayload = {
    firstName,
    lastName,
    phone: filing.phones[0] || '',
    email: filing.emails[0] || '',
    address1: addressParts[0] || filing.property_address,
    city: addressParts[1] || '',
    state: addressParts[2] || 'FL',
    postalCode: addressParts[3] || '',
    tags: ['Lis Pendens', 'Orange County', 'Auto-Scraped'],
    source: 'OC Lis Pendens Scraper',
    customFields: [
      { key: 'document_number', value: filing.document_number },
      { key: 'recording_date', value: filing.recording_date },
      { key: 'property_address', value: filing.property_address },
      { key: 'mailing_address', value: filing.mailing_address },
      { key: 'all_phones', value: filing.phones.join(', ') },
      { key: 'all_emails', value: filing.emails.join(', ') },
    ],
  };

  // First, check if contact already exists (by phone)
  if (filing.phones[0]) {
    const searchResponse = await fetch(
      `${crmConfig.ghl.baseUrl}/contacts/search/duplicate?` +
      new URLSearchParams({
        locationId: crmConfig.ghl.locationId,
        phone: filing.phones[0],
      }),
      {
        headers: {
          'Authorization': `Bearer ${crmConfig.ghl.apiKey}`,
          'Version': '2021-07-28',
        },
      }
    );

    if (searchResponse.ok) {
      const searchData = await searchResponse.json() as any;
      if (searchData.contact) {
        // Contact exists — update instead of create
        log.info(`Contact already exists in GHL, updating: ${filing.grantee_name}`);

        const updateResponse = await fetch(
          `${crmConfig.ghl.baseUrl}/contacts/${searchData.contact.id}`,
          {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${crmConfig.ghl.apiKey}`,
              'Content-Type': 'application/json',
              'Version': '2021-07-28',
            },
            body: JSON.stringify(contactPayload),
          }
        );

        if (!updateResponse.ok) {
          const errorText = await updateResponse.text();
          throw new Error(`GHL update failed (${updateResponse.status}): ${errorText}`);
        }

        return { success: true, method: 'gohighlevel-update' };
      }
    }
  }

  // Create new contact
  const createResponse = await fetch(
    `${crmConfig.ghl.baseUrl}/contacts/`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${crmConfig.ghl.apiKey}`,
        'Content-Type': 'application/json',
        'Version': '2021-07-28',
      },
      body: JSON.stringify({
        ...contactPayload,
        locationId: crmConfig.ghl.locationId,
      }),
    }
  );

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`GHL create failed (${createResponse.status}): ${errorText}`);
  }

  return { success: true, method: 'gohighlevel-create' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Push a single enriched filing to the configured CRM */
export async function pushToCrm(filing: EnrichedFiling): Promise<CrmPushResult> {
  try {
    let result: CrmPushResult;

    if (crmConfig.mode === 'gohighlevel') {
      result = await pushToGoHighLevel(filing);
    } else {
      result = await pushToWebhook(filing);
    }

    updateCrmStatus(filing.document_number, 'pushed');
    log.success(`CRM push: ${filing.grantee_name} → ${result.method}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`CRM push failed for ${filing.grantee_name}: ${message}`);
    updateCrmStatus(filing.document_number, 'failed');
    return { success: false, method: crmConfig.mode, error: message };
  }
}

/** Push all enriched filings to CRM with retry logic */
export async function pushFilingsToCrm(
  filings: EnrichedFiling[],
  delayMs: number = 500
): Promise<{ pushed: number; failed: number }> {
  let pushed = 0;
  let failed = 0;

  for (const filing of filings) {
    let result = await pushToCrm(filing);

    // Retry once on failure
    if (!result.success) {
      log.info(`Retrying CRM push for ${filing.grantee_name} in 5 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      result = await pushToCrm(filing);
    }

    if (result.success) pushed++;
    else failed++;

    // Small delay between pushes
    if (filings.indexOf(filing) < filings.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  log.info('CRM push complete', { pushed, failed });
  return { pushed, failed };
}
