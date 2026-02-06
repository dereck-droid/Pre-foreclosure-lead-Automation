import { skipTrace as config } from './config.js';
import { log } from './logger.js';
import { updateSkipTrace } from './database.js';
import type { Filing } from './database.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkipTraceResult {
  phones: string[];
  emails: string[];
  mailingAddress: string;
  success: boolean;
}

// ---------------------------------------------------------------------------
// Tracerfy API integration
// ---------------------------------------------------------------------------

/**
 * Look up contact info for a person using Tracerfy.
 *
 * NOTE: Tracerfy's exact API format may differ. We'll need to verify their
 * docs once you have an account. This is built from their public documentation.
 * If the request format is wrong, the error message will tell us what to fix.
 */
async function callTracerfy(
  name: string,
  address: string
): Promise<SkipTraceResult> {
  if (!config.apiKey) {
    throw new Error(
      'TRACERFY_API_KEY is not set. Add it to your .env file.\n' +
      'Sign up at https://www.tracerfy.com'
    );
  }

  // Parse name into first/last (best effort)
  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Parse address (basic — the county data may already be structured)
  const addressParts = address.split(',').map(p => p.trim());

  const requestBody = {
    firstName,
    lastName,
    address: addressParts[0] || address,
    city: addressParts[1] || '',
    state: addressParts[2] || 'FL',
    zip: addressParts[3] || '',
  };

  log.info(`Skip tracing: ${firstName} ${lastName} at ${addressParts[0] || address}`);

  const response = await fetch(`${config.baseUrl}/trace`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Tracerfy API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as any;

  // Extract phone numbers and emails from response
  // NOTE: Adjust these field names based on Tracerfy's actual response format
  const phones: string[] = data.phones || data.phoneNumbers || [];
  const emails: string[] = data.emails || data.emailAddresses || [];
  const mailingAddress: string = data.mailingAddress || data.address || '';

  return {
    phones: Array.isArray(phones) ? phones : [phones].filter(Boolean),
    emails: Array.isArray(emails) ? emails : [emails].filter(Boolean),
    mailingAddress,
    success: true,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Skip trace a single filing and update the database */
export async function skipTraceFiling(filing: Filing): Promise<SkipTraceResult> {
  try {
    const result = await callTracerfy(filing.grantee_name, filing.property_address);

    updateSkipTrace(
      filing.document_number,
      result.phones,
      result.emails,
      result.mailingAddress,
      'success'
    );

    log.success(
      `Skip trace complete: ${filing.grantee_name}`,
      { phones: result.phones.length, emails: result.emails.length }
    );

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Skip trace failed for ${filing.grantee_name}: ${message}`);

    updateSkipTrace(filing.document_number, [], [], '', 'failed');

    return {
      phones: [],
      emails: [],
      mailingAddress: '',
      success: false,
    };
  }
}

/** Skip trace all provided filings with a delay between each */
export async function skipTraceFilings(
  filings: Filing[],
  delayMs: number = 1000
): Promise<{ successful: number; failed: number; totalCostUsd: number }> {
  let successful = 0;
  let failed = 0;
  const costPerLookup = 0.02; // Tracerfy rate

  for (const filing of filings) {
    const result = await skipTraceFiling(filing);
    if (result.success) successful++;
    else failed++;

    // Be polite to the API — don't blast requests
    if (filings.indexOf(filing) < filings.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  const totalCostUsd = successful * costPerLookup;
  log.info(`Skip tracing complete`, { successful, failed, totalCostUsd: `$${totalCostUsd.toFixed(2)}` });

  return { successful, failed, totalCostUsd };
}
