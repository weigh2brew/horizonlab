/**
 * Horizon Lab — Google Apps Script Backend
 *
 * This script reads/writes the same Google Sheet that horizonvote uses,
 * via tabs it owns (verify_log / brews / stats). The existing horizonvote
 * key-value tab is untouched. Because this script opens the sheet by ID,
 * it can be a standalone Apps Script — it does NOT need to be container-
 * bound to the sheet.
 *
 * Verification model: format-only. We do NOT keep a whitelist of valid
 * serials — anything matching the AHN101 format passes. Every successful
 * verify is appended to the verify_log tab so we have a record of who
 * accessed the form.
 *
 * SETUP:
 * 1. In the shared Google Sheet, add three new tabs (leave the existing
 *    horizonvote tab alone):
 *    - "verify_log" — timestamp | serial | token | user_agent
 *    - "brews"      — timestamp | serial_hash | origin | process | roast |
 *                      brew_method | treatment_mins | rating | flavors | note
 *    - "stats"      — Column A: key, Column B: value (aggregates cache)
 *
 *    The verify_log and brews tabs should have a header row in row 1.
 *
 * 2. Create a new Apps Script project at script.google.com (standalone,
 *    not bound to any sheet). Paste this entire file in. Deploy as
 *    Web App with:
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    On first run, authorize the "See, edit, create, and delete..."
 *    scope so the script can read/write the sheet by ID.
 *
 * 3. Copy the deployment URL into app.js CONFIG.sheetUrl.
 */

// ---------- SHEET CONFIG ----------
// Shared with horizonvote. Find in the sheet URL:
//   https://docs.google.com/spreadsheets/d/<ID>/edit
const SHEET_ID = '17qM1uriZ4QgXbO0iwibxLO5LIw1f6Vit0h2X7ws7-Vs';
const SHEET_VERIFY_LOG = 'verify_log';
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
        return jsonResponse(handleReadAggregates(e.parameter));
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

  // Format passed — issue a token and log the access.
  const token = Utilities.getUuid();
  const userAgent = (params.ua || '').toString().slice(0, 200);

  const ss = openSheet();
  const sheet = ss.getSheetByName(SHEET_VERIFY_LOG);
  if (sheet) {
    sheet.appendRow([
      new Date().toISOString(),  // timestamp
      serial,                    // serial
      token,                     // token
      userAgent,                 // user_agent (optional, for spam triage)
    ]);
  }

  return { success: true, token: token };
}

// ---------- SUBMIT BREW ----------
function handleSubmitBrew(payload) {
  // Validate token: must exist in verify_log column C.
  const token = payload.token;
  if (!token) return { success: false, error: 'Missing token.' };

  const ss = openSheet();
  const logSheet = ss.getSheetByName(SHEET_VERIFY_LOG);
  const logData = logSheet ? logSheet.getDataRange().getValues() : [];
  let tokenValid = false;

  for (let i = 1; i < logData.length; i++) {
    if (logData[i][2] === token) {
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
  const treatmentMins = Math.max(0.25, Math.min(480, parseFloat(payload.treatment_mins) || 5));
  const rating = Math.max(1, Math.min(3, parseInt(payload.rating) || 2));
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
function handleReadAggregates(params) {
  params = params || {};
  const filterProcess = String(params.process || '').trim();
  const filterRoast = String(params.roast || '').trim();
  const isFiltered = !!(filterProcess || filterRoast);

  const ss = openSheet();

  // Cache only the unfiltered global view; filtered views are cheap enough
  // to recompute and would otherwise need a cache key per filter combo.
  const statsSheet = ss.getSheetByName(SHEET_STATS);
  if (statsSheet && !isFiltered) {
    const cached = getCachedStats(statsSheet);
    if (cached) return cached;
  }

  // Compute fresh
  const brewSheet = ss.getSheetByName(SHEET_BREWS);
  const data = brewSheet.getDataRange().getValues();

  if (data.length <= 1) {
    return { total_brews: 0, total_owners: 0, impact_score: null, avg_treatment_mins: null, by_origin: {}, by_process: {}, by_roast: {}, by_time: {}, by_method: {}, by_flavor: {} };
  }

  const byOrigin = {};
  const byProcess = {};
  const byRoast = {};
  const byTime = {};
  const byMethod = {};
  const byFlavor = {};
  const owners = new Set();
  // Impact score: avg rating on the 3-stop preference scale mapped to -100..+100.
  // (1 = Untreated → -100, 2 = No preference → 0, 3 = Horizon → +100.)
  let ratingSum = 0;
  let ratingCount = 0;
  let matchedBrews = 0;
  let treatmentSum = 0;

  function bump(bucket, key, rating) {
    if (!key) return;
    if (!bucket[key]) bucket[key] = { sum: 0, count: 0 };
    bucket[key].sum += rating;
    bucket[key].count++;
  }

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const serialHash = row[1];
    const origin = row[2];
    const process = row[3];
    const roast = row[4];
    const brewMethod = row[5];
    const treatmentMins = parseFloat(row[6]) || 5;
    const rating = parseInt(row[7]) || 3;
    const flavors = String(row[8] || '');

    if (filterProcess && process !== filterProcess) continue;
    if (filterRoast && roast !== filterRoast) continue;

    matchedBrews++;
    owners.add(serialHash);
    // Only count ratings on the new 3-stop scale; legacy 4/5 values are
    // ignored so old test data doesn't skew the score.
    if (rating >= 1 && rating <= 3) {
      ratingSum += rating;
      ratingCount++;
    }
    treatmentSum += treatmentMins;

    bump(byOrigin, origin, rating);
    bump(byProcess, process, rating);
    bump(byRoast, roast, rating);
    bump(byMethod, brewMethod, rating);
    bump(byTime, getTimeBucket(treatmentMins), rating);

    // "+Flavor" = got stronger, "-Flavor" = got weaker. Bare flavor names
    // (legacy, pre-divergent-bar entries) are counted as "more".
    flavors.split(',').forEach(function (f) {
      f = String(f).trim();
      if (!f) return;
      var dir = 'more', name = f;
      if (f.charAt(0) === '+') { dir = 'more'; name = f.slice(1); }
      else if (f.charAt(0) === '-') { dir = 'less'; name = f.slice(1); }
      if (!name) return;
      if (!byFlavor[name]) byFlavor[name] = { more: 0, less: 0 };
      byFlavor[name][dir]++;
    });
  }

  if (matchedBrews === 0) {
    return { total_brews: 0, total_owners: 0, impact_score: null, avg_treatment_mins: null, by_origin: {}, by_process: {}, by_roast: {}, by_time: {}, by_method: {}, by_flavor: {} };
  }

  const impactScore = ratingCount > 0
    ? Math.round((ratingSum / ratingCount - 2) * 100)
    : null;
  const result = {
    total_brews: matchedBrews,
    total_owners: owners.size,
    impact_score: impactScore,
    avg_treatment_mins: treatmentSum / matchedBrews,
    by_origin: byOrigin,
    by_process: byProcess,
    by_roast: byRoast,
    by_time: byTime,
    by_method: byMethod,
    by_flavor: byFlavor,
  };

  // Cache only the unfiltered global view.
  if (statsSheet && !isFiltered) setCachedStats(statsSheet, result);

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
