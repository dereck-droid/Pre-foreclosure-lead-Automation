import { notifications as config } from './config.js';
import { log } from './logger.js';

// ---------------------------------------------------------------------------
// SMS via Twilio
// ---------------------------------------------------------------------------

async function sendSms(to: string, message: string): Promise<boolean> {
  if (!config.twilio.accountSid || !config.twilio.authToken || !config.twilio.fromNumber) {
    log.warn('Twilio not configured — skipping SMS alert');
    return false;
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.accountSid}/Messages.json`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(
          `${config.twilio.accountSid}:${config.twilio.authToken}`
        ).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: to,
        From: config.twilio.fromNumber,
        Body: message,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log.error(`Twilio SMS failed to ${to}: ${errorText}`);
      return false;
    }

    log.info(`SMS alert sent to ${to}`);
    return true;
  } catch (error) {
    log.error(`Failed to send SMS to ${to}`, error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Send an alert to all configured phone numbers */
export async function sendAlert(
  type: 'error' | 'warning' | 'info',
  message: string
): Promise<void> {
  const prefix = type === 'error' ? '[ERROR]'
    : type === 'warning' ? '[WARN]'
    : '[INFO]';

  const fullMessage = `OC Lis Pendens Scraper ${prefix}\n${message}\n\nTime: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`;

  log.info(`Sending ${type} alert to ${config.alertPhoneNumbers.length} number(s)`);

  for (const phone of config.alertPhoneNumbers) {
    await sendSms(phone, fullMessage);
  }
}

/** Send a specific alert for scraper failures */
export async function alertOnFailure(error: string, consecutiveFailures: number): Promise<void> {
  // Only alert after 3 consecutive failures to avoid noise
  if (consecutiveFailures < 3) {
    log.info(`Run failed (${consecutiveFailures} consecutive), not alerting yet (threshold: 3)`);
    return;
  }

  await sendAlert(
    'error',
    `Scraper has failed ${consecutiveFailures} times in a row.\n` +
    `Last error: ${error}\n\n` +
    `Action needed: Check Railway logs or run manually to debug.`
  );
}

/** Send a summary after a successful run */
export async function alertOnSuccess(
  newFilings: number,
  totalScraped: number
): Promise<void> {
  // Only send success alerts if there are new filings (avoid spam)
  if (newFilings === 0) return;

  await sendAlert(
    'info',
    `Found ${newFilings} new Lis Pendens filing(s) today.\n` +
    `Total scraped: ${totalScraped}\n` +
    `Leads have been pushed to your CRM.`
  );
}
