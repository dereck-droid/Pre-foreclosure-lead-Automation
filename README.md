# Orange County Lis Pendens Scraper

Automatically scrapes new Lis Pendens filings from the Orange County Comptroller's
website, enriches them with phone numbers and emails via skip tracing, and pushes
the leads into your CRM.

---

## How It Works (Plain English)

Every time it runs, the scraper:

1. **Opens a browser** and goes to the Orange County Comptroller's website
2. **Solves the CAPTCHA** using a paid service (2Captcha — costs ~$0.003 per solve)
3. **Searches for "Lis Pendens"** filings recorded today
4. **Scrapes the results** from the table
5. **Checks its database** — skips any filings it already found on a previous run
6. **Looks up phone numbers and emails** for new filings using Tracerfy ($0.02 per lookup)
7. **Sends the enriched leads** to your CRM (GoHighLevel or any webhook)
8. **Sends you a text message** if anything goes wrong

---

## Setup Guide (Step by Step)

### Step 1: Open Terminal

On your Mac, open **Terminal**. You can find it by:
- Pressing `Cmd + Space`, typing "Terminal", and pressing Enter

You should see a window with a blinking cursor.

### Step 2: Navigate to the project

If you cloned this repo from GitHub, navigate to where you put it. For example:

```bash
cd ~/Pre-foreclosure-lead-Automation
```

If you're not sure where it is, you can check your Desktop or Documents:
```bash
ls ~/Desktop/Pre-foreclosure-lead-Automation
ls ~/Documents/Pre-foreclosure-lead-Automation
```

### Step 3: Install dependencies

Run this command (copy and paste the whole thing, then press Enter):

```bash
npm install
```

This will download all the libraries the project needs. It may take 1-2 minutes.
You'll see a progress bar and then a summary when it's done.

**If you see errors about `node-gyp` or `better-sqlite3`:**
Run this first, then try `npm install` again:
```bash
xcode-select --install
```
(This installs Apple's developer tools needed to compile the database library.)

### Step 4: Install the browser

The scraper uses Playwright to control a Chrome browser. Install it with:

```bash
npx playwright install chromium
```

This downloads a version of Chrome that Playwright can control. It's about 150MB.

### Step 5: Test that the browser works

Run the browser test:

```bash
npm run test-browser
```

**What you should see:**
- A Chrome window pops up
- It loads the Orange County Comptroller website
- The window closes after a few seconds
- The terminal says "TEST PASSED"

If it says "TEST PASSED" — your environment is ready. Move to Step 6.

If it fails, copy the error message and bring it back to me.

### Step 6: Create your configuration file

```bash
cp .env.example .env
```

This creates a file called `.env` where you'll put your API keys.

Now open it in a text editor:
```bash
open -a TextEdit .env
```

Or if you have VS Code:
```bash
code .env
```

### Step 7: Sign up for services and add API keys

You need accounts with these services. Edit your `.env` file and fill in each key.

**2Captcha (solves the CAPTCHA on the county website):**
1. Go to https://2captcha.com
2. Create an account
3. Add $3 to your balance (this is enough for ~1,000 CAPTCHAs)
4. Your API key is on the main dashboard page after you log in
5. Paste it into `.env` as: `TWOCAPTCHA_API_KEY=your_key_here`

**Tracerfy (finds phone numbers and emails):**
1. Go to https://www.tracerfy.com
2. Create an account
3. Your API key is in your account settings
4. Paste it into `.env` as: `TRACERFY_API_KEY=your_key_here`

**CRM (where leads get sent):**
- If Ben gives you a **webhook URL**, set:
  ```
  CRM_MODE=webhook
  CRM_WEBHOOK_URL=https://whatever-url-ben-gives-you
  ```
- If Ben uses **GoHighLevel**, set:
  ```
  CRM_MODE=gohighlevel
  GHL_API_KEY=his_api_key
  GHL_LOCATION_ID=his_location_id
  ```

**Twilio (optional — for text message alerts):**
1. Go to https://www.twilio.com
2. Create an account (they give you free trial credits)
3. Get a phone number from them
4. Fill in the TWILIO fields in `.env`
5. Add phone numbers to receive alerts in `ALERT_PHONE_NUMBERS`

### Step 8: Inspect the county website (REQUIRED)

**This is the most important step.** The scraper needs to know exactly which
buttons and fields to click on the county website. See the separate guide:

**[SITE_INSPECTION_GUIDE.md](./SITE_INSPECTION_GUIDE.md)**

Follow that guide, then come back here.

### Step 9: Run it!

Once you've completed the site inspection and updated the selectors:

```bash
npm start
```

Watch the terminal output. It will log every step as it goes.

**First run with HEADLESS=false (the default):**
- You'll see the browser open
- Watch it navigate the site, fill the form, and scrape results
- Check the terminal for any errors

### Step 10: Run on a schedule (production)

When everything works and you want it to run automatically:

1. Set `HEADLESS=true` in your `.env` file
2. Run the scheduler:
   ```bash
   npm run schedule
   ```
3. Leave the terminal window open (or deploy to a server — see Deployment below)

---

## Project Structure

```
├── .env                  ← Your API keys (never share this file!)
├── .env.example          ← Template showing what keys you need
├── package.json          ← Project dependencies
├── src/
│   ├── index.ts          ← Main script (runs once)
│   ├── scheduler.ts      ← Runs the scraper on a cron schedule
│   ├── test-browser.ts   ← Simple test to verify browser works
│   ├── config.ts         ← Loads your .env settings
│   ├── scraper.ts        ← Browser automation (navigates the county site)
│   ├── captcha.ts        ← 2Captcha integration
│   ├── skip-trace.ts     ← Tracerfy integration
│   ├── crm.ts            ← CRM push (webhook or GoHighLevel)
│   ├── notifications.ts  ← SMS alerts via Twilio
│   ├── database.ts       ← SQLite database for dedup & history
│   └── logger.ts         ← Logging utility
├── data/                 ← Database files (auto-created)
├── screenshots/          ← Screenshots from each run
├── errors/               ← Screenshots when something goes wrong
└── SITE_INSPECTION_GUIDE.md  ← How to get CSS selectors
```

---

## Common Commands

| Command | What it does |
|---------|-------------|
| `npm start` | Run the scraper once (for testing) |
| `npm run schedule` | Run on a cron schedule (for production) |
| `npm run test-browser` | Test that Chrome/Playwright works |
| `npm run db:reset` | Delete the database and start fresh |

---

## Troubleshooting

### "Cannot find module" error
Run `npm install` again. A dependency may not have installed correctly.

### Browser test fails
Run `npx playwright install chromium` to reinstall the browser.

### CAPTCHA keeps failing
- Check your 2Captcha balance at https://2captcha.com
- Make sure your API key is correct in `.env`

### No results found
- The county may not have posted filings yet today
- Try changing the date range in the search
- Check if the website layout has changed (selectors may need updating)

### CRM not receiving leads
- Double-check the webhook URL or GHL API key
- Look at the terminal output for error messages
- Try the webhook URL manually in your browser or with n8n

---

## Deployment (Later)

For now, run it from your Mac. When you're ready to deploy to a server
so it runs 24/7 without your laptop being open, we'll set up either:

- **Railway** (easy, cloud-based)
- **DigitalOcean** (more control, $6/month)
- **Your own server** (if you have one)

We can set that up together when you're ready.

---

## Costs

| Service | Cost | Notes |
|---------|------|-------|
| 2Captcha | ~$0.003/solve | ~$0.006-0.009/day at 2-3 runs |
| Tracerfy | ~$0.02/lookup | Only charged for NEW filings |
| Twilio | ~$0.0079/SMS | Only for error alerts |
| Railway | Free tier or $5/mo | For deployment |
| **Total** | **~$5-15/month** | Depends on filing volume |
