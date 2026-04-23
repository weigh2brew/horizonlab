/* ===== Horizon Lab — Frontend ===== */

// ---------- CONFIG ----------
const CONFIG = {
  // Replace with your deployed Google Apps Script URL
  sheetUrl: '',
  pollInterval: 30000,
  feedPageSize: 10,
};

// ---------- STATE ----------
const state = {
  verified: false,
  token: null,
  serial: null,
  aggregates: null,
  feed: [],
  feedOffset: 0,
};

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- INIT ----------
document.addEventListener('DOMContentLoaded', () => {
  initScrollFade();
  initVerification();
  initForm();
  initSlider();
  fetchDashboard();
  fetchFeed();
  fetchComments();
  setInterval(fetchDashboard, CONFIG.pollInterval);
});

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
  // Check localStorage for existing verification
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
    msg.textContent = 'Please enter your serial number.';
    msg.className = 'form-hint error';
    return;
  }

  const btn = $('#btnVerify');
  btn.disabled = true;
  btn.textContent = 'Verifying...';
  msg.textContent = '';

  try {
    if (!CONFIG.sheetUrl) {
      // Demo mode: accept any serial starting with HZ-
      if (serial.toUpperCase().startsWith('HZ-')) {
        const demoToken = 'demo_' + btoa(serial).slice(0, 16);
        onVerifySuccess(serial, demoToken);
      } else {
        throw new Error('Invalid serial number format. Expected: HZ-XXXXXXXX');
      }
    } else {
      const url = CONFIG.sheetUrl + '?action=verify&serial=' + encodeURIComponent(serial);
      const res = await fetch(url);
      const json = await res.json();

      if (json.success) {
        onVerifySuccess(serial, json.token);
      } else {
        throw new Error(json.error || 'Serial not recognized. Please check and try again.');
      }
    }
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'form-hint error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify';
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
    $('#timeValue').textContent = '5';
    $('#charCount').textContent = '0';
  });

  $('#brewNote').addEventListener('input', () => {
    $('#charCount').textContent = $('#brewNote').value.length;
  });
}

function initSlider() {
  const slider = $('#treatmentTime');
  const display = $('#timeValue');

  slider.addEventListener('input', () => {
    const val = parseFloat(slider.value);
    display.textContent = val % 1 === 0 ? val.toFixed(0) : val.toFixed(1);
  });
}

async function handleSubmit(e) {
  e.preventDefault();

  const form = $('#brewForm');
  const btn = $('#btnSubmit');

  // Gather data
  const data = {
    origin: $('#coffeeOrigin').value,
    process: $('#processMethod').value,
    roast: form.querySelector('input[name="roastLevel"]:checked')?.value,
    brew_method: $('#brewMethod').value,
    treatment_mins: parseFloat($('#treatmentTime').value),
    rating: parseInt(form.querySelector('input[name="rating"]:checked')?.value, 10),
    flavors: Array.from(form.querySelectorAll('input[name="flavors"]:checked')).map(c => c.value),
    note: $('#brewNote').value.trim(),
  };

  // Validate
  if (!data.roast) { alert('Please select a roast level.'); return; }
  if (!data.rating) { alert('Please rate the taste difference.'); return; }

  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    if (!CONFIG.sheetUrl) {
      // Demo mode: simulate submission
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

    // Show success
    form.style.display = 'none';
    $('#submitSuccess').hidden = false;

    // Refresh data
    setTimeout(() => {
      fetchDashboard();
      fetchFeed();
    }, 1500);

  } catch (err) {
    alert('Submission failed. Please try again.');
    console.error(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit Brew Log';
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

// ---------- DASHBOARD DATA ----------
async function fetchDashboard() {
  try {
    let data;
    if (!CONFIG.sheetUrl) {
      data = getDemoAggregates();
    } else {
      const url = CONFIG.sheetUrl + '?action=read_aggregates&_t=' + Date.now();
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
  // Build from local demo feed
  let feed = [];
  try { feed = JSON.parse(localStorage.getItem('horizonlab_demo_feed') || '[]'); } catch {}

  if (feed.length === 0) {
    return { total_brews: 0, total_owners: 0, avg_rating: 0, by_origin: {}, by_time: {}, by_method: {}, by_flavor: {} };
  }

  const byOrigin = {};
  const byTime = {};
  const byMethod = {};
  const byFlavor = {};
  const owners = new Set();
  let totalRating = 0;

  feed.forEach(f => {
    owners.add(f.serial_prefix);
    totalRating += f.rating;

    // Origin
    if (!byOrigin[f.origin]) byOrigin[f.origin] = { sum: 0, count: 0 };
    byOrigin[f.origin].sum += f.rating;
    byOrigin[f.origin].count++;

    // Time bucket
    const bucket = getTimeBucket(f.treatment_mins);
    if (!byTime[bucket]) byTime[bucket] = { sum: 0, count: 0 };
    byTime[bucket].sum += f.rating;
    byTime[bucket].count++;

    // Method
    if (!byMethod[f.brew_method]) byMethod[f.brew_method] = { sum: 0, count: 0 };
    byMethod[f.brew_method].sum += f.rating;
    byMethod[f.brew_method].count++;

    // Flavors
    const flavors = typeof f.flavors === 'string' ? f.flavors.split(', ').filter(Boolean) : (f.flavors || []);
    flavors.forEach(fl => {
      byFlavor[fl] = (byFlavor[fl] || 0) + 1;
    });
  });

  return {
    total_brews: feed.length,
    total_owners: owners.size,
    avg_rating: (totalRating / feed.length).toFixed(1),
    by_origin: byOrigin,
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
  // Hero stats
  $('#statBrews').textContent = (data.total_brews || 0).toLocaleString();
  $('#statOwners').textContent = (data.total_owners || 0).toLocaleString();
  $('#statAvgRating').textContent = data.avg_rating && data.avg_rating > 0
    ? data.avg_rating + '/5'
    : '--';

  // Charts
  renderBarChart('chartOrigin', data.by_origin, 'avg');
  renderBarChart('chartTime', data.by_time, 'avg', true);
  renderBarChart('chartMethod', data.by_method, 'avg');
  renderCountChart('chartFlavor', data.by_flavor);

  // Explore gaps
  renderGaps(data);
}

function renderBarChart(containerId, dataObj, mode, preserveOrder) {
  const container = document.getElementById(containerId);
  if (!dataObj || Object.keys(dataObj).length === 0) {
    container.innerHTML = '<div class="chart-empty">Waiting for data...</div>';
    return;
  }

  let entries = Object.entries(dataObj).map(([label, val]) => ({
    label,
    avg: val.sum / val.count,
    count: val.count,
  }));

  if (!preserveOrder) {
    entries.sort((a, b) => b.avg - a.avg);
  }

  const maxAvg = 5; // max rating

  container.innerHTML = entries.map(e => {
    const pct = (e.avg / maxAvg) * 100;
    return `
      <div class="bar-row">
        <span class="bar-label" title="${e.label}">${e.label}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width: ${pct}%"></div>
        </div>
        <span class="bar-value">${e.avg.toFixed(1)} <span class="bar-count">(${e.count})</span></span>
      </div>
    `;
  }).join('');
}

function renderCountChart(containerId, dataObj) {
  const container = document.getElementById(containerId);
  if (!dataObj || Object.keys(dataObj).length === 0) {
    container.innerHTML = '<div class="chart-empty">Waiting for data...</div>';
    return;
  }

  const entries = Object.entries(dataObj)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  const maxCount = entries[0]?.count || 1;

  container.innerHTML = entries.map(e => {
    const pct = (e.count / maxCount) * 100;
    return `
      <div class="bar-row">
        <span class="bar-label" title="${e.label}">${e.label}</span>
        <div class="bar-track">
          <div class="bar-fill" style="width: ${pct}%"></div>
        </div>
        <span class="bar-value">${e.count}x</span>
      </div>
    `;
  }).join('');
}

// ---------- EXPLORE GAPS ----------
function renderGaps(data) {
  const grid = $('#gapGrid');
  const origins = ['Ethiopia', 'Colombia', 'Brazil', 'Kenya', 'Guatemala', 'Costa Rica', 'Panama', 'Indonesia'];
  const methods = ['Espresso', 'Pour Over', 'AeroPress', 'French Press'];
  const existing = data.by_origin || {};

  const gaps = [];
  origins.forEach(origin => {
    methods.forEach(method => {
      const count = getComboCount(data, origin, method);
      if (count < 3) {
        gaps.push({ origin, method, count });
      }
    });
  });

  // Shuffle and take top 8
  const shuffled = gaps.sort(() => Math.random() - 0.5).slice(0, 8);

  if (shuffled.length === 0) {
    grid.innerHTML = '<div class="chart-empty">Great coverage! Keep logging to refine the data.</div>';
    return;
  }

  grid.innerHTML = shuffled.map(g => `
    <div class="gap-card" onclick="scrollToLog()">
      <div class="gap-origin">${g.origin}</div>
      <div class="gap-method">${g.method}</div>
      <div class="gap-count">${g.count === 0 ? 'No data yet' : g.count + ' brew' + (g.count > 1 ? 's' : '')}</div>
    </div>
  `).join('');
}

function getComboCount(data, origin, method) {
  // In the real backend this would be a proper query.
  // For demo, just return 0 if no data for origin.
  const o = data.by_origin?.[origin];
  if (!o) return 0;
  return Math.floor(o.count / 3); // rough estimate
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
    list.innerHTML = '<div class="chart-empty">No brews logged yet. Be the first!</div>';
    $('#btnLoadMore').hidden = true;
    return;
  }

  list.innerHTML = entries.map(e => {
    const flavors = typeof e.flavors === 'string' ? e.flavors : (e.flavors || []).join(', ');
    const ratingStars = getRatingLabel(e.rating);
    const timeAgo = formatTimeAgo(e.timestamp);

    return `
      <div class="feed-card">
        <div class="feed-header">
          <span class="feed-origin">${escapeHtml(e.origin)}</span>
          <span class="feed-rating">${e.rating}/5 ${ratingStars}</span>
        </div>
        <div class="feed-meta">
          <span class="feed-tag">${escapeHtml(e.process || '')}</span>
          <span class="feed-tag">${escapeHtml(e.roast || '')} Roast</span>
          <span class="feed-tag">${escapeHtml(e.brew_method || '')}</span>
          <span class="feed-tag">${e.treatment_mins} min</span>
        </div>
        ${flavors ? `<div class="feed-meta">${flavors.split(', ').map(f => '<span class="feed-tag">' + escapeHtml(f) + '</span>').join('')}</div>` : ''}
        ${e.note ? `<p class="feed-note">"${escapeHtml(e.note)}"</p>` : ''}
        <div class="feed-time">${timeAgo}</div>
      </div>
    `;
  }).join('');

  $('#btnLoadMore').hidden = entries.length < CONFIG.feedPageSize;
}

function getRatingLabel(rating) {
  const labels = { 1: '', 2: '', 3: '', 4: '', 5: '' };
  return labels[rating] || '';
}

function formatTimeAgo(timestamp) {
  if (!timestamp) return '';
  const now = new Date();
  const then = new Date(timestamp);
  const diff = Math.floor((now - then) / 1000);

  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return then.toLocaleDateString();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- COMMENTS ----------
async function fetchComments() {
  const list = $('#commentsList');
  try {
    const res = await fetch('comments.json?_t=' + Date.now());
    if (!res.ok) throw new Error('Failed to load comments');
    const comments = await res.json();
    renderComments(comments);
  } catch (err) {
    console.error('Comments fetch error:', err);
    list.innerHTML = '<div class="chart-empty">Comments unavailable right now.</div>';
  }
}

function renderComments(comments) {
  const list = $('#commentsList');

  if (!comments || comments.length === 0) {
    list.innerHTML = '<div class="chart-empty">No comments yet.</div>';
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
          ${date ? `<span class="comment-date">${date}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function formatCommentDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return escapeHtml(dateStr);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
