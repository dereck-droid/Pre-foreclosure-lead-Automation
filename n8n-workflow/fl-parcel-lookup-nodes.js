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
//   - Number of Inputs: 4
//   - Connect ALL outputs here:
//     - Input 0: Node 8b (single LIKE result)
//     - Input 1: Node 4b (single exact result)
//     - Input 2: Node 4a (matched from exact multiple — includes failures)
//     - Input 3: Node 8a (matched from LIKE multiple — includes failures)
//
// IMPORTANT: Both Node 4a and 8a output items even when matching fails
// (lookup_status = 'no_legal_match' or 'no_match_found'). These items
// have property_address = null. The Prep Contacts node below filters
// them out before they reach Tracerfy / Google Sheets.
//
// After this merge, every item has:
//   - All original scraper fields (document_number, grantee_name, etc.)
//   - property_address, property_city, property_zip (null if not found)
//   - parcel_number, owner_name_on_parcel
//   - lookup_status ('matched', 'no_match_found', 'no_legal_match')
//   - match_method ('exact_name', 'legal_description', 'like_single', etc.)
// =============================================================


// =============================================================
// NODE 10: "Prep Contacts" (Code Node)
// =============================================================
// Connected to: Node 9 (Merge All Paths)
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for All Items
//
// PURPOSE: Converts filings into individual contact records for
// skip tracing and CRM. Applies three critical filters:
//
//   1. SKIP contacts without a property address — these are filings
//      where the parcel lookup failed. Without an address, the lead
//      has no value (can't send mail, can't locate the property).
//
//   2. SKIP timeshare filings — legal descriptions starting with
//      "TS:" are timeshare/vacation ownership foreclosures (e.g.,
//      Marriott, Wyndham). These are not homeowners losing their
//      primary residence and are generally not useful leads.
//
//   3. SKIP corporate/government entities — LLCs, banks, HOAs,
//      county agencies, etc. Only individual people are leads.
//
// ALSO validates single-result exact matches: if the filing's
// subdivision name doesn't appear in the matched parcel's legal
// description, the match may be wrong (person owns a different
// property). These are flagged in the Notes column.
// =============================================================

const allContacts = [];

// Keywords that identify corporate/government entities
const CORP_KEYWORDS = [
  'LLC', 'INC', 'CORP', 'CORPORATION', 'ASSOCIATION', 'BANK', 'TRUST',
  'SECRETARY OF', 'DEPARTMENT OF', 'HOUSING AUTHORITY', 'FINANCE',
  'MORTGAGE', 'LENDING', 'SERVICES', 'HOLDINGS', 'PROPERTIES',
  'VENTURES', 'ENTERPRISES', 'GROUP', 'PARTNERS', 'FUND',
  'COUNTY', 'STATE OF', 'CITY OF', 'HOMEOWNERS', 'HOA',
  'PURCHASING', 'INVESTMENTS', 'NATIONAL', 'FEDERAL',
  'COMPANY', 'SAVINGS', 'PLAN'
];

// Known surname prefixes that should stay attached
const NAME_PREFIXES = ['DE', 'DEL', 'DELA', 'DI', 'VAN', 'VON', 'LA', 'LE', 'MC', 'ST'];

for (const item of $input.all()) {
  const data = item.json;

  // --- FILTER 1: Skip items without a matched address ---
  // Items with lookup_status != 'matched' have no usable address.
  // Items that went through legal description matching but failed
  // will have property_address = null and status like 'no_match_found'.
  if (!data.property_address || data.lookup_status !== 'matched') {
    continue;
  }

  // --- FILTER 2: Skip timeshare filings ---
  // Legal descriptions starting with "TS:" are timeshare interests
  // (vacation ownership, not primary residences).
  const legalDesc = (data.legal_description || '').trim();
  if (/^TS:/i.test(legalDesc)) {
    continue;
  }

  // --- VALIDATE: Check for possible wrong matches ---
  // When exact name query returned 1 result, it was auto-accepted.
  // Cross-check: does the parcel's legal description contain ANY
  // keywords from the filing's subdivision name?
  let matchWarning = '';
  if (data.match_method === 'exact_name' && data.total_results === 1) {
    const subdivisionName = (data.subdivisionName || '').toUpperCase();
    const parcelLegal = (data.parcel_legal || '').toUpperCase();
    const subKeywords = subdivisionName.split(/\s+/)
      .filter(w => w.length >= 4 && !/^\d+$/.test(w));
    if (subKeywords.length > 0) {
      const anyMatch = subKeywords.some(kw => parcelLegal.includes(kw));
      if (!anyMatch) {
        matchWarning = ' [ADDRESS UNVERIFIED - parcel legal desc does not match filing]';
      }
    }
  }

  const grantees = data.allGrantees || [];

  for (const name of grantees) {
    const upperName = name.toUpperCase().trim();

    // Skip corporate/government entities
    const isCorp = CORP_KEYWORDS.some(kw => upperName.includes(kw));
    if (isCorp) continue;

    // Skip empty names or single-word abbreviations
    if (!upperName || upperName.length < 2) continue;
    const parts = upperName.split(/\s+/).filter(Boolean);
    if (parts.length === 1) continue;

    // --- Name splitting logic ---
    // Property records use: LASTNAME FIRSTNAME MIDDLE_INITIAL
    let firstName = '';
    let lastName = '';

    if (parts.length >= 3 && NAME_PREFIXES.includes(parts[0])) {
      lastName = parts[0] + ' ' + parts[1];
      firstName = parts[2];
    } else if (parts.length === 2) {
      lastName = parts[0];
      firstName = parts[1];
    } else {
      lastName = parts[0];
      firstName = parts[1];
    }

    allContacts.push({
      json: {
        document_number: data.document_number || '',
        document_type: data.document_type || '',
        recording_date: data.recording_date || '',
        grantor_name: data.grantor_name || '',
        legal_description: data.legal_description || '',
        grantee_name: name,
        property_address: data.property_address || '',
        property_city: data.property_city || '',
        property_zip: data.property_zip ? String(data.property_zip) : '',
        first_name: firstName,
        last_name: lastName,
        property_state: 'FL',
        match_method: data.match_method || '',
        match_warning: matchWarning
      }
    });
  }
}

return allContacts;


// =============================================================
// NODE 11: "Bundle for Tracerfy" (Code Node)
// =============================================================
// Connected to: Node 10 (Prep Contacts)
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for All Items
//
// Bundles all contacts into the JSON format Tracerfy expects.
// =============================================================

const contacts = $input.all().map(item => item.json);

const records = contacts.map(c => ({
  address: c.property_address,
  city: c.property_city,
  state: c.property_state,
  zip: c.property_zip,
  first_name: c.first_name,
  last_name: c.last_name,
  mail_address: '',
  mail_city: '',
  mail_state: '',
  mail_zip: ''
}));

return [{
  json: {
    address_column: 'address',
    city_column: 'city',
    state_column: 'state',
    zip_column: 'zip',
    first_name_column: 'first_name',
    last_name_column: 'last_name',
    mail_address_column: 'mail_address',
    mail_city_column: 'mail_city',
    mail_state_column: 'mail_state',
    mailing_zip_column: 'mail_zip',
    trace_type: 'normal',
    json_data: JSON.stringify(records),
    original_contacts: contacts
  }
}];


// =============================================================
// NODE 12: "Format for Google Sheet" (Code Node)
// =============================================================
// Connected to: Node (after Tracerfy submit)
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for All Items
// =============================================================

const originalContacts = $('Bundle for Tracerfy').first().json.original_contacts;

const sheetRows = [];

for (const original of originalContacts) {
  const fullAddress = [
    original.property_address,
    original.property_city,
    'FL',
    original.property_zip
  ].filter(Boolean).join(', ');

  let notes = `${original.document_type}`;
  if (original.match_warning) {
    notes += original.match_warning;
  }

  sheetRows.push({
    json: {
      'Lead Status': 'New',
      'Date Found': original.recording_date,
      'Document Number': original.document_number,
      'Grantee Name': original.grantee_name,
      'Grantor Name': original.grantor_name,
      'Legal Description': original.legal_description,
      'Property Address': fullAddress,
      'Phone 1': '',
      'Phone 2': '',
      'Email': '',
      'Mailing Address': '',
      'Skip Trace Status': 'Pending',
      'CRM Status': '',
      'Notes': notes,
      'Date Added to CRM': '',
      'Match Key': original.property_address.toUpperCase() + '|' + original.first_name.toUpperCase() + '|' + original.last_name.toUpperCase()
    }
  });
}

return sheetRows;
