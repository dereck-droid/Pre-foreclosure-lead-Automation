# Receive Tracerfy Data — n8n Workflow Documentation

## What This Workflow Does

This is the **second workflow** in the pre-foreclosure lead pipeline. It runs as a separate n8n workflow from the FL Parcel Address Lookup workflow.

When Tracerfy finishes processing a skip trace batch, it sends a webhook callback to this workflow. The workflow then:

1. **Fetches** the completed skip trace results from the Tracerfy API
2. **Extracts** phone numbers, emails, and mailing addresses
3. **Updates** the corresponding rows in the Google Sheet (matched by `Match Key`)
4. **Sends email notifications** to the client with the new lead details
5. **Cleans up** any rows that still have "Pending" skip trace status (moves them to a "Not Traced" tab)

## Prerequisites

- The **FL Parcel Address Lookup** workflow has already run and populated the Google Sheet with leads (Skip Trace Status = "Pending")
- Tracerfy webhook is configured to POST to this workflow's webhook URL
- n8n credentials configured:
  - **Google Sheets OAuth2** (same spreadsheet as the FL Parcel workflow)
  - **Gmail OAuth2** (for lead notification emails)

## Workflow Flow

```
[Webhook] → [Fetch Tracerfy Results] → [Extract Contact Info]
    → [Update Google Sheet rows] → [Send Email Notifications]
    → [Wait 7s] → [Loop: Clean Up Pending Rows]
        → [Find Pending rows] → [Limit 1]
        → [Copy to "Not Traced" tab] → [Delete from main sheet]
        → [Wait 2s] → [Loop back]
```

---

## Node-by-Node Reference

### Trigger

#### "Webhook" (Webhook)
- **Type:** Webhook
- **Method:** POST
- **Path:** `1f13bcd8-1a79-434c-ac08-661ca0b14a9b`
- **What it does:** Receives the callback from Tracerfy when a skip trace batch completes. The body contains a batch `id` field.
- **Connects TO:** Fetch Tracerfy Results

---

### Data Retrieval

#### "Fetch Tracerfy Results" (HTTP Request)
- **Type:** HTTP Request (GET)
- **URL:** `https://tracerfy.com/v1/api/queue/{{ $('Webhook').item.json.body.id }}`
- **Headers:** `Authorization: Bearer <token>`
- **What it does:** Retrieves the completed skip trace results using the batch ID from the webhook payload.
- **Connects TO:** Code in JavaScript

---

### Data Processing

#### "Code in JavaScript" (Code)
- **Type:** Code (JavaScript, Run Once for All Items)
- **What it does:** Extracts and deduplicates contact information from each Tracerfy result:
  - Collects all phone numbers: `primary_phone`, `mobile_1`-`mobile_5`, `landline_1`-`landline_3`
  - Deduplicates phones, takes the first two as `Phone 1` and `Phone 2`
  - Extracts `email_1` as `Email`
  - Builds `Mailing Address` from `mail_address`, `mail_city`, `mail_state`, `mail_zip`
  - Sets `Skip Trace Status` to "Traced" if any phone or email was found, otherwise "No Results"
  - Builds `Match Key` as `ADDRESS|FIRST_NAME|LAST_NAME` (uppercase) to match against the Google Sheet
- **Connects TO:** Update row in sheet

---

### Google Sheet Update

#### "Update row in sheet" (Google Sheets)
- **Type:** Google Sheets (Update)
- **Spreadsheet:** OC Lis Pendens Leads
- **Sheet:** Leads (gid=0)
- **Matching column:** `Match Key`
- **Columns updated:** Phone 1, Phone 2, Email, Mailing Address, Skip Trace Status
- **Connects TO:** Wait (7s) AND Get row(s) in sheet1 (parallel)

---

### Email Notifications

After updating the sheet, the workflow also sends email notifications with the new lead details.

#### "Get row(s) in sheet1" (Google Sheets)
- **Type:** Google Sheets (Read)
- **Spreadsheet:** OC Lis Pendens Leads
- **Sheet:** Leads (gid=0)
- **Filter:** `Match Key` = `{{ $json['Match Key'] }}`
- **What it does:** Reads the now-updated row (with phone/email populated) to get the full lead data for the email.
- **Connects TO:** Code in JavaScript1

#### "Code in JavaScript1" (Code)
- **Type:** Code (JavaScript, Run Once for All Items)
- **What it does:** Builds a plain-text email body summarizing all the new leads:
  ```
  You have X new lead(s) to review:

  --- Lead 1 of X ---
  Status: New
  Date: 02/04/2026
  Grantee: RIEHLE ANDREW
  Legal: Lot: 121 LEGACY
  Address: 5038 TUSCAN OAK DR, Orlando, FL, 32839
  Phone 1: (555) 123-4567
  Phone 2: N/A
  Notes: Lis Pendens
  ```
- **Connects TO:** Send a message, Send a message1 (parallel)

#### "Send a message" (Gmail)
- **Type:** Gmail
- **To:** `ben@equitypro.com`
- **Subject:** `New Leads (Orange County)`
- **Body:** `{{ $json.emailBody }}`

#### "Send a message1" (Gmail)
- **Type:** Gmail
- **To:** `jonathan@equitypro.com`
- **Subject:** `New Leads (Orange County)`
- **Body:** `{{ $json.emailBody }}`

---

### Cleanup Loop (Pending → Not Traced)

After Tracerfy results are processed, any leads still marked "Pending" in the Google Sheet need to be moved to the "Not Traced" tab. This happens in a loop that processes one row at a time with wait delays to avoid hitting Google Sheets rate limits.

#### "Wait" (Wait)
- **Type:** Wait (7 seconds)
- **Connects TO:** Loop Over Items

#### "Loop Over Items" (Split In Batches)
- **Type:** Split In Batches (default batch size)
- **Done output:** (workflow ends)
- **Loop output connects TO:** Get row(s) in sheet

#### "Get row(s) in sheet" (Google Sheets)
- **Type:** Google Sheets (Read, execute once)
- **Spreadsheet:** OC Lis Pendens Leads
- **Sheet:** Sheet1
- **Filter:** `Skip Trace Status` = `Pending`
- **What it does:** Finds the next row that still has "Pending" skip trace status.
- **Connects TO:** Limit

#### "Limit" (Limit)
- **Type:** Limit (1 item)
- **What it does:** Takes only the first pending row to process one at a time.
- **Connects TO:** Append row in sheet

#### "Append row in sheet" (Google Sheets)
- **Type:** Google Sheets (Append)
- **Spreadsheet:** OC Lis Pendens Leads
- **Sheet:** "Not Traced" tab (gid=1175198426)
- **Columns:** Lead Status, Date Found, Document Number, Grantee Name, Grantor Name, Legal Description, Property Address, Skip Trace Status ("No Results"), CRM Status, Notes, Match Key
- **What it does:** Copies the pending row to the "Not Traced" tab.
- **Connects TO:** Delete rows or columns from sheet

#### "Delete rows or columns from sheet" (Google Sheets)
- **Type:** Google Sheets (Delete)
- **Spreadsheet:** OC Lis Pendens Leads
- **Sheet:** Leads (gid=0)
- **Start Index:** `{{ $('Get row(s) in sheet').item.json.row_number }}`
- **What it does:** Removes the row from the main Leads sheet (it's now in "Not Traced").
- **Connects TO:** Wait1

#### "Wait1" (Wait)
- **Type:** Wait (2 seconds)
- **What it does:** Delay between iterations to avoid Google Sheets API rate limits.
- **Connects TO:** Loop Over Items (loops back)

---

## Google Sheet Tab Structure

| Tab | gid | Purpose |
|-----|-----|---------|
| Leads (Sheet1) | 0 | Active leads with skip trace data |
| No Address Found | 208846804 | Filings where no property address was found (written by FL Parcel workflow) |
| Not Traced | 1175198426 | Leads where Tracerfy returned no phone/email data |

## Webhook Setup

To configure Tracerfy to call this workflow:

1. In n8n, activate this workflow and copy the webhook URL (shown on the Webhook node as the "Production URL")
2. In your Tracerfy account settings, set the callback/webhook URL to this n8n webhook URL
3. When Tracerfy completes a batch, it will POST to this URL with the batch ID

## Relationship to FL Parcel Address Lookup

These two workflows work together:

1. **FL Parcel Address Lookup** runs on schedule → scrapes filings → looks up addresses → submits to Tracerfy → writes "Pending" rows to Google Sheet
2. **Receive Tracerfy Data** runs on webhook → receives Tracerfy results → updates Google Sheet with phone/email → sends notifications → cleans up untraced rows
