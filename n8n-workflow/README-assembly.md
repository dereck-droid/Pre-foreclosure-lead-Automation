# FL Parcel Address Lookup — n8n Workflow Assembly Guide

## What This Does
Takes lis pendens filings from the scraper (name + legal description) and looks up the **property street address** using Florida's free public parcel API. No API keys needed.

## Prerequisites
- Your scraper webhook is already sending filing data into n8n
- Each filing has: `grantee_name`, `legal_description`, and optionally `county` (defaults to "orange")

## Node-by-Node Setup

All JavaScript code is in `fl-parcel-lookup-nodes.js`. Copy each section into the corresponding n8n node.

---

### Node 1: "Prep Query" (Code)
- **Type:** Code
- **Language:** JavaScript
- **Mode:** Run Once for Each Item
- **Code:** Copy the `NODE 1` section from the JS file
- **Connects FROM:** Your scraper webhook or trigger node
- **Connects TO:** Node 2

**What it does:** Takes the scraper filing, extracts the primary grantee name and subdivision name, builds the API query URL.

---

### Node 2: "Exact Match Query" (HTTP Request)
- **Type:** HTTP Request
- **Method:** GET
- **URL:** `{{ $json.queryUrl }}`
- **Response Format:** JSON
- **Connects FROM:** Node 1
- **Connects TO:** Node 3

**What it does:** Calls the FL Parcel API searching for exact owner name match.

---

### Node 3: "Route Results" (Switch)
- **Type:** Switch
- **Mode:** Rules

| Output | Name | Condition |
|--------|------|-----------|
| 0 | No Results | `{{ $json.features.length }}` equals `0` |
| 1 | One Result | `{{ $json.features.length }}` equals `1` |
| 2 | Multiple Results | `{{ $json.features.length }}` is greater than `1` |

- **Connects FROM:** Node 2
- **Output 0 connects TO:** Node 5 (Prep LIKE Retry)
- **Output 1 connects TO:** Node 4b (Extract Single Result)
- **Output 2 connects TO:** Node 4a (Match Legal Description)

---

### Node 4a: "Match Legal Description" (Code)
- **Type:** Code
- **Language:** JavaScript
- **Mode:** Run Once for Each Item
- **Code:** Copy the `NODE 4a` section from the JS file
- **Connects FROM:** Node 3, Output 2
- **Connects TO:** Node 9 (Merge) — for matched items
- **Also connects TO:** Node 8c (Flag No Match) — for unmatched items

**What it does:** Scores each returned parcel by how well its S_LEGAL matches the subdivision name from the scraper. Picks the best match.

---

### Node 4b: "Extract Single Result" (Code)
- **Type:** Code
- **Language:** JavaScript
- **Mode:** Run Once for Each Item
- **Code:** Copy the `NODE 4b` section from the JS file
- **Connects FROM:** Node 3, Output 1
- **Connects TO:** Node 9 (Merge)

**What it does:** Simple extraction — one result found, grab the address.

---

### Node 5: "Prep LIKE Retry" (Code)
- **Type:** Code
- **Language:** JavaScript
- **Mode:** Run Once for Each Item
- **Code:** Copy the `NODE 5` section from the JS file
- **Connects FROM:** Node 3, Output 0
- **Connects TO:** Node 6

**What it does:** Exact name match failed. Extracts the core surname (strips prefixes like "DE", "VAN") and builds a LIKE query URL.

---

### Node 6: "LIKE Query" (HTTP Request)
- **Type:** HTTP Request
- **Method:** GET
- **URL:** `{{ $json.queryUrl }}`
- **Response Format:** JSON
- **Connects FROM:** Node 5
- **Connects TO:** Node 7

---

### Node 7: "Route LIKE Results" (Switch)
- **Type:** Switch
- **Mode:** Rules
- Same rules as Node 3 (check `features.length`)
- **Output 0 connects TO:** Node 8c (Flag No Match)
- **Output 1 connects TO:** Node 8b (Extract Single LIKE Result)
- **Output 2 connects TO:** Node 8a (Match Legal LIKE)

---

### Node 8a: "Match Legal LIKE" (Code)
- **Code:** Copy the `NODE 8a` section from the JS file
- Same as Node 4a but references `$('Prep LIKE Retry')` instead of `$('Prep Query')`
- **Connects TO:** Node 9 (Merge) for matches, Node 8c for no-match

### Node 8b: "Extract Single LIKE Result" (Code)
- **Code:** Copy the `NODE 8b` section from the JS file
- **Connects TO:** Node 9 (Merge)

### Node 8c: "Flag No Match" (Code)
- **Code:** Copy the `NODE 8c` section from the JS file
- **Connects TO:** Wherever you want unmatched items to go (Google Sheet, Slack, manual queue)

---

### Node 9: "Merge All Paths" (Merge)
- **Type:** Merge
- **Mode:** Append
- **Number of Inputs:** 4
- **Connect FROM:** Nodes 8b (input 0), 4b (input 1), 4a (input 2), 8a (input 3)
- **Connects TO:** Node 10 (Prep Contacts)

**Note:** Both Node 4a and 8a output items even when matching fails. Items with `lookup_status` of `no_legal_match` or `no_match_found` will have `property_address: null`. These are filtered out in Node 10.

---

### Node 10: "Prep Contacts" (Code)
- **Type:** Code
- **Language:** JavaScript
- **Mode:** Run Once for All Items
- **Code:** Copy the `NODE 10` section from the JS file
- **Connects FROM:** Node 9 (Merge)
- **Connects TO:** Node 11 (Bundle for Tracerfy)

**What it does:** Converts filings into individual contact records, applying three critical filters:
1. **Skips contacts without addresses** — filings where parcel lookup failed have no value without an address
2. **Skips timeshare filings** — legal descriptions starting with "TS:" are vacation ownership foreclosures (not homeowners losing their residence)
3. **Skips corporate/government entities** — LLCs, banks, HOAs, etc.

Also validates single-result exact matches: if the parcel's legal description doesn't contain keywords from the filing's subdivision name, the contact gets a warning flag in the Notes column (possible wrong address match).

---

### Node 11: "Bundle for Tracerfy" (Code)
- **Type:** Code
- **Language:** JavaScript
- **Mode:** Run Once for All Items
- **Code:** Copy the `NODE 11` section from the JS file
- **Connects FROM:** Node 10
- **Connects TO:** Submit to Tracerfy (HTTP Request)

---

### Node 12: "Format for Google Sheet" (Code)
- **Type:** Code
- **Language:** JavaScript
- **Mode:** Run Once for All Items
- **Code:** Copy the `NODE 12` section from the JS file
- **Connects FROM:** Submit to Tracerfy
- **Connects TO:** Append row in sheet (Google Sheets)

---

## Visual Workflow Map

```
[Scraper Webhook]
       |
  [1. Prep Query]
       |
  [2. Exact Match HTTP]
       |
  [3. Switch: 0/1/many]
    /     |      \
   0      1       2+
   |      |       |
[5.Prep] [4b.    [4a. Match
 LIKE]   Single]  Legal]
   |      |       |
[6.LIKE  |    matched?
 HTTP]   |    /      \
   |     | yes       no
[7.Switch]|   |       |
 / | \   |   |       |
0  1  2+ |   |       |
|  |  |  |   |       |
|[8b][8a]|   |       |
|  |  |  |   |       |
[8c]  \  |  /       /
 |     [9. Merge] --
 |         |
 |   [10. Prep Contacts]     ← filters out: no address,
 |         |                    timeshares, corporations
[dead   [11. Bundle for Tracerfy]
 end]      |
        [Submit to Tracerfy HTTP]
           |
        [12. Format for Google Sheet]
           |
        [Append to Google Sheet]
```

## Filtering Behavior

### What gets filtered OUT (and why)

| Filter | Example | Reason |
|--------|---------|--------|
| No address found | RAMGOBIN BALGRIM, SLOTHOWER SUSAN DIANE | Parcel lookup exhausted all methods. No property to locate. |
| Timeshare filing | WHITE JEFFREY CHARLES (TS: GRANDE VISTA) | Vacation ownership, not a primary residence. Grantor is usually Marriott, Wyndham, etc. |
| Corporate entity | D J GLOBAL HOLDING LLC | Not a person, not a lead. |
| Failed legal match | LIGGATT PETER A J | Found parcel records but couldn't match to the right property. |

### What gets flagged (but still included)

| Flag | Example | Reason |
|------|---------|--------|
| ADDRESS UNVERIFIED | MOMPLAISIR RUBIN | Single exact match, but parcel's legal description doesn't contain filing's subdivision name. May be a different property. |

## Output Data Shape

After Prep Contacts, each item looks like:

```json
{
  "document_number": "20260071035",
  "document_type": "Lis Pendens",
  "recording_date": "02/05/2026",
  "grantor_name": "NEWREZ LLC",
  "grantee_name": "MAHURIN ESSIE B",
  "legal_description": "Lot: 9 Block: D PRIMROSE TERRACE",
  "property_address": "2923 E MARKS ST",
  "property_city": "Orlando",
  "property_zip": "32803",
  "first_name": "ESSIE",
  "last_name": "MAHURIN",
  "property_state": "FL",
  "match_method": "exact_name",
  "match_warning": ""
}
```

## Adding New Counties

1. Find the county's CO_NO using the process in `memory/fl-parcel-api.md`
2. Add it to the `COUNTY_NUMBERS` object in Node 1 (Prep Query)
3. Make sure your scraper passes `county: "countyname"` in the filing data
