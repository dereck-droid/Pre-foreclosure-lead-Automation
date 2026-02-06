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
- **Connect FROM:** Nodes 4a, 4b, 8a, 8b (all successful match paths)
- **Connects TO:** Next step in your pipeline (Accurate Append, then GHL)

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
[manual]  [Accurate Append → GHL]
```

## Output Data Shape

After the merge, each item looks like:

```json
{
  "document_number": "20260071035",
  "document_type": "Lis Pendens",
  "recording_date": "02/05/2026",
  "grantor_name": "NEWREZ LLC",
  "grantee_name": "MAHURIN ESSIE B",
  "legal_description": "Lot: 9 Block: D PRIMROSE TERRACE",
  "primaryGrantee": "MAHURIN ESSIE B",
  "subdivisionName": "PRIMROSE TERRACE",
  "property_address": "2923 E MARKS ST",
  "property_city": "Orlando",
  "property_zip": 32803,
  "parcel_number": "192230725604090",
  "owner_name_on_parcel": "MAHURIN ESSIE B",
  "parcel_legal": "PRIMROSE TERRACE T/71 LOT 9 &",
  "lookup_status": "matched",
  "match_method": "exact_name"
}
```

## Adding New Counties

1. Find the county's CO_NO using the process in `memory/fl-parcel-api.md`
2. Add it to the `COUNTY_NUMBERS` object in Node 1 (Prep Query)
3. Make sure your scraper passes `county: "countyname"` in the filing data
