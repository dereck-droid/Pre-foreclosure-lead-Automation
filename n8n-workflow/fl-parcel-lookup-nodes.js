// =============================================================
// N8N WORKFLOW: FL Parcel Address Lookup
// =============================================================
//
// WORKFLOW OVERVIEW:
// 1. [Code] Prep Query        → builds exact-match API URL from grantee name
// 2. [HTTP Request] Exact     → calls FL Parcel API with exact name
// 3. [Switch] Route           → 0, 1, or multiple results
// 4a. [Code] Match Legal      → (multiple results path) picks best match
// 4b. [Code] Prep Retry       → (zero results path) builds LIKE query URL
// 5. [HTTP Request] LIKE      → calls FL Parcel API with LIKE surname
// 6. [Switch] Route LIKE      → 0, 1, or multiple results
// 7. [Code] Match Legal LIKE  → (multiple results path) picks best match
// 8. [Merge]                  → brings all paths together
//
// NODES ARE LISTED BELOW IN ORDER.
// Copy each JavaScript block into the corresponding n8n Code node.
// =============================================================


// =============================================================
// NODE 1: "Prep Query" (Code Node)
// =============================================================
// Input: scraper filing data (from webhook or previous node)
// Output: filing data + queryUrl for exact match + subdivisionName for later matching
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for Each Item
// =============================================================

const item = $input.item.json;

// --- Extract grantee name ---
// The grantee field can have multiple names separated by \n
// The first name is typically the actual homeowner
const allGrantees = item.grantee_name.split('\n').map(n => n.trim()).filter(Boolean);
const primaryGrantee = allGrantees[0]; // e.g., "MAHURIN ESSIE B"

// --- Extract subdivision name from legal description ---
// Patterns we've seen:
//   "Lot: 7 RIDGEMOORE PHASE ONE"
//   "Lot: 9 Block: D PRIMROSE TERRACE"
//   "Lot: 105 TEMPLE GROVE ESTATES PHASE 2"
//   "TS: VISTANA LAKES CONDOMINIUM"
//   "Lot: 3C REPLAT OF FAIRWAY TOWNHOMES AT MEADOW WOODS"
//   "Lot: 10 VISTA LAKES VILLAGE N 2 AMHURST"
let legalDesc = item.legal_description || '';
let subdivisionName = legalDesc
  // Remove "Lot: XX" prefix (handles numbers and letters like "3C")
  .replace(/^Lot:\s*\S+\s*/i, '')
  // Remove "Block: XX" prefix
  .replace(/^Block:\s*\S+\s*/i, '')
  // Remove "TS:" prefix (timeshare)
  .replace(/^TS:\s*/i, '')
  // Remove "REPLAT OF" prefix
  .replace(/^REPLAT OF\s*/i, '')
  .trim();

// --- Build the county number ---
// Add new counties here as they're onboarded
const COUNTY_NUMBERS = {
  'orange': 58,
  // 'osceola': ??,  // look up via PHY_CITY='KISSIMMEE' query
  // 'seminole': ??,  // look up via PHY_CITY='SANFORD' query
};
const countyName = (item.county || 'orange').toLowerCase();
const countyNumber = COUNTY_NUMBERS[countyName];

if (!countyNumber) {
  return [{
    json: {
      ...item,
      error: `Unknown county: ${countyName}. Add it to COUNTY_NUMBERS.`,
      property_address: null,
      lookup_status: 'error'
    }
  }];
}

// --- Build exact match query URL ---
const baseUrl = 'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query';
const exactWhere = `CO_NO=${countyNumber}+AND+OWN_NAME='${primaryGrantee}'`;
const outFields = 'PARCELNO,OWN_NAME,PHY_ADDR1,PHY_CITY,PHY_ZIPCD,S_LEGAL';
const exactUrl = `${baseUrl}?where=${exactWhere}&outFields=${outFields}&returnGeometry=false&f=json`;

return [{
  json: {
    ...item,
    primaryGrantee,
    allGrantees,
    subdivisionName,
    countyNumber,
    queryUrl: exactUrl,
    lookup_status: 'pending'
  }
}];


// =============================================================
// NODE 2: "Exact Match Query" (HTTP Request Node)
// =============================================================
// n8n settings:
//   - Node type: HTTP Request
//   - Method: GET
//   - URL: {{ $json.queryUrl }}
//   - Response Format: JSON
//   - Options > Full Response: OFF (we just want the body)
//
// This calls the FL Parcel API with the exact name match.
// The response will be in $json with a "features" array.
// =============================================================


// =============================================================
// NODE 3: "Route Results" (Switch Node)
// =============================================================
// n8n settings:
//   - Node type: Switch
//   - Mode: Rules
//   - Route incoming items based on: Number of features
//
//   Rule 1 (output 0) - "No Results":
//     Value: {{ $json.features.length }}
//     Operation: Equal
//     Compare to: 0
//
//   Rule 2 (output 1) - "One Result":
//     Value: {{ $json.features.length }}
//     Operation: Equal
//     Compare to: 1
//
//   Rule 3 (output 2) - "Multiple Results":
//     Value: {{ $json.features.length }}
//     Operation: Greater Than
//     Compare to: 1
//
// IMPORTANT: The Switch node will lose your original scraper data because
// the HTTP Request node replaces $json with the API response.
// To preserve it, you need to MERGE the data. Two options:
//
// OPTION A (recommended): Before the HTTP Request, use a "Set" node to
// store the prep data in a separate variable, then reference it later.
//
// OPTION B: Use an n8n expression to reference the Prep node directly:
//   {{ $('Prep Query').item.json.primaryGrantee }}
//
// We'll use Option B in the code nodes below.
// =============================================================


// =============================================================
// NODE 4a: "Match Legal Description" (Code Node)
// =============================================================
// Connected to: Switch output 2 ("Multiple Results")
// Also reused for the LIKE path (see Node 7)
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for Each Item
// =============================================================

// Get the original scraper data from the Prep node
const prepData = $('Prep Query').item.json;
const features = $input.item.json.features || [];
const subdivisionName = prepData.subdivisionName.toUpperCase();

// Extract keywords from the subdivision name (2+ chars, skip numbers)
const keywords = subdivisionName
  .split(/\s+/)
  .filter(w => w.length >= 2 && !/^\d+$/.test(w));

// Score each parcel by how many keywords match its S_LEGAL
let bestMatch = null;
let bestScore = 0;

for (const feature of features) {
  const sLegal = (feature.attributes.S_LEGAL || '').toUpperCase();
  let score = 0;
  for (const keyword of keywords) {
    if (sLegal.includes(keyword)) {
      score++;
    }
  }
  if (score > bestScore) {
    bestScore = score;
    bestMatch = feature;
  }
}

// Require at least 1 keyword match to consider it valid
if (bestMatch && bestScore >= 1) {
  const addr = bestMatch.attributes;
  return [{
    json: {
      ...prepData,
      property_address: addr.PHY_ADDR1 ? addr.PHY_ADDR1.trim() : '',
      property_city: addr.PHY_CITY ? addr.PHY_CITY.trim() : '',
      property_zip: addr.PHY_ZIPCD || '',
      parcel_number: addr.PARCELNO || '',
      owner_name_on_parcel: addr.OWN_NAME || '',
      parcel_legal: addr.S_LEGAL || '',
      match_score: bestScore,
      total_keywords: keywords.length,
      total_results: features.length,
      lookup_status: 'matched',
      match_method: 'legal_description'
    }
  }];
}

// No good match found
return [{
  json: {
    ...prepData,
    property_address: null,
    total_results: features.length,
    lookup_status: 'no_legal_match',
    match_method: 'failed'
  }
}];


// =============================================================
// NODE 4b: "Extract Single Result" (Code Node)
// =============================================================
// Connected to: Switch output 1 ("One Result")
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for Each Item
// =============================================================

const prepData = $('Prep Query').item.json;
const feature = $input.item.json.features[0];
const addr = feature.attributes;

return [{
  json: {
    ...prepData,
    property_address: addr.PHY_ADDR1 ? addr.PHY_ADDR1.trim() : '',
    property_city: addr.PHY_CITY ? addr.PHY_CITY.trim() : '',
    property_zip: addr.PHY_ZIPCD || '',
    parcel_number: addr.PARCELNO || '',
    owner_name_on_parcel: addr.OWN_NAME || '',
    parcel_legal: addr.S_LEGAL || '',
    match_score: null,
    total_results: 1,
    lookup_status: 'matched',
    match_method: 'exact_name'
  }
}];


// =============================================================
// NODE 5: "Prep LIKE Retry" (Code Node)
// =============================================================
// Connected to: Switch output 0 ("No Results")
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for Each Item
// =============================================================

const prepData = $('Prep Query').item.json;
const primaryGrantee = prepData.primaryGrantee;

// Common name prefixes that cause exact-match failures
const PREFIXES_TO_STRIP = ['DE', 'DEL', 'DELA', 'DI', 'VAN', 'VON', 'LA', 'LE', 'MC', 'ST'];

// Split the name into parts
const nameParts = primaryGrantee.split(/\s+/).filter(Boolean);

// Try to find the "real" surname by stripping common prefixes
// "DE OLIVEIRA ANDREA C" → strip "DE" → surname is "OLIVEIRA"
// "MAHURIN ESSIE B" → no prefix to strip → surname is "MAHURIN"
let surname = nameParts[0]; // default: first token
if (nameParts.length >= 2 && PREFIXES_TO_STRIP.includes(nameParts[0].toUpperCase())) {
  surname = nameParts[1]; // skip the prefix
}

// Build LIKE query URL
const baseUrl = 'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query';
const countyNumber = prepData.countyNumber;
const likeWhere = `CO_NO=${countyNumber}+AND+OWN_NAME+LIKE+'%25${surname}%25'`;
const outFields = 'PARCELNO,OWN_NAME,PHY_ADDR1,PHY_CITY,PHY_ZIPCD,S_LEGAL';
const likeUrl = `${baseUrl}?where=${likeWhere}&outFields=${outFields}&resultRecordCount=20&returnGeometry=false&f=json`;

return [{
  json: {
    ...prepData,
    retryingSurname: surname,
    queryUrl: likeUrl,
    lookup_status: 'retrying_like'
  }
}];


// =============================================================
// NODE 6: "LIKE Query" (HTTP Request Node)
// =============================================================
// n8n settings:
//   - Node type: HTTP Request
//   - Method: GET
//   - URL: {{ $json.queryUrl }}
//   - Response Format: JSON
// =============================================================


// =============================================================
// NODE 7: "Route LIKE Results" (Switch Node)
// =============================================================
// Same config as Node 3:
//   Rule 1 (output 0): features.length == 0 → "Still No Results"
//   Rule 2 (output 1): features.length == 1 → "One Result"
//   Rule 3 (output 2): features.length > 1  → "Multiple Results"
// =============================================================


// =============================================================
// NODE 8a: "Match Legal LIKE" (Code Node)
// =============================================================
// Connected to: Route LIKE Results output 2 ("Multiple Results")
// IDENTICAL to Node 4a — copy the same code.
// Just change the reference from $('Prep Query') to $('Prep LIKE Retry')
// so it picks up the correct upstream data.
// =============================================================

// Get the original scraper data from the Prep LIKE Retry node
const prepData = $('Prep LIKE Retry').item.json;
const features = $input.item.json.features || [];
const subdivisionName = prepData.subdivisionName.toUpperCase();

const keywords = subdivisionName
  .split(/\s+/)
  .filter(w => w.length >= 2 && !/^\d+$/.test(w));

let bestMatch = null;
let bestScore = 0;

for (const feature of features) {
  const sLegal = (feature.attributes.S_LEGAL || '').toUpperCase();
  let score = 0;
  for (const keyword of keywords) {
    if (sLegal.includes(keyword)) {
      score++;
    }
  }
  if (score > bestScore) {
    bestScore = score;
    bestMatch = feature;
  }
}

if (bestMatch && bestScore >= 1) {
  const addr = bestMatch.attributes;
  return [{
    json: {
      ...prepData,
      property_address: addr.PHY_ADDR1 ? addr.PHY_ADDR1.trim() : '',
      property_city: addr.PHY_CITY ? addr.PHY_CITY.trim() : '',
      property_zip: addr.PHY_ZIPCD || '',
      parcel_number: addr.PARCELNO || '',
      owner_name_on_parcel: addr.OWN_NAME || '',
      parcel_legal: addr.S_LEGAL || '',
      match_score: bestScore,
      total_keywords: keywords.length,
      total_results: features.length,
      lookup_status: 'matched',
      match_method: 'like_legal_description'
    }
  }];
}

return [{
  json: {
    ...prepData,
    property_address: null,
    total_results: features.length,
    lookup_status: 'no_match_found',
    match_method: 'failed'
  }
}];


// =============================================================
// NODE 8b: "Extract Single LIKE Result" (Code Node)
// =============================================================
// Connected to: Route LIKE Results output 1 ("One Result")
// =============================================================

const prepData = $('Prep LIKE Retry').item.json;
const feature = $input.item.json.features[0];
const addr = feature.attributes;

return [{
  json: {
    ...prepData,
    property_address: addr.PHY_ADDR1 ? addr.PHY_ADDR1.trim() : '',
    property_city: addr.PHY_CITY ? addr.PHY_CITY.trim() : '',
    property_zip: addr.PHY_ZIPCD || '',
    parcel_number: addr.PARCELNO || '',
    owner_name_on_parcel: addr.OWN_NAME || '',
    parcel_legal: addr.S_LEGAL || '',
    match_score: null,
    total_results: 1,
    lookup_status: 'matched',
    match_method: 'like_single'
  }
}];


// =============================================================
// NODE 8c: "Flag No Match" (Set Node or Code Node)
// =============================================================
// Connected to: Route LIKE Results output 0 ("Still No Results")
// Also connect the "no_legal_match" outputs from 4a and 8a here
//
// This is a dead end — we couldn't find the property.
// You can route these to a Google Sheet, Slack notification,
// or a manual review queue.
// =============================================================

const prepData = $('Prep LIKE Retry').item.json;

return [{
  json: {
    ...prepData,
    property_address: null,
    lookup_status: 'not_found',
    match_method: 'exhausted'
  }
}];


// =============================================================
// NODE 9: "Merge All Paths" (Merge Node)
// =============================================================
// n8n settings:
//   - Node type: Merge
//   - Mode: Append
//   - Connect ALL successful outputs here:
//     - Node 4a (matched from exact multiple)
//     - Node 4b (single exact result)
//     - Node 8a (matched from LIKE multiple)
//     - Node 8b (single LIKE result)
//
// After this merge, every item has:
//   - All original scraper fields (document_number, grantee_name, etc.)
//   - property_address, property_city, property_zip
//   - parcel_number, owner_name_on_parcel
//   - lookup_status ('matched' or 'not_found')
//   - match_method ('exact_name', 'legal_description', 'like_single', etc.)
//
// The next step would be Accurate Append for phone/email,
// then push to GHL.
// =============================================================
