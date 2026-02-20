# FL Parcel Address Lookup — n8n Workflow Documentation

## What This Workflow Does

This is the **main orchestration workflow** that runs the entire pre-foreclosure lead pipeline end-to-end:

1. **Scrapes** new Lis Pendens filings from the Orange County Comptroller website on a schedule
2. **Looks up property addresses** using Florida's free public parcel API (ArcGIS)
3. **Skip-traces** matched leads via Tracerfy (phone, email, mailing address)
4. **Writes results** to a Google Sheet for review
5. **Sends error alerts** via Gmail when scraping fails

## Prerequisites

- The scraper server is deployed and accessible (currently at Railway production URL)
- n8n instance with the following credentials configured:
  - **OpenRouter API** (for GPT-4o surname detection)
  - **Gmail OAuth2** (for error alert emails)
  - **Google Sheets OAuth2** (for lead output)
  - **Tracerfy API** (bearer token for skip tracing)

## Workflow Phases

The workflow has four main phases:

1. **Scheduling & Scraping** — triggers on a schedule, gates by weekday/business hours, calls the scraper
2. **Parcel Lookup** — resolves property addresses from grantee names and legal descriptions
3. **Contact Processing** — filters corporate entities, formats contacts, submits to Tracerfy
4. **Output** — writes leads to Google Sheets

Plus an **Error Branch** for failed scrapes.

---

## Node-by-Node Reference

### Phase 1: Scheduling & Scraping

#### "Every 10 Minutes" (Schedule Trigger)
- **Type:** Schedule Trigger
- **Interval:** Every 10 minutes
- **Connects TO:** Is Weekday?

#### "Is Weekday?" (If)
- **Type:** If
- **Condition:** `{{ $now.weekday }}` is less than or equal to `5` (Monday=1 through Friday=5)
- **True output connects TO:** 8am-6pm ET?
- **False output:** stops (no weekend runs)

#### "8am-6pm ET?" (If)
- **Type:** If
- **Conditions (AND):**
  - `{{ $now.hour }}` >= `8`
  - `{{ $now.hour }}` <= `17`
- **True output connects TO:** Scrape County Website
- **False output:** stops (outside business hours)

#### "Scrape County Website" (HTTP Request)
- **Type:** HTTP Request
- **Method:** POST
- **URL:** `https://pre-foreclosure-lead-automation-production.up.railway.app/scrape`
- **Body:** `date` = `{{ $now.format('MM/dd/yyyy') }}`
- **Timeout:** 300,000ms (5 minutes)
- **On Error:** Continue on error output (routes to error branch)
- **Success output connects TO:** Filter
- **Error output connects TO:** Basic LLM Chain (error alert)

#### "Filter" (Filter)
- **Type:** Filter
- **Condition:** `{{ $json.new_filings.length }}` > `0`
- **Connects TO:** Split Out (only if there are new filings)

#### "Split Out" (Split Out)
- **Type:** Split Out
- **Field:** `new_filings`
- **Connects TO:** Prep Query

---

### Error Branch

When the scraper HTTP request fails, the error branch generates a human-readable email alert.

#### "Basic LLM Chain" (LLM Chain)
- **Type:** Basic LLM Chain (`@n8n/n8n-nodes-langchain.chainLlm`)
- **User Message:** `{{ $json.error }}`
- **System Message:** See [error-alert-llm-prompt.md](./error-alert-llm-prompt.md)
- **Language Model:** OpenRouter (default model)
- **Connects TO:** Send a message

#### "Send a message" (Gmail)
- **Type:** Gmail
- **To:** `Dereck@advancedLeadSolutions.com`
- **Subject:** `EquityPro Scrape FAILED`
- **Body:** `{{ $json.text }}` (LLM-generated error summary)

---

### Phase 2: Parcel Lookup

#### "Prep Query" (Code)
- **Type:** Code (JavaScript, Run Once for Each Item)
- **What it does:** Takes each filing, extracts the primary grantee name and subdivision name from the legal description, builds an exact-match ArcGIS query URL.
- **Key logic:**
  - Splits `grantee_name` by newlines, takes the first as `primaryGrantee`
  - Strips `Lot:`, `Block:`, `TS:`, `REPLAT OF` prefixes from `legal_description` to get `subdivisionName`
  - Uses `COUNTY_NUMBERS` map (currently only `orange: 58`)
  - Builds exact match URL: `OWN_NAME='<primaryGrantee>'`
- **Connects TO:** Exact Match Query

#### "Exact Match Query" (HTTP Request)
- **Type:** HTTP Request (GET)
- **URL:** `{{ $json.queryUrl }}`
- **Connects TO:** Normalize Results

#### "Normalize Results" (Code) — named "Code in JavaScript" in n8n
- **Type:** Code (JavaScript, Run Once for Each Item)
- **What it does:** Handles ArcGIS errors (replaces missing `features` with empty array) and carries forward all prep data as `_prepData` for downstream nodes.
- **Connects TO:** Route Results

#### "Route Results" (Switch)
- **Type:** Switch (3 rules)

| Output | Name | Condition |
|--------|------|-----------|
| 0 | No Results | `{{ $json.features.length }}` equals `0` |
| 1 | One Result | `{{ $json.features.length }}` equals `1` |
| 2 | Multiple Results | `{{ $json.features.length }}` > `1` |

- **Output 0 → Detect Surname** (fuzzy retry path)
- **Output 1 → Extract Single Result**
- **Output 2 → Match Legal Description**

---

### Exact Match Result Paths

#### "Extract Single Result" (Code)
- **Type:** Code (JavaScript, Run Once for Each Item)
- **What it does:** One parcel found — extracts address fields directly from `_prepData` and the single feature.
- **Output fields:** `property_address`, `property_city`, `property_zip`, `parcel_number`, `owner_name_on_parcel`, `parcel_legal`
- **Sets:** `match_method: 'exact_name'`
- **Connects TO:** Merge Matched (input 1)

#### "Match Legal Description" (Code)
- **Type:** Code (JavaScript, Run Once for Each Item)
- **What it does:** Multiple parcels found for the same owner name. Scores each parcel's `S_LEGAL` field against the subdivision name from the filing using keyword matching.
- **Key improvements over initial version:**
  - **Stop-words filtering:** Common subdivision terms (PHASE, UNIT, ESTATES, VILLAGE, etc.) are scored separately as "common" keywords
  - **Minimum 4-character words** to avoid noise
  - **Exact token matching** (not substring) to prevent "VISTA" matching "VISTANA"
  - **Dual scoring:** Tracks `uniqueScore` (distinctive words) and `commonScore` separately
  - **Quality threshold:** Requires `bestUniqueScore >= 1` AND `bestScore >= min(minRequired, 2)` where `minRequired = max(2, ceil(totalKeywords * 0.4))`
- **Sets:** `match_method: 'legal_description'`
- **Connects TO:** Merge Matched (input 2)

---

### Fuzzy/LIKE Retry Path

When the exact name match returns zero results, the workflow uses an LLM to detect the surname, then retries with a LIKE query.

#### "Detect Surname" (LLM Chain)
- **Type:** Basic LLM Chain (`@n8n/n8n-nodes-langchain.chainLlm`)
- **Language Model:** OpenRouter GPT-4o
- **User Message:** `{{ $('Prep Query').item.json.primaryGrantee }}`
- **System Message:** Instructs the LLM to identify the surname from a person's name, handling property-record name formats (LASTNAME FIRSTNAME MIDDLE), common prefixes (DE, VAN, MC, etc.), and ambiguous orderings. Responds with ONLY the surname.
- **Why LLM?** Property record names are inconsistent — sometimes `LASTNAME FIRSTNAME`, sometimes `FIRSTNAME LASTNAME`. Simple prefix-stripping fails on ambiguous names like "SHARNIQUE ALLEN" where "SHARNIQUE" looks like it could be a surname but is actually a first name.
- **Connects TO:** Prep LIKE Retry

#### "Prep LIKE Retry" (Code)
- **Type:** Code (JavaScript, Run Once for Each Item)
- **What it does:** Builds a LIKE query using the LLM-detected surname. Falls back to the first name token if the LLM returned empty.
- **Key logic:**
  - Uses the detected surname from `$('Detect Surname').item.json.text`
  - Builds a "tight" query: `OWN_NAME LIKE '%surname%' AND (OWN_NAME LIKE '%part1%' OR OWN_NAME LIKE '%part2%')` using other meaningful name parts (3+ chars, not initials, not prefixes)
  - Also builds a "broad" query (just surname) as `broadQueryUrl` fallback
  - Sets `resultRecordCount=500` (vs 20 in initial version)
- **Connects TO:** LIKE Query

#### "LIKE Query" (HTTP Request)
- **Type:** HTTP Request (GET)
- **URL:** `{{ $json.queryUrl }}`
- **Connects TO:** Normalize LIKE Results

#### "Normalize LIKE Results" (Code) — named "Code in JavaScript1" in n8n
- **Type:** Code (JavaScript, Run Once for Each Item)
- **What it does:** Handles ArcGIS errors, ensures `features` array exists.
- **Connects TO:** Route LIKE Results

#### "Route LIKE Results" (Switch)
- **Type:** Switch (3 rules, same structure as Route Results but with loose type validation)
- **Output 0 → Flag No Match**
- **Output 1 → Extract Single LIKE Result**
- **Output 2 → Match Legal LIKE**

---

### LIKE Result Paths

#### "Extract Single LIKE Result" (Code)
- **Type:** Code (JavaScript, Run Once for Each Item)
- **What it does:** One parcel found via LIKE — extracts address. References `$('Prep LIKE Retry')` for prep data.
- **Sets:** `match_method: 'like_single'`
- **Connects TO:** Merge Matched (input 0)

#### "Match Legal LIKE" (Code)
- **Type:** Code (JavaScript, Run Once for Each Item)
- **What it does:** Multiple parcels found via LIKE. Same keyword scoring as Match Legal Description, **plus owner name validation**.
- **Additional logic vs Match Legal Description:**
  - `ownerNameMatches()` function validates each parcel's `OWN_NAME` against the grantee name parts and the retrying surname
  - Filters features to only those with matching owner names BEFORE scoring
  - Reports `candidates_after_name_filter` in output
- **Sets:** `match_method: 'like_legal_description'`
- **Connects TO:** Merge Matched (input 3)

#### "Flag No Match" (Code)
- **Type:** Code (JavaScript, Run Once for Each Item)
- **What it does:** No parcel found after exhausting both exact and LIKE queries. Marks the filing with `lookup_status: 'not_found'`, `match_method: 'exhausted'`.
- **Connects TO:** Append row in sheet1 ("No Address Found" tab)

#### "Append row in sheet1" (Google Sheets)
- **Type:** Google Sheets (Append)
- **Sheet:** "No Address Found" tab in the OC Lis Pendens Leads spreadsheet
- **Columns:** Document Number, Date Found, Grantor Name, Grantee Name, Legal Description, Property Address, Skip Trace Status ("No Results"), CRM Status ("Not Sent"), Lead Status ("New")

---

### Phase 3: Contact Processing

#### "Merge Matched" (Merge)
- **Type:** Merge (Append mode)
- **Number of inputs:** 4
  - Input 0: Extract Single LIKE Result
  - Input 1: Extract Single Result
  - Input 2: Match Legal Description
  - Input 3: Match Legal LIKE
- **Connects TO:** Prep Contacts

#### "Prep Contacts" (Code)
- **Type:** Code (JavaScript, Run Once for All Items)
- **What it does:** Transforms matched filings into individual contact records. Key logic:
  - **Skips** items without a matched address (`lookup_status !== 'matched'`)
  - **Skips timeshare** filings (legal description starting with `TS:`)
  - **Filters corporate grantees** using a keyword list (LLC, INC, CORP, BANK, TRUST, MORTGAGE, HOA, etc.)
  - **Skips single-name grantees** (likely institutions)
  - **Splits names** into first/last (handles LASTNAME FIRSTNAME format and name prefixes)
  - **Adds address verification warning** for single-result exact matches where the parcel legal description doesn't contain any subdivision keywords
- **Output:** One item per individual grantee with: `first_name`, `last_name`, `property_address`, `property_city`, `property_zip`, `property_state` (FL), `document_number`, `recording_date`, `match_method`, `match_warning`
- **Connects TO:** Bundle for Tracerfy

#### "Bundle for Tracerfy" (Code)
- **Type:** Code (JavaScript, Run Once for All Items)
- **What it does:** Bundles all contacts into a single JSON payload matching Tracerfy's API format. Maps fields to column names (`address`, `city`, `state`, `zip`, `first_name`, `last_name`, `mail_address`, `mail_city`, `mail_state`, `mail_zip`). Preserves `original_contacts` for later use.
- **Connects TO:** Submit to Tracerfy

#### "Submit to Tracerfy" (HTTP Request)
- **Type:** HTTP Request (POST)
- **URL:** `https://tracerfy.com/v1/api/trace/`
- **Headers:** `Authorization: Bearer <token>`
- **Body:** multipart-form-data with column mappings and `json_data` (stringified records)
- **Connects TO:** Format for Google Sheet

---

### Phase 4: Output

#### "Format for Google Sheet" (Code)
- **Type:** Code (JavaScript, Run Once for All Items)
- **What it does:** Formats each contact as a Google Sheet row with these columns:
  - `Lead Status`: "New"
  - `Date Found`: recording date
  - `Document Number`, `Grantee Name`, `Grantor Name`, `Legal Description`
  - `Property Address`: full address (street, city, FL, zip)
  - `Notes`: document type + any match warnings
  - `Skip Trace Status`: "Pending"
  - `CRM Status`: "Not Sent"
  - `Match Key`: `ADDRESS|FIRST_NAME|LAST_NAME` (uppercase, used for Tracerfy callback matching)
- **Connects TO:** Append row in sheet

#### "Append row in sheet" (Google Sheets)
- **Type:** Google Sheets (Append)
- **Spreadsheet:** OC Lis Pendens Leads
- **Sheet:** Sheet1 (main leads tab)
- **Columns mapped:** Lead Status, Date Found, Document Number, Grantee Name, Grantor Name, Legal Description, Property Address, Skip Trace Status, Notes, CRM Status ("Not Sent"), Match Key

---

## Visual Workflow Map

```
[Every 10 Minutes]
       |
  [Is Weekday?]
    /        \
  true      false→(stop)
   |
[8am-6pm ET?]
  /        \
true      false→(stop)
  |
[Scrape County Website]
  /              \
success         error
  |                |
[Filter]       [Basic LLM Chain]
  |                |
[Split Out]    [Gmail Error Alert]
  |
[Prep Query]
  |
[Exact Match Query]
  |
[Normalize Results]
  |
[Route Results: 0 / 1 / many]
  |         |          |
  0         1          2+
  |         |          |
[Detect  [Extract   [Match Legal
Surname]  Single]    Description]
  |         |          |
[Prep       |          |
 LIKE       |          |
 Retry]     |          |
  |         |          |
[LIKE       |          |
 Query]     |          |
  |         |          |
[Normalize  |          |
 LIKE]      |          |
  |         |          |
[Route      |          |
 LIKE       |          |
 Results]   |          |
 / | \      |          |
0  1  2+    |          |
|  |   |    |          |
|  |   |    |          |
| [Extract [Match      |
|  Single   Legal      |
|  LIKE]    LIKE]      |
|  |        |          |
[Flag       |          |
 No Match]  |          |
  |         \    |    /
["No         \   |   /
Address       [Merge Matched]
Found"            |
sheet]        [Prep Contacts]
                  |
              [Bundle for Tracerfy]
                  |
              [Submit to Tracerfy]
                  |
              [Format for Google Sheet]
                  |
              [Append to Leads Sheet]
```

## Output Data Shape

After the merge and contact processing, each row written to Google Sheets looks like:

```json
{
  "Lead Status": "New",
  "Date Found": "02/04/2026",
  "Document Number": "20260068157",
  "Grantee Name": "RIEHLE ANDREW",
  "Grantor Name": "MORTGAGE RESEARCH CENTER LLC\nVETERANS UNITED HOME LOANS",
  "Legal Description": "Lot: 121 LEGACY",
  "Property Address": "5038 TUSCAN OAK DR, Orlando, FL, 32839",
  "Phone 1": "",
  "Phone 2": "",
  "Email": "",
  "Mailing Address": "",
  "Skip Trace Status": "Pending",
  "CRM Status": "Not Sent",
  "Notes": "Lis Pendens",
  "Match Key": "5038 TUSCAN OAK DR|RIEHLE|ANDREW"
}
```

Phone, Email, and Mailing Address are populated later by the **Receive Tracerfy Data** workflow when Tracerfy's callback fires.

## Match Methods

| Method | Description |
|--------|-------------|
| `exact_name` | Exact owner name match, single result |
| `legal_description` | Exact owner name match, multiple results, best legal description match |
| `like_single` | Fuzzy surname LIKE query, single result |
| `like_legal_description` | Fuzzy surname LIKE query, multiple results, best legal description match |
| `exhausted` | No match found after both exact and LIKE queries |

## Adding New Counties

1. Find the county's `CO_NO` from the FL Statewide Cadastral dataset
2. Add it to the `COUNTY_NUMBERS` object in the "Prep Query" code node
3. Make sure your scraper passes `county: "countyname"` in the filing data

## Google Sheet Structure

The workflow writes to the **OC Lis Pendens Leads** spreadsheet with these tabs:

| Tab | Purpose |
|-----|---------|
| Sheet1 (Leads) | Main leads — matched addresses with pending skip trace |
| No Address Found | Filings where no property address could be resolved |

Additional tabs managed by the **Receive Tracerfy Data** workflow:

| Tab | Purpose |
|-----|---------|
| Not Traced | Leads where Tracerfy returned no phone/email results |
