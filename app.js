/* ===== Horizon Lab — Frontend ===== */

// ---------- CONFIG ----------
const CONFIG = {
  // Horizon Lab's own Apps Script backend (brew verification + submission).
  // Leave blank to run in demo mode (localStorage only).
  sheetUrl: 'https://script.google.com/macros/s/AKfycbxrCLVsjmxSdJMhlLebFOjwRMcwGxiopXFWkSRUJYCPQ2kXd1Rd7PkmxlJcHLXACSaQ/exec',
  pollInterval: 30000,
  feedPageSize: 10,

  // horizonvote's deployed Apps Script — reads the shared vote sheet.
  voteUrl: 'https://script.google.com/macros/s/AKfycbxgvqBZxYPq3yGLnJ75AitMoYym2oNkddqRN8hzRG4yuKylxolksVkcx6FYgoaZ9x2RNg/exec',
  voteInterval: 15000,
};

// ---------- STATE ----------
const state = {
  lang: 'en',
  verified: false,
  token: null,
  serial: null,
  aggregates: null,
  feed: [],
  feedOffset: 0,
  comments: null,
  votes: null,
  filters: { process: '', roast: '' },
};

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- I18N ----------
function t(key) {
  const dict = (typeof TRANSLATIONS !== 'undefined' && TRANSLATIONS[state.lang]) || {};
  const fallback = (typeof TRANSLATIONS !== 'undefined' && TRANSLATIONS.en) || {};
  return dict[key] !== undefined ? dict[key] : (fallback[key] !== undefined ? fallback[key] : key);
}

function applyTranslations(lang) {
  state.lang = lang;
  document.documentElement.lang = lang;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });

  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    el.innerHTML = t(key);
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = t(key);
  });

  document.querySelectorAll('.lang-switcher button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });

  // Re-render dynamic sections so their localized strings refresh.
  if (state.aggregates) renderDashboard(state.aggregates);
  if (state.feed && state.feed.length) renderFeed(state.feed);
  if (state.comments) renderComments(state.comments);
  if (state.votes) renderVotes(state.votes);
}

function detectLang() {
  const supported = Object.keys(TRANSLATIONS);
  const saved = localStorage.getItem('horizonlab_lang');
  if (saved && supported.includes(saved)) return saved;
  const nav = navigator.language || navigator.userLanguage || 'en';
  if (supported.includes(nav)) return nav;
  const base = nav.split('-')[0];
  const match = supported.find(s => s.split('-')[0] === base);
  return match || 'en';
}

function initLanguage() {
  applyTranslations(detectLang());

  $('#langSwitcher').addEventListener('click', e => {
    const btn = e.target.closest('button[data-lang]');
    if (!btn) return;
    localStorage.setItem('horizonlab_lang', btn.dataset.lang);
    applyTranslations(btn.dataset.lang);
  });
}

// ---------- INIT ----------
document.addEventListener('DOMContentLoaded', () => {
  initLanguage();
  initScrollFade();
  initVerification();
  initForm();
  initSlider();
  initFilters();
  fetchDashboard();
  fetchFeed();
  fetchComments();
  fetchVotes();
  setInterval(fetchDashboard, CONFIG.pollInterval);
  setInterval(fetchVotes, CONFIG.voteInterval);
});

function initFilters() {
  const onChange = () => {
    state.filters.process = $('#filterProcess').value;
    state.filters.roast = $('#filterRoast').value;
    fetchDashboard();
  };
  $('#filterProcess').addEventListener('change', onChange);
  $('#filterRoast').addEventListener('change', onChange);
}

// ---------- SCROLL FADE ----------
function initScrollFade() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('fade-in');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });
  $$('.section').forEach(s => observer.observe(s));
}

// ---------- SERIAL VERIFICATION ----------
function initVerification() {
  const saved = localStorage.getItem('horizonlab_token');
  const savedSerial = localStorage.getItem('horizonlab_serial');
  if (saved && savedSerial) {
    state.verified = true;
    state.token = saved;
    state.serial = savedSerial;
    showBrewForm();
  }

  $('#btnVerify').addEventListener('click', handleVerify);
  $('#serialInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleVerify();
  });

  $('#btnLogout').addEventListener('click', () => {
    localStorage.removeItem('horizonlab_token');
    localStorage.removeItem('horizonlab_serial');
    state.verified = false;
    state.token = null;
    state.serial = null;
    showVerifyForm();
  });
}

async function handleVerify() {
  const input = $('#serialInput');
  const msg = $('#verifyMsg');
  const serial = input.value.trim();

  if (!serial) {
    msg.textContent = t('err_missing_serial');
    msg.className = 'form-hint error';
    return;
  }

  const btn = $('#btnVerify');
  btn.disabled = true;
  btn.textContent = t('btn_verifying');
  msg.textContent = '';

  try {
    if (!CONFIG.sheetUrl) {
      // Demo mode: no backend deployed yet — accept any input so the UI
      // flow can be tested. Real validation lives in the Apps Script.
      const demoToken = 'demo_' + btoa(serial).slice(0, 16);
      onVerifySuccess(serial, demoToken);
    } else {
      const url = CONFIG.sheetUrl + '?action=verify&serial=' + encodeURIComponent(serial)
        + '&ua=' + encodeURIComponent(navigator.userAgent || '');
      const res = await fetch(url);
      const json = await res.json();

      if (json.success) {
        onVerifySuccess(serial, json.token);
      } else {
        throw new Error(json.error || t('err_invalid_serial'));
      }
    }
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'form-hint error';
  } finally {
    btn.disabled = false;
    btn.textContent = t('btn_verify');
  }
}

function onVerifySuccess(serial, token) {
  state.verified = true;
  state.token = token;
  state.serial = serial;
  localStorage.setItem('horizonlab_token', token);
  localStorage.setItem('horizonlab_serial', serial);
  showBrewForm();
}

function showBrewForm() {
  $('#verifyCard').hidden = true;
  $('#brewCard').hidden = false;
  $('#submitSuccess').hidden = true;
  $('#brewForm').style.display = '';
}

function showVerifyForm() {
  $('#verifyCard').hidden = false;
  $('#brewCard').hidden = true;
  $('#serialInput').value = '';
  $('#verifyMsg').textContent = '';
}

// ---------- BREW FORM ----------
function initForm() {
  $('#brewForm').addEventListener('submit', handleSubmit);
  $('#btnLogAnother').addEventListener('click', () => {
    $('#submitSuccess').hidden = true;
    $('#brewForm').style.display = '';
    $('#brewForm').reset();
    $('#treatmentTimeManual').value = $('#treatmentTime').value;
    $('#timeValue').textContent = formatTreatment($('#treatmentTime').value);
    $('#charCount').textContent = '0';
  });

  $('#brewNote').addEventListener('input', () => {
    $('#charCount').textContent = $('#brewNote').value.length;
  });
}

function formatTreatment(mins) {
  const totalSeconds = Math.round(parseFloat(mins) * 60);
  if (totalSeconds < 60) return totalSeconds + 's';
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return s === 0 ? m + 'm' : m + 'm ' + s + 's';
}

function initSlider() {
  const slider = $('#treatmentTime');
  const manual = $('#treatmentTimeManual');
  const display = $('#timeValue');
  const sliderMax = parseFloat(slider.max);

  const setDisplay = (mins) => {
    display.textContent = formatTreatment(mins);
  };

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    manual.value = v;
    setDisplay(v);
  });

  manual.addEventListener('input', () => {
    const raw = parseFloat(manual.value);
    if (isNaN(raw)) return;
    const v = Math.max(0.25, Math.min(480, raw));
    // Slider follows manual when within slider range; otherwise pinned to max.
    slider.value = String(Math.min(sliderMax, v));
    setDisplay(v);
  });

  setDisplay(parseFloat(manual.value) || parseFloat(slider.value));
}

async function handleSubmit(e) {
  e.preventDefault();

  const form = $('#brewForm');
  const btn = $('#btnSubmit');

  const data = {
    origin: $('#coffeeOrigin').value,
    process: $('#processMethod').value,
    roast: form.querySelector('input[name="roastLevel"]:checked')?.value,
    brew_method: $('#brewMethod').value,
    treatment_mins: parseFloat($('#treatmentTimeManual').value) || parseFloat($('#treatmentTime').value),
    rating: parseInt(form.querySelector('input[name="rating"]:checked')?.value, 10),
    flavors: Array.from(form.querySelectorAll('input[name="flavors"]:checked')).map(c => c.value),
    note: $('#brewNote').value.trim(),
  };

  if (!data.roast) { alert(t('err_missing_roast')); return; }
  if (!data.rating) { alert(t('err_missing_rating')); return; }

  btn.disabled = true;
  btn.textContent = t('btn_submitting');

  try {
    if (!CONFIG.sheetUrl) {
      await new Promise(r => setTimeout(r, 800));
      addToLocalFeed(data);
    } else {
      const url = CONFIG.sheetUrl + '?action=submit_brew';
      const payload = {
        token: state.token,
        serial: state.serial,
        ...data,
        flavors: data.flavors.join(','),
      };
      await fetch(url, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(payload),
      });
    }

    form.style.display = 'none';
    $('#submitSuccess').hidden = false;

    setTimeout(() => {
      fetchDashboard();
      fetchFeed();
    }, 1500);

  } catch (err) {
    alert(t('err_submission'));
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = t('btn_submit');
  }
}

// ---------- LOCAL DEMO FEED ----------
function addToLocalFeed(data) {
  const entry = {
    ...data,
    flavors: data.flavors.join(', '),
    timestamp: new Date().toISOString(),
    serial_prefix: state.serial.slice(0, 6) + '...',
  };

  let saved = [];
  try { saved = JSON.parse(localStorage.getItem('horizonlab_demo_feed') || '[]'); } catch {}
  saved.unshift(entry);
  if (saved.length > 50) saved = saved.slice(0, 50);
  localStorage.setItem('horizonlab_demo_feed', JSON.stringify(saved));
}

// ---------- COMMUNITY VOTE (horizonvote sheet) ----------
async function fetchVotes() {
  try {
    if (!CONFIG.voteUrl) return;
    const url = CONFIG.voteUrl + (CONFIG.voteUrl.includes('?') ? '&' : '?') + 'action=read&_t=' + Date.now();
    const res = await fetch(url);
    const data = await res.json();
    state.votes = data;
    renderVotes(data);
  } catch (err) {
    console.error('Vote fetch error:', err);
  }
}

function renderVotes(data) {
  const yes = parseInt(data?.taste_yes, 10) || 0;
  const no = parseInt(data?.taste_no, 10) || 0;
  const total = yes + no;

  const pctYes = total > 0 ? Math.round((yes / total) * 100) : 0;
  const pctNo = total > 0 ? 100 - pctYes : 0;

  const elPctYes = $('#pctTasteYes');
  const elPctNo = $('#pctTasteNo');
  const elBarYes = $('#barTasteYes');
  const elBarNo = $('#barTasteNo');
  const elTotal = $('#totalTasting');

  if (elPctYes) elPctYes.textContent = total ? pctYes + '%' : '--';
  if (elPctNo) elPctNo.textContent = total ? pctNo + '%' : '--';
  if (elBarYes) elBarYes.style.width = pctYes + '%';
  if (elBarNo) elBarNo.style.width = pctNo + '%';
  if (elTotal) {
    elTotal.innerHTML = (total ? total.toLocaleString() : '--') +
      ' <span data-i18n="votes_suffix">' + t('votes_suffix') + '</span>';
  }
}

// ---------- DASHBOARD DATA ----------
async function fetchDashboard() {
  try {
    let data;
    if (!CONFIG.sheetUrl) {
      data = getDemoAggregates();
    } else {
      const url = CONFIG.sheetUrl + '?action=read_aggregates'
        + '&process=' + encodeURIComponent(state.filters.process || '')
        + '&roast=' + encodeURIComponent(state.filters.roast || '')
        + '&_t=' + Date.now();
      const res = await fetch(url);
      data = await res.json();
    }

    state.aggregates = data;
    renderDashboard(data);
  } catch (err) {
    console.error('Dashboard fetch error:', err);
  }
}

function getDemoAggregates() {
  let feed = [];
  try { feed = JSON.parse(localStorage.getItem('horizonlab_demo_feed') || '[]'); } catch {}

  // Apply filters
  if (state.filters.process) feed = feed.filter(f => f.process === state.filters.process);
  if (state.filters.roast) feed = feed.filter(f => f.roast === state.filters.roast);

  if (feed.length === 0) {
    return { total_brews: 0, total_owners: 0, approval_pct: null, avg_treatment_mins: null, by_origin: {}, by_process: {}, by_roast: {}, by_time: {}, by_method: {}, by_flavor: {} };
  }

  const byOrigin = {};
  const byProcess = {};
  const byRoast = {};
  const byTime = {};
  const byMethod = {};
  const byFlavor = {};
  const owners = new Set();
  // "Positive" = top-2-box (rating 4 or 5: Significant or Dramatic).
  let positiveCount = 0;
  let treatmentSum = 0;

  const bump = (bucket, key, rating) => {
    if (!key) return;
    if (!bucket[key]) bucket[key] = { sum: 0, count: 0 };
    bucket[key].sum += rating;
    bucket[key].count++;
  };

  feed.forEach(f => {
    owners.add(f.serial_prefix);
    if (f.rating >= 4) positiveCount++;
    treatmentSum += parseFloat(f.treatment_mins) || 0;

    bump(byOrigin, f.origin, f.rating);
    bump(byProcess, f.process, f.rating);
    bump(byRoast, f.roast, f.rating);
    bump(byMethod, f.brew_method, f.rating);
    bump(byTime, getTimeBucket(f.treatment_mins), f.rating);

    const flavors = typeof f.flavors === 'string' ? f.flavors.split(', ').filter(Boolean) : (f.flavors || []);
    flavors.forEach(fl => {
      byFlavor[fl] = (byFlavor[fl] || 0) + 1;
    });
  });

  return {
    total_brews: feed.length,
    total_owners: owners.size,
    approval_pct: Math.round((positiveCount / feed.length) * 100),
    avg_treatment_mins: treatmentSum / feed.length,
    by_origin: byOrigin,
    by_process: byProcess,
    by_roast: byRoast,
    by_time: byTime,
    by_method: byMethod,
    by_flavor: byFlavor,
  };
}

function getTimeBucket(mins) {
  if (mins <= 1) return '0-1 min';
  if (mins <= 5) return '1-5 min';
  if (mins <= 15) return '5-15 min';
  if (mins <= 30) return '15-30 min';
  return '30-60 min';
}

// ---------- RENDER DASHBOARD ----------
function renderDashboard(data) {
  // Hero stats reflect the filtered set so users see how the picked
  // profile performs (when a filter is active) or the global picture
  // (when "All" is selected on both filters).
  $('#statBrews').textContent = (data.total_brews || 0).toLocaleString();
  $('#statOwners').textContent = (data.total_owners || 0).toLocaleString();
  $('#statApproval').textContent = (data.approval_pct != null && data.total_brews > 0)
    ? data.approval_pct + '%'
    : '--';

  renderSummary(data);
  renderGaps(data);
}

function renderSummary(data) {
  const card = $('#summaryCard');
  const total = data.total_brews || 0;

  if (total === 0) {
    card.innerHTML = '<div class="chart-empty">' + escapeHtml(t('summary_no_match')) + '</div>';
    return;
  }

  const avgTime = data.avg_treatment_mins
    ? formatTreatment(data.avg_treatment_mins)
    : '--';
  const approval = (data.approval_pct != null) ? data.approval_pct + '%' : '--';

  // Top 5 flavor changes by frequency, expressed as a percentage of matched brews.
  const flavorEntries = Object.entries(data.by_flavor || {})
    .map(([key, count]) => ({ key, count, pct: Math.round((count / total) * 100) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const flavorRows = flavorEntries.map(f => {
    const flavorKey = 'flavor_' + f.key.toLowerCase().replace(/ .*/, '');
    const label = t(flavorKey) !== flavorKey ? t(flavorKey) : f.key;
    return `
      <div class="bar-row">
        <span class="bar-label" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width: ${f.pct}%"></div>
        </div>
        <span class="bar-value">${f.pct}%</span>
      </div>
    `;
  }).join('');

  card.innerHTML = `
    <div class="summary-headline">
      <strong>${total.toLocaleString()}</strong>
      ${escapeHtml(t('summary_brews_label'))}
    </div>
    <div class="summary-stats">
      <div class="summary-pill">
        <span class="summary-pill-num">${escapeHtml(avgTime)}</span>
        <span class="summary-pill-label">${escapeHtml(t('summary_avg_time'))}</span>
      </div>
      <div class="summary-pill">
        <span class="summary-pill-num">${escapeHtml(approval)}</span>
        <span class="summary-pill-label">${escapeHtml(t('summary_approval_label'))}</span>
      </div>
    </div>
    ${flavorRows ? `
      <h4 class="summary-flavors-title">${escapeHtml(t('summary_top_flavors'))}</h4>
      <div class="summary-flavors">${flavorRows}</div>
    ` : ''}
  `;
}

// ---------- EXPLORE GAPS ----------
function renderGaps(data) {
  const grid = $('#gapGrid');
  const origins = ['Ethiopia', 'Colombia', 'Brazil', 'Kenya', 'Guatemala', 'Costa Rica', 'Panama', 'Indonesia'];
  const methods = ['Espresso', 'Pour Over', 'AeroPress', 'French Press'];

  const gaps = [];
  origins.forEach(origin => {
    methods.forEach(method => {
      const count = getComboCount(data, origin, method);
      if (count < 3) {
        gaps.push({ origin, method, count });
      }
    });
  });

  const shuffled = gaps.sort(() => Math.random() - 0.5).slice(0, 8);

  if (shuffled.length === 0) {
    grid.innerHTML = '<div class="chart-empty">' + escapeHtml(t('explore_covered')) + '</div>';
    return;
  }

  grid.innerHTML = shuffled.map(g => `
    <div class="gap-card" onclick="scrollToLog()">
      <div class="gap-origin">${escapeHtml(g.origin)}</div>
      <div class="gap-method">${escapeHtml(g.method)}</div>
      <div class="gap-count">${g.count === 0 ? escapeHtml(t('gap_nodata')) : g.count + '&times;'}</div>
    </div>
  `).join('');
}

function getComboCount(data, origin, method) {
  const o = data.by_origin?.[origin];
  if (!o) return 0;
  return Math.floor(o.count / 3);
}

function scrollToLog() {
  document.getElementById('log').scrollIntoView({ behavior: 'smooth' });
}

// ---------- COMMUNITY FEED ----------
async function fetchFeed() {
  try {
    let entries;
    if (!CONFIG.sheetUrl) {
      try { entries = JSON.parse(localStorage.getItem('horizonlab_demo_feed') || '[]'); } catch { entries = []; }
    } else {
      const url = CONFIG.sheetUrl + '?action=read_feed&limit=' + CONFIG.feedPageSize + '&offset=' + state.feedOffset + '&_t=' + Date.now();
      const res = await fetch(url);
      const json = await res.json();
      entries = json.entries || [];
    }

    state.feed = entries;
    renderFeed(entries);
  } catch (err) {
    console.error('Feed fetch error:', err);
  }
}

function renderFeed(entries) {
  const list = $('#feedList');

  if (!entries || entries.length === 0) {
    list.innerHTML = '<div class="chart-empty">' + escapeHtml(t('feed_empty')) + '</div>';
    $('#btnLoadMore').hidden = true;
    return;
  }

  list.innerHTML = entries.map(e => {
    const flavors = typeof e.flavors === 'string' ? e.flavors : (e.flavors || []).join(', ');
    const timeAgo = formatTimeAgo(e.timestamp);
    const roastKey = 'roast_' + (e.roast || '').toLowerCase();
    const roastLabel = t(roastKey) !== roastKey ? t(roastKey) : (e.roast || '');

    return `
      <div class="feed-card">
        <div class="feed-header">
          <span class="feed-origin">${escapeHtml(e.origin)}</span>
          <span class="feed-rating">${e.rating}/5</span>
        </div>
        <div class="feed-meta">
          <span class="feed-tag">${escapeHtml(e.process || '')}</span>
          <span class="feed-tag">${escapeHtml(roastLabel)}</span>
          <span class="feed-tag">${escapeHtml(e.brew_method || '')}</span>
          <span class="feed-tag">${escapeHtml(formatTreatment(e.treatment_mins))}</span>
        </div>
        ${flavors ? `<div class="feed-meta">${flavors.split(', ').filter(Boolean).map(f => {
          const flavorKey = 'flavor_' + f.toLowerCase().replace(/ .*/, '');
          const flavorLabel = t(flavorKey) !== flavorKey ? t(flavorKey) : f;
          return '<span class="feed-tag">' + escapeHtml(flavorLabel) + '</span>';
        }).join('')}</div>` : ''}
        ${e.note ? `<p class="feed-note">"${escapeHtml(e.note)}"</p>` : ''}
        <div class="feed-time">${escapeHtml(timeAgo)}</div>
      </div>
    `;
  }).join('');

  $('#btnLoadMore').hidden = entries.length < CONFIG.feedPageSize;
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  const now = new Date();
  const then = new Date(timestamp);
  const diff = Math.floor((now - then) / 1000);

  if (diff < 60) return t('time_just_now');
  if (diff < 3600) return Math.floor(diff / 60) + t('time_m_ago');
  if (diff < 86400) return Math.floor(diff / 3600) + t('time_h_ago');
  if (diff < 604800) return Math.floor(diff / 86400) + t('time_d_ago');
  return then.toLocaleDateString(state.lang);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// ---------- COMMENTS ----------
async function fetchComments() {
  const list = $('#commentsList');
  try {
    const res = await fetch('comments.json?_t=' + Date.now());
    if (!res.ok) throw new Error('Failed to load comments');
    const comments = await res.json();
    state.comments = comments;
    renderComments(comments);
  } catch (err) {
    console.error('Comments fetch error:', err);
    list.innerHTML = '<div class="chart-empty">' + escapeHtml(t('comments_error')) + '</div>';
  }
}

function renderComments(comments) {
  const list = $('#commentsList');

  if (!comments || comments.length === 0) {
    list.innerHTML = '<div class="chart-empty">' + escapeHtml(t('comments_loading')) + '</div>';
    return;
  }

  list.innerHTML = comments.map(c => {
    const byline = [c.author, c.location].filter(Boolean).map(escapeHtml).join(' &middot; ');
    const date = c.date ? formatCommentDate(c.date) : '';
    return `
      <div class="comment-card">
        <p class="comment-text">${escapeHtml(c.text || '')}</p>
        <div class="comment-meta">
          <span class="comment-byline">${byline}</span>
          ${date ? `<span class="comment-date">${escapeHtml(date)}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function formatCommentDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString(state.lang, { year: 'numeric', month: 'short', day: 'numeric' });
}
