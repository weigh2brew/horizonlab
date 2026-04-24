/**
 * Horizon Lab — Google Apps Script Backend
 *
 * This script reads/writes the same Google Sheet that horizonvote uses,
 * but via tabs it owns (serials / brews / stats). The existing horizonvote
 * key-value tab is untouched. Because this script opens the sheet by ID,
 * it can be a standalone Apps Script — it does NOT need to be container-
 * bound to the sheet.
 *
 * SETUP:
 * 1. In the shared Google Sheet, add three new tabs (leave the existing
 *    horizonvote tab alone):
 *    - "serials"  — Column A: serial, Column B: registered_token,
 *                   Column C: registered_at, Column D: ig_handle
 *    - "brews"    — timestamp | serial_hash | origin | process | roast |
 *                   brew_method | treatment_mins | rating | flavors | note
 *    - "stats"    — Column A: key, Column B: value (cache)
 *
 * 2. In "serials" tab Column A, paste the valid Horizon serial numbers
 *    from manufacturing. Leave columns B-D blank.
 *
 * 3. Create a new Apps Script project at script.google.com (standalone,
 *    not bound to the sheet). Paste this entire file in. Deploy as
 *    Web App with:
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    On first run, authorize the "See, edit, create, and delete..."
 *    scope so the script can read/write the sheet by ID.
 *
 * 4. Copy the deployment URL into app.js CONFIG.sheetUrl.
 */

// ---------- SHEET CONFIG ----------
// Shared with horizonvote. Find in the sheet URL:
//   https://docs.google.com/spreadsheets/d/<ID>/edit
const SHEET_ID = '17qM1uriZ4QgXbO0iwibxLO5LIw1f6Vit0h2X7ws7-Vs';
const SHEET_SERIALS = 'serials';
const SHEET_BREWS = 'brews';
const SHEET_STATS = 'stats';

function openSheet() {
  return SpreadsheetApp.openById(SHEET_ID);
}

// ---------- ROUTER ----------
function doGet(e) {
  const action = e.parameter.action;

  try {
    switch (action) {
      case 'verify':
        return jsonResponse(handleVerify(e.parameter));
      case 'read_aggregates':
        return jsonResponse(handleReadAggregates());
      case 'read_feed':
        return jsonResponse(handleReadFeed(e.parameter));
      default:
        return jsonResponse({ error: 'Unknown action' });
    }
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    if (payload.token) {
      return jsonResponse(handleSubmitBrew(payload));
    }
    return jsonResponse({ error: 'Missing token' });
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- VERIFY SERIAL ----------
// Horizon serial format: AHN101 + 2-letter year + 1-digit quarter (1-4) + 3-digit sequence
// Example: AHN101ED1001
const HORIZON_SERIAL = /^AHN101[A-Z]{2}[1-4]\d{3}$/;

// Single generic message — never reveal whether the failure was format
// vs. unknown serial, so callers can't probe the format from responses.
const VERIFY_FAIL = { success: false, error: 'Serial number not recognized. Please check and try again.' };

function handleVerify(params) {
  const serial = (params.serial || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!serial) return VERIFY_FAIL;
  if (!HORIZON_SERIAL.test(serial)) return VERIFY_FAIL;

  const ss = openSheet();
  const sheet = ss.getSheetByName(SHEET_SERIALS);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const rowSerial = String(data[i][0]).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (rowSerial === serial) {
      // Already registered? Return existing token.
      const existingToken = data[i][1];
      if (existingToken) {
        return { success: true, token: existingToken };
      }

      // First-time registration: generate token and save
      const token = Utilities.getUuid();
      sheet.getRange(i + 1, 2).setValue(token);                          // Column B: token
      sheet.getRange(i + 1, 3).setValue(new Date().toISOString());       // Column C: registered_at
      return { success: true, token: token };
    }
  }

  return VERIFY_FAIL;
}

// ---------- SUBMIT BREW ----------
function handleSubmitBrew(payload) {
  // Validate token
  const token = payload.token;
  if (!token) return { success: false, error: 'Missing token.' };

  const ss = openSheet();
  const serialSheet = ss.getSheetByName(SHEET_SERIALS);
  const serialData = serialSheet.getDataRange().getValues();
  let tokenValid = false;

  for (let i = 1; i < serialData.length; i++) {
    if (serialData[i][1] === token) {
      tokenValid = true;
      break;
    }
  }

  if (!tokenValid) return { success: false, error: 'Invalid token. Please re-verify.' };

  // Hash the serial for privacy (don't store raw serial in brew logs)
  const serialHash = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    payload.serial || ''
  ).map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('').slice(0, 12);

  // Validate & sanitize
  const origin = sanitize(payload.origin, 30);
  const process = sanitize(payload.process, 20);
  const roast = sanitize(payload.roast, 10);
  const brewMethod = sanitize(payload.brew_method, 20);
  const treatmentMins = Math.max(0.5, Math.min(60, parseFloat(payload.treatment_mins) || 5));
  const rating = Math.max(1, Math.min(5, parseInt(payload.rating) || 3));
  const flavors = sanitize(payload.flavors, 200);
  const note = sanitize(payload.note, 280);

  // Append to brews sheet
  const brewSheet = ss.getSheetByName(SHEET_BREWS);
  brewSheet.appendRow([
    new Date().toISOString(),  // timestamp
    serialHash,                // serial_hash (privacy)
    origin,
    process,
    roast,
    brewMethod,
    treatmentMins,
    rating,
    flavors,
    note,
  ]);

  // Invalidate stats cache
  clearStatsCache(ss);

  return { success: true };
}

function sanitize(str, maxLen) {
  if (!str) return '';
  return String(str).replace(/[<>"'&]/g, '').trim().slice(0, maxLen);
}

// ---------- READ AGGREGATES ----------
function handleReadAggregates() {
  const ss = openSheet();

  // Check cache (stats tab)
  const statsSheet = ss.getSheetByName(SHEET_STATS);
  if (statsSheet) {
    const cached = getCachedStats(statsSheet);
    if (cached) return cached;
  }

  // Compute fresh
  const brewSheet = ss.getSheetByName(SHEET_BREWS);
  const data = brewSheet.getDataRange().getValues();

  if (data.length <= 1) {
    return { total_brews: 0, total_owners: 0, avg_rating: 0, by_origin: {}, by_time: {}, by_method: {}, by_flavor: {} };
  }

  const byOrigin = {};
  const byTime = {};
  const byMethod = {};
  const byFlavor = {};
  const owners = new Set();
  let totalRating = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const serialHash = row[1];
    const origin = row[2];
    const brewMethod = row[5];
    const treatmentMins = parseFloat(row[6]) || 5;
    const rating = parseInt(row[7]) || 3;
    const flavors = String(row[8] || '');

    owners.add(serialHash);
    totalRating += rating;

    // By origin
    if (!byOrigin[origin]) byOrigin[origin] = { sum: 0, count: 0 };
    byOrigin[origin].sum += rating;
    byOrigin[origin].count++;

    // By time bucket
    const bucket = getTimeBucket(treatmentMins);
    if (!byTime[bucket]) byTime[bucket] = { sum: 0, count: 0 };
    byTime[bucket].sum += rating;
    byTime[bucket].count++;

    // By method
    if (!byMethod[brewMethod]) byMethod[brewMethod] = { sum: 0, count: 0 };
    byMethod[brewMethod].sum += rating;
    byMethod[brewMethod].count++;

    // By flavor
    flavors.split(',').forEach(f => {
      f = f.trim();
      if (f) byFlavor[f] = (byFlavor[f] || 0) + 1;
    });
  }

  const totalBrews = data.length - 1;
  const result = {
    total_brews: totalBrews,
    total_owners: owners.size,
    avg_rating: (totalRating / totalBrews).toFixed(1),
    by_origin: byOrigin,
    by_time: byTime,
    by_method: byMethod,
    by_flavor: byFlavor,
  };

  // Cache for 60 seconds
  if (statsSheet) setCachedStats(statsSheet, result);

  return result;
}

function getTimeBucket(mins) {
  if (mins <= 1) return '0-1 min';
  if (mins <= 5) return '1-5 min';
  if (mins <= 15) return '5-15 min';
  if (mins <= 30) return '15-30 min';
  return '30-60 min';
}

// ---------- READ FEED ----------
function handleReadFeed(params) {
  const limit = Math.min(parseInt(params.limit) || 10, 50);
  const offset = parseInt(params.offset) || 0;

  const ss = openSheet();
  const brewSheet = ss.getSheetByName(SHEET_BREWS);
  const data = brewSheet.getDataRange().getValues();

  if (data.length <= 1) return { entries: [] };

  // Reverse for newest first, skip header
  const rows = data.slice(1).reverse();
  const page = rows.slice(offset, offset + limit);

  const entries = page.map(row => ({
    timestamp: row[0],
    origin: row[2],
    process: row[3],
    roast: row[4],
    brew_method: row[5],
    treatment_mins: row[6],
    rating: row[7],
    flavors: row[8],
    note: row[9],
  }));

  return { entries, total: rows.length };
}

// ---------- STATS CACHE ----------
function getCachedStats(sheet) {
  try {
    const data = sheet.getDataRange().getValues();
    for (let i = 0; i < data.length; i++) {
      if (data[i][0] === 'aggregates_cache') {
        const cached = JSON.parse(data[i][1]);
        const cacheTime = new Date(data[i][2]);
        // 60-second TTL
        if (new Date() - cacheTime < 60000) return cached;
      }
    }
  } catch {}
  return null;
}

function setCachedStats(sheet, data) {
  try {
    const allData = sheet.getDataRange().getValues();
    let row = -1;
    for (let i = 0; i < allData.length; i++) {
      if (allData[i][0] === 'aggregates_cache') { row = i + 1; break; }
    }
    if (row === -1) {
      sheet.appendRow(['aggregates_cache', JSON.stringify(data), new Date().toISOString()]);
    } else {
      sheet.getRange(row, 2).setValue(JSON.stringify(data));
      sheet.getRange(row, 3).setValue(new Date().toISOString());
    }
  } catch {}
}

function clearStatsCache(ss) {
  try {
    const sheet = ss.getSheetByName(SHEET_STATS);
    if (!sheet) return;
    const data = sheet.getDataRange().getValues();
    for (let i = 0; i < data.length; i++) {
      if (data[i][0] === 'aggregates_cache') {
        sheet.getRange(i + 1, 3).setValue('1970-01-01T00:00:00');
        break;
      }
    }
  } catch {}
}
