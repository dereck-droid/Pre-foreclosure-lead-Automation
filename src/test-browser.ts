/**
 * BROWSER TEST SCRIPT
 *
 * This is a simple test to verify that Playwright and Chrome are working.
 * It opens the Orange County Comptroller website and takes a screenshot.
 *
 * Usage: npm run test-browser
 *
 * What to expect:
 * - A Chrome window will open (you'll see it pop up)
 * - It navigates to the county website
 * - Takes a screenshot saved to the screenshots/ folder
 * - Closes the browser
 *
 * If this works, your environment is set up correctly.
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

async function testBrowser(): Promise<void> {
  console.log('');
  console.log('========================================');
  console.log('  BROWSER TEST');
  console.log('========================================');
  console.log('');
  console.log('Launching Chrome...');

  const browser = await chromium.launch({
    headless: false, // Always visible for this test
  });

  const page = await browser.newPage();

  console.log('Navigating to Orange County Comptroller website...');
  await page.goto('https://selfservice.or.occompt.com/ssweb/user/disclaimer', {
    waitUntil: 'networkidle',
    timeout: 30_000,
  });

  console.log('Page loaded! Taking screenshot...');

  const screenshotPath = path.join(PROJECT_ROOT, 'screenshots', `browser-test-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log(`Screenshot saved to: ${screenshotPath}`);
  console.log('');

  // Show some info about the page
  const title = await page.title();
  console.log(`Page title: "${title}"`);
  console.log(`Page URL:   ${page.url()}`);
  console.log('');

  // Wait 3 seconds so the user can see the browser
  console.log('Keeping browser open for 3 seconds so you can see it...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  await browser.close();

  console.log('Browser closed.');
  console.log('');
  console.log('========================================');
  console.log('  TEST PASSED - Your setup is working!');
  console.log('========================================');
  console.log('');
  console.log(`Check the screenshot at: ${screenshotPath}`);
  console.log('');
}

testBrowser().catch(error => {
  console.error('');
  console.error('========================================');
  console.error('  TEST FAILED');
  console.error('========================================');
  console.error('');
  console.error('Error:', error.message);
  console.error('');

  if (error.message.includes('Executable doesn\'t exist')) {
    console.error('Playwright browsers are not installed.');
    console.error('Run this command to install them:');
    console.error('');
    console.error('  npx playwright install chromium');
    console.error('');
  }

  process.exit(1);
});
