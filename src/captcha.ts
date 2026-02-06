import { captcha as captchaConfig } from './config.js';
import { log } from './logger.js';

/**
 * Solves a reCAPTCHA v2 challenge using the 2Captcha service.
 *
 * How it works:
 * 1. We send the site key + page URL to 2Captcha
 * 2. A real human on their end solves the CAPTCHA
 * 3. We poll until they return a token (~20-60 seconds)
 * 4. We inject that token into the page so the form thinks we solved it
 */

interface CaptchaResult {
  success: boolean;
  token: string;
  costUsd: number;
  solveTimeMs: number;
}

/** Submit a reCAPTCHA to 2Captcha and wait for the solution */
export async function solveCaptcha(
  siteKey: string,
  pageUrl: string
): Promise<CaptchaResult> {
  if (!captchaConfig.apiKey) {
    throw new Error(
      'TWOCAPTCHA_API_KEY is not set. Add it to your .env file.\n' +
      'Sign up at https://2captcha.com and get your API key.'
    );
  }

  const startTime = Date.now();
  log.info('Submitting CAPTCHA to 2Captcha...', { siteKey: siteKey.substring(0, 20) + '...' });

  // Step 1: Submit the CAPTCHA
  const submitParams = new URLSearchParams({
    key: captchaConfig.apiKey,
    method: 'userrecaptcha',
    googlekey: siteKey,
    pageurl: pageUrl,
    json: '1',
  });

  const submitResponse = await fetch(`${captchaConfig.submitUrl}?${submitParams}`);
  const submitData = await submitResponse.json() as { status: number; request: string };

  if (submitData.status !== 1) {
    throw new Error(`2Captcha submit failed: ${submitData.request}`);
  }

  const captchaId = submitData.request;
  log.info('CAPTCHA submitted, waiting for solution...', { captchaId });

  // Step 2: Poll for the result
  const token = await pollForResult(captchaId);
  const solveTimeMs = Date.now() - startTime;

  log.success(`CAPTCHA solved in ${(solveTimeMs / 1000).toFixed(1)} seconds`);

  return {
    success: true,
    token,
    costUsd: 0.003, // Standard reCAPTCHA v2 rate
    solveTimeMs,
  };
}

/** Poll 2Captcha for the CAPTCHA solution */
async function pollForResult(captchaId: string): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < captchaConfig.maxWaitMs) {
    // Wait before polling
    await sleep(captchaConfig.pollIntervalMs);

    const resultParams = new URLSearchParams({
      key: captchaConfig.apiKey,
      action: 'get',
      id: captchaId,
      json: '1',
    });

    const response = await fetch(`${captchaConfig.resultUrl}?${resultParams}`);
    const data = await response.json() as { status: number; request: string };

    if (data.status === 1) {
      return data.request; // This is the solved token
    }

    if (data.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2Captcha error: ${data.request}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    log.info(`Still solving CAPTCHA... (${elapsed}s elapsed)`);
  }

  throw new Error(`CAPTCHA solve timed out after ${captchaConfig.maxWaitMs / 1000} seconds`);
}

/**
 * Inject a solved CAPTCHA token into the page.
 * Call this with the Playwright page object after solving.
 */
export function getCaptchaInjectionScript(token: string): string {
  return `
    // Set the reCAPTCHA response textarea
    const textarea = document.querySelector('#g-recaptcha-response')
      || document.querySelector('[name="g-recaptcha-response"]');
    if (textarea) {
      textarea.value = '${token}';
      textarea.style.display = 'block'; // Some forms hide it
    }

    // If there's a callback function registered, call it
    if (typeof ___grecaptcha_cfg !== 'undefined') {
      const clients = ___grecaptcha_cfg.clients;
      if (clients) {
        Object.keys(clients).forEach(key => {
          const client = clients[key];
          // Find the callback in the client configuration
          const findCallback = (obj) => {
            if (!obj || typeof obj !== 'object') return null;
            for (const k of Object.keys(obj)) {
              if (typeof obj[k] === 'function') return obj[k];
              if (typeof obj[k] === 'object') {
                const found = findCallback(obj[k]);
                if (found) return found;
              }
            }
            return null;
          };
          const callback = findCallback(client);
          if (callback) callback('${token}');
        });
      }
    }
  `;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
