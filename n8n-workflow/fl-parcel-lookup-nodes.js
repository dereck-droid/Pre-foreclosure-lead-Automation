// =============================================================
// N8N WORKFLOW: FL Parcel Address Lookup — Code Node Reference
// =============================================================
//
// This file contains the JavaScript code for every Code node in
// the FL Parcel Address Lookup workflow. Copy each section into
// the corresponding n8n Code node.
//
// WORKFLOW OVERVIEW (full pipeline):
//
// SCHEDULING & SCRAPING:
//   [Schedule Trigger] → [Is Weekday?] → [8am-6pm ET?]
//     → [Scrape County Website] → [Filter] → [Split Out]
//
// ERROR BRANCH:
//   [Scrape error] → [LLM Chain] → [Gmail Alert]
//
// PARCEL LOOKUP:
//   [Prep Query] → [Exact Match HTTP] → [Normalize Results]
//     → [Route Results: 0/1/many]
//
//   0 results → [Detect Surname LLM] → [Prep LIKE Retry]
//     → [LIKE HTTP] → [Normalize LIKE] → [Route LIKE: 0/1/many]
//   1 result  → [Extract Single Result]
//   many      → [Match Legal Description]
//
//   LIKE 0 → [Flag No Match] → [Google Sheets: No Address Found]
//   LIKE 1 → [Extract Single LIKE Result]
//   LIKE many → [Match Legal LIKE]
//
// OUTPUT:
//   [Merge Matched] → [Prep Contacts] → [Bundle for Tracerfy]
//     → [Submit to Tracerfy] → [Format for Google Sheet]
//     → [Append to Google Sheets]
//
// =============================================================


// =============================================================
// NODE: "Prep Query" (Code Node)
// =============================================================
// Input: Individual filing from Split Out
// Output: Filing data + queryUrl for exact match + subdivisionName
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for Each Item
// =============================================================

const item = $input.item.json;

const allGrantees = (item.grantee_name || '').split('\n').map(n => n.trim()).filter(Boolean);
const primaryGrantee = allGrantees[0] || '';

let legalDesc = item.legal_description || '';
let subdivisionName = legalDesc
  .replace(/^Lot:\s*\S+\s*/i, '')
  .replace(/^Block:\s*\S+\s*/i, '')
  .replace(/^TS:\s*/i, '')
  .replace(/^REPLAT OF\s*/i, '')
  .trim();

const COUNTY_NUMBERS = {
  'orange': 58
};
const countyName = (item.county || 'orange').toLowerCase();
const countyNumber = COUNTY_NUMBERS[countyName];

if (!countyNumber) {
  return {
    json: {
      ...item,
      error: `Unknown county: ${countyName}. Add it to COUNTY_NUMBERS.`,
      property_address: null,
      lookup_status: 'error'
    }
  };
}

const baseUrl = 'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query';
const exactWhere = `CO_NO=${countyNumber}+AND+OWN_NAME='${primaryGrantee}'`;
const outFields = 'PARCELNO,OWN_NAME,PHY_ADDR1,PHY_CITY,PHY_ZIPCD,S_LEGAL';
const exactUrl = `${baseUrl}?where=${exactWhere}&outFields=${outFields}&returnGeometry=false&f=json`;

return {
  json: {
    ...item,
    primaryGrantee,
    allGrantees,
    subdivisionName,
    countyNumber,
    queryUrl: exactUrl,
    lookup_status: 'pending'
  }
};


// =============================================================
// NODE: "Normalize Results" (Code Node)
// Named "Code in JavaScript" in n8n
// =============================================================
// Placed between Exact Match Query and Route Results.
// Handles ArcGIS errors and carries forward prep data as _prepData.
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for Each Item
// =============================================================

const item = $input.item.json;
const prepData = $('Prep Query').item.json;

if (item.error || !item.features) {
  return {
    json: {
      ...item,
      features: [],
      primaryGrantee: prepData.primaryGrantee,
      subdivisionName: prepData.subdivisionName,
      countyNumber: prepData.countyNumber,
      _prepData: prepData
    }
  };
}

return {
  json: {
    ...item,
    primaryGrantee: prepData.primaryGrantee,
    subdivisionName: prepData.subdivisionName,
    countyNumber: prepData.countyNumber,
    _prepData: prepData
  }
};


// =============================================================
// NODE: "Extract Single Result" (Code Node)
// =============================================================
// Connected to: Route Results output 1 ("One Result")
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for Each Item
// =============================================================

const prepData = $input.item.json._prepData;
const feature = $input.item.json.features[0];
const addr = feature.attributes;

return {
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
};


// =============================================================
// NODE: "Match Legal Description" (Code Node)
// =============================================================
// Connected to: Route Results output 2 ("Multiple Results")
//
// Scores each parcel's S_LEGAL against the subdivision name using
// keyword matching with stop-words filtering and exact token matching.
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for Each Item
// =============================================================

const prepData = $input.item.json._prepData;
const features = $input.item.json.features || [];
const subdivisionName = prepData.subdivisionName.toUpperCase();

// --- STOP WORDS: common subdivision terms that match too broadly ---
const STOP_WORDS = new Set([
  'PHASE', 'UNIT', 'SECTION', 'ADDITION', 'REPLAT',
  'ESTATES', 'VILLAGE', 'LAKES', 'PARK', 'WOODS',
  'GARDENS', 'MANOR', 'TERRACE', 'HEIGHTS', 'HILLS',
  'ACRES', 'CONDO', 'CONDOMINIUM', 'TOWNHOMES', 'VILLAS',
  'NORTH', 'SOUTH', 'EAST', 'WEST', 'FIRST', 'SECOND',
  'TWO', 'THREE', 'FOUR', 'FIVE', 'ONE'
]);

// Build keyword list: min 4 chars, not numbers, not stop words
const allKeywords = subdivisionName
  .split(/\s+/)
  .filter(w => w.length >= 4 && !/^\d+$/.test(w));

const uniqueKeywords = allKeywords.filter(w => !STOP_WORDS.has(w));
const commonKeywords = allKeywords.filter(w => STOP_WORDS.has(w));

let bestMatch = null;
let bestScore = 0;
let bestUniqueScore = 0;

for (const feature of features) {
  // Tokenize S_LEGAL into words — filter out short tokens and numbers
  const sLegalWords = (feature.attributes.S_LEGAL || '').toUpperCase().split(/[\s\-\/,.()+]+/).filter(w => w.length >= 4 && !/^\d+$/.test(w));

  let uniqueScore = 0;
  let commonScore = 0;

  // Score unique keywords — EXACT match only to prevent VISTA matching VISTANA
  for (const keyword of uniqueKeywords) {
    if (sLegalWords.some(w => w === keyword)) {
      uniqueScore++;
    }
  }

  // Score common keywords — exact match
  for (const keyword of commonKeywords) {
    if (sLegalWords.some(w => w === keyword)) {
      commonScore++;
    }
  }

  const totalScore = uniqueScore + commonScore;

  // Prefer candidates with more unique keyword matches
  if (totalScore > bestScore || (totalScore === bestScore && uniqueScore > bestUniqueScore)) {
    bestScore = totalScore;
    bestUniqueScore = uniqueScore;
    bestMatch = feature;
  }
}

// --- THRESHOLD: require meaningful match ---
const totalKeywords = allKeywords.length;
const minRequired = Math.max(2, Math.ceil(totalKeywords * 0.4));
const isGoodMatch = bestMatch && bestUniqueScore >= 1 && bestScore >= Math.min(minRequired, 2);

if (isGoodMatch) {
  const addr = bestMatch.attributes;
  return {
    json: {
      ...prepData,
      property_address: addr.PHY_ADDR1 ? addr.PHY_ADDR1.trim() : '',
      property_city: addr.PHY_CITY ? addr.PHY_CITY.trim() : '',
      property_zip: addr.PHY_ZIPCD || '',
      parcel_number: addr.PARCELNO || '',
      owner_name_on_parcel: addr.OWN_NAME || '',
      parcel_legal: addr.S_LEGAL || '',
      match_score: bestScore,
      unique_score: bestUniqueScore,
      total_keywords: totalKeywords,
      unique_keywords: uniqueKeywords.length,
      total_results: features.length,
      lookup_status: 'matched',
      match_method: 'legal_description'
    }
  };
}

return {
  json: {
    ...prepData,
    property_address: null,
    total_results: features.length,
    best_score_found: bestScore,
    total_keywords: totalKeywords,
    lookup_status: 'no_legal_match',
    match_method: 'failed'
  }
};


// =============================================================
// NODE: "Detect Surname" (LLM Chain Node — NOT a Code node)
// =============================================================
// Connected to: Route Results output 0 ("No Results")
//
// n8n settings:
//   - Node type: Basic LLM Chain (@n8n/n8n-nodes-langchain.chainLlm)
//   - Language Model: OpenRouter Chat Model (openai/gpt-4o)
//   - Prompt Type: Define
//   - Text (user message): {{ $('Prep Query').item.json.primaryGrantee }}
//   - System Message:
//       "You are a name analysis tool for US property records. Given a
//        person's name, identify the SURNAME (family name / last name).
//        Rules:
//        - Property records usually list names as LASTNAME FIRSTNAME
//          MIDDLE (e.g., "SMITH JOHN A")
//        - Sometimes names are in FIRSTNAME LASTNAME order (e.g.,
//          "SHARNIQUE ALLEN")
//        - Common prefixes like DE, DEL, VAN, VON, MC, LA, LE, ST
//          are part of surnames (e.g., "DE OLIVEIRA" is one surname)
//        - Use your knowledge of common first names vs surnames to decide
//        Respond with ONLY the surname. Nothing else. No explanation."
//
// Output: $json.text contains the detected surname
// =============================================================


// =============================================================
// NODE: "Prep LIKE Retry" (Code Node)
// =============================================================
// Connected to: Detect Surname output
//
// Uses the LLM-detected surname to build a fuzzy LIKE query.
// Falls back to first name token if LLM returned empty.
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for Each Item
// =============================================================

const prepData = $('Prep Query').item.json;
const primaryGrantee = prepData.primaryGrantee;
const detectedSurname = $('Detect Surname').item.json.text.trim().toUpperCase();

const PREFIXES_TO_STRIP = ['DE', 'DEL', 'DELA', 'DI', 'VAN', 'VON', 'LA', 'LE', 'MC', 'ST'];

const nameParts = primaryGrantee.split(/\s+/).filter(Boolean);

// --- Use the LLM-detected surname ---
let surname = detectedSurname || nameParts[0]; // fallback to first word if LLM returned empty

// --- Build query ---
const baseUrl = 'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query';
const countyNumber = prepData.countyNumber;
const outFields = 'PARCELNO,OWN_NAME,PHY_ADDR1,PHY_CITY,PHY_ZIPCD,S_LEGAL';

// Collect other meaningful name parts (not the surname, not initials, not prefixes)
const otherParts = nameParts
  .filter(p => p.toUpperCase() !== surname.toUpperCase())
  .filter(p => !PREFIXES_TO_STRIP.includes(p.toUpperCase()))
  .filter(p => p.length >= 3)
  .filter(p => !/^[A-Z]\.?$/.test(p));

// Build WHERE clause
let whereClause;

if (otherParts.length > 0) {
  const orConditions = otherParts
    .map(part => `OWN_NAME+LIKE+'%25${part.toUpperCase()}%25'`)
    .join('+OR+');
  whereClause = `CO_NO=${countyNumber}+AND+OWN_NAME+LIKE+'%25${surname}%25'+AND+(${orConditions})`;
} else {
  whereClause = `CO_NO=${countyNumber}+AND+OWN_NAME+LIKE+'%25${surname}%25'`;
}

const likeUrl = `${baseUrl}?where=${whereClause}&outFields=${outFields}&resultRecordCount=500&returnGeometry=false&f=json`;

const broadWhere = `CO_NO=${countyNumber}+AND+OWN_NAME+LIKE+'%25${surname}%25'`;
const broadUrl = `${baseUrl}?where=${broadWhere}&outFields=${outFields}&resultRecordCount=500&returnGeometry=false&f=json`;

return {
  json: {
    ...prepData,
    retryingSurname: surname,
    otherNameParts: otherParts,
    queryUrl: likeUrl,
    broadQueryUrl: broadUrl,
    hasTightQuery: otherParts.length > 0,
    lookup_status: 'retrying_like'
  }
};


// =============================================================
// NODE: "Normalize LIKE Results" (Code Node)
// Named "Code in JavaScript1" in n8n
// =============================================================
// Placed between LIKE Query and Route LIKE Results.
// Handles ArcGIS errors.
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for Each Item
// =============================================================

const item = $input.item.json;

if (item.error || !item.features) {
  return {
    json: {
      ...item,
      features: []
    }
  };
}

return $input.item;


// =============================================================
// NODE: "Extract Single LIKE Result" (Code Node)
// =============================================================
// Connected to: Route LIKE Results output 1 ("One Result")
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for Each Item
// =============================================================

const prepData = $('Prep LIKE Retry').item.json;
const feature = $input.item.json.features[0];
const addr = feature.attributes;

return {
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
};


// =============================================================
// NODE: "Match Legal LIKE" (Code Node)
// =============================================================
// Connected to: Route LIKE Results output 2 ("Multiple Results")
//
// Same keyword scoring as Match Legal Description, PLUS owner
// name validation to filter out parcels belonging to different people.
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for Each Item
// =============================================================

const prepData = $('Prep LIKE Retry').item.json;
const features = $input.item.json.features || [];
const subdivisionName = prepData.subdivisionName.toUpperCase();

// --- OWNER NAME VALIDATION ---
const primaryGrantee = prepData.primaryGrantee.toUpperCase();
const granteeParts = primaryGrantee.split(/\s+/).filter(w => w.length >= 2);
const retryingSurname = (prepData.retryingSurname || '').toUpperCase();

function ownerNameMatches(ownName) {
  const upper = (ownName || '').toUpperCase();
  const ownerParts = upper.split(/[\s,]+/).filter(w => w.length >= 2);

  for (const part of granteeParts) {
    if (ownerParts.some(op => op === part)) {
      return true;
    }
  }

  if (retryingSurname && ownerParts.some(op => op === retryingSurname)) {
    return true;
  }

  return false;
}

// Filter features to only those with matching owner names
const validFeatures = features.filter(f => ownerNameMatches(f.attributes.OWN_NAME));

// --- STOP WORDS ---
const STOP_WORDS = new Set([
  'PHASE', 'UNIT', 'SECTION', 'ADDITION', 'REPLAT',
  'ESTATES', 'VILLAGE', 'LAKES', 'PARK', 'WOODS',
  'GARDENS', 'MANOR', 'TERRACE', 'HEIGHTS', 'HILLS',
  'ACRES', 'CONDO', 'CONDOMINIUM', 'TOWNHOMES', 'VILLAS',
  'NORTH', 'SOUTH', 'EAST', 'WEST', 'FIRST', 'SECOND',
  'TWO', 'THREE', 'FOUR', 'FIVE', 'ONE'
]);

// Build keyword list: min 4 chars, not numbers, not stop words
const allKeywords = subdivisionName
  .split(/\s+/)
  .filter(w => w.length >= 4 && !/^\d+$/.test(w));

const uniqueKeywords = allKeywords.filter(w => !STOP_WORDS.has(w));
const commonKeywords = allKeywords.filter(w => STOP_WORDS.has(w));

let bestMatch = null;
let bestScore = 0;
let bestUniqueScore = 0;

for (const feature of validFeatures) {
  // Tokenize S_LEGAL into words — filter out short tokens and numbers
  const sLegalWords = (feature.attributes.S_LEGAL || '').toUpperCase().split(/[\s\-\/,.()+]+/).filter(w => w.length >= 4 && !/^\d+$/.test(w));

  let uniqueScore = 0;
  let commonScore = 0;

  // Score unique keywords — EXACT match only to prevent VISTA matching VISTANA
  for (const keyword of uniqueKeywords) {
    if (sLegalWords.some(w => w === keyword)) {
      uniqueScore++;
    }
  }

  // Score common keywords — exact match
  for (const keyword of commonKeywords) {
    if (sLegalWords.some(w => w === keyword)) {
      commonScore++;
    }
  }

  const totalScore = uniqueScore + commonScore;

  if (totalScore > bestScore || (totalScore === bestScore && uniqueScore > bestUniqueScore)) {
    bestScore = totalScore;
    bestUniqueScore = uniqueScore;
    bestMatch = feature;
  }
}

// --- THRESHOLD ---
const totalKeywords = allKeywords.length;
const minRequired = Math.max(2, Math.ceil(totalKeywords * 0.4));
const isGoodMatch = bestMatch && bestUniqueScore >= 1 && bestScore >= Math.min(minRequired, 2);

if (isGoodMatch) {
  const addr = bestMatch.attributes;
  return {
    json: {
      ...prepData,
      property_address: addr.PHY_ADDR1 ? addr.PHY_ADDR1.trim() : '',
      property_city: addr.PHY_CITY ? addr.PHY_CITY.trim() : '',
      property_zip: addr.PHY_ZIPCD || '',
      parcel_number: addr.PARCELNO || '',
      owner_name_on_parcel: addr.OWN_NAME || '',
      parcel_legal: addr.S_LEGAL || '',
      match_score: bestScore,
      unique_score: bestUniqueScore,
      total_keywords: totalKeywords,
      unique_keywords: uniqueKeywords.length,
      candidates_after_name_filter: validFeatures.length,
      total_results: features.length,
      lookup_status: 'matched',
      match_method: 'like_legal_description'
    }
  };
}

return {
  json: {
    ...prepData,
    property_address: null,
    total_results: features.length,
    candidates_after_name_filter: validFeatures.length,
    best_score_found: bestScore,
    total_keywords: totalKeywords,
    lookup_status: 'no_match_found',
    match_method: 'failed'
  }
};


// =============================================================
// NODE: "Flag No Match" (Code Node)
// =============================================================
// Connected to: Route LIKE Results output 0 ("No Results")
// Connects TO: Google Sheets "No Address Found" tab
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for Each Item
// =============================================================

let prepData;
try {
  prepData = $('Prep LIKE Retry').item.json;
} catch (e) {
  prepData = $('Prep Query').item.json;
}

return {
  json: {
    ...prepData,
    property_address: null,
    property_city: null,
    property_zip: null,
    parcel_number: null,
    lookup_status: 'not_found',
    match_method: 'exhausted'
  }
};


// =============================================================
// NODE: "Prep Contacts" (Code Node)
// =============================================================
// Connected to: Merge Matched output
// Connects TO: Bundle for Tracerfy
//
// Transforms matched filings into individual contact records.
// Filters out corporations, timeshares, and single-name entities.
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for All Items
// =============================================================

const allContacts = [];

const CORP_KEYWORDS = [
  'LLC', 'INC', 'CORP', 'CORPORATION', 'ASSOCIATION', 'BANK', 'TRUST',
  'SECRETARY OF', 'DEPARTMENT OF', 'HOUSING AUTHORITY', 'FINANCE',
  'MORTGAGE', 'LENDING', 'SERVICES', 'HOLDINGS', 'PROPERTIES',
  'VENTURES', 'ENTERPRISES', 'GROUP', 'PARTNERS', 'FUND',
  'COUNTY', 'STATE OF', 'CITY OF', 'HOMEOWNERS', 'HOA',
  'PURCHASING', 'INVESTMENTS', 'NATIONAL', 'FEDERAL',
  'COMPANY', 'SAVINGS', 'PLAN'
];

const NAME_PREFIXES = ['DE', 'DEL', 'DELA', 'DI', 'VAN', 'VON', 'LA', 'LE', 'MC', 'ST'];

for (const item of $input.all()) {
  const data = item.json;

  // FILTER 1: Skip items without a matched address
  if (!data.property_address || data.lookup_status !== 'matched') {
    continue;
  }

  // FILTER 2: Skip timeshare filings
  const legalDesc = (data.legal_description || '').trim();
  if (/^TS:/i.test(legalDesc)) {
    continue;
  }

  // VALIDATE: Check for possible wrong single-result matches
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
    const isCorp = CORP_KEYWORDS.some(kw => upperName.includes(kw));
    if (isCorp) continue;
    if (!upperName || upperName.length < 2) continue;
    const parts = upperName.split(/\s+/).filter(Boolean);
    if (parts.length === 1) continue;

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
// NODE: "Bundle for Tracerfy" (Code Node)
// =============================================================
// Connected to: Prep Contacts output
// Connects TO: Submit to Tracerfy (HTTP POST)
//
// Bundles all contacts into a single JSON payload for the
// Tracerfy skip trace API.
//
// n8n settings:
//   - Node type: Code
//   - Language: JavaScript
//   - Mode: Run Once for All Items
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
// NODE: "Format for Google Sheet" (Code Node)
// =============================================================
// Connected to: Submit to Tracerfy output
// Connects TO: Append row in sheet (Google Sheets)
//
// Formats each contact as a row for the Google Sheet.
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
