/* ═══════════════════════════════════════════════════════════
   The Wordle Open — Frontend
═══════════════════════════════════════════════════════════ */

// ─── State ────────────────────────────────────────────────
const S = {
  players:       [],
  todayDate:     null,
  todayPuzzle:   null,
  activeTab:     'today',
  activeSub:     'monthly',
  seasonLoaded:  false,
  monthlyLoaded: false,
  alltimeLoaded: false,
  fameLoaded:    false,
  dailyData:     [],
  seasonData:    null,
  // paste state
  pastedPuzzle:  null,
};

// ─── Golf helpers ─────────────────────────────────────────

function fmtVsPar(diff) {
  if (diff === 0) return 'E';
  return diff < 0 ? `${diff}` : `+${diff}`;
}

function parClass(diff) {
  if (diff < 0) return 'under';
  if (diff > 0) return 'over';
  return 'even';
}

function shotName(strokes) {
  return {
    1: '⛳ Hole in One!', 2: '🦅 Eagle', 3: '🐦 Birdie',
    4: 'Par', 5: 'Bogey', 6: 'Dbl Bogey', 7: '💀 Penalty',
  }[strokes] ?? strokes;
}

function fmtGuesses(g) {
  return g === 0 ? 'X/6' : `${g}/6`;
}

function rankLabel(i, rows) {
  // tied rank handling
  if (i > 0 && rows[i].avg_strokes === rows[i - 1].avg_strokes) return 'T';
  return '';
}

function posLabel(i, rows) {
  const tied = i > 0 && (rows[i].total_strokes ?? rows[i].avg_strokes) === (rows[i - 1].total_strokes ?? rows[i - 1].avg_strokes);
  return tied ? `T${i + 1}` : `${i + 1}`;
}

function fmtDate(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

function fmtDateShort(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  });
}

// ─── Escape HTML ──────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── API ──────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' }, ...opts,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(e.error || res.statusText);
  }
  return res.json();
}

// ─── Socket.IO ────────────────────────────────────────────
const socket = io();
socket.on('connect',    () => setLive(true));
socket.on('disconnect', () => setLive(false));

socket.on('update', data => {
  if (data.puzzle_number) {
    S.todayPuzzle = data.puzzle_number;
    S.todayDate   = data.today_date;
    updateHeaderDate(data.today_date);
    if (!S.pastedPuzzle) {
      document.getElementById('puzzle-number').value = data.puzzle_number;
      document.getElementById('round-badge').textContent = `Round ${data.puzzle_number}`;
    }
  }
  if (data.daily) {
    S.dailyData = data.daily;
    if (S.activeTab === 'today') renderDailyLeaderboard(data.daily);
  }
  if (data.season) {
    S.seasonData = data.season;
    if (S.activeTab === 'season') renderSeason(data.season);
  }
});

function setLive(on) {
  const d = document.querySelector('.live-dot');
  if (d) d.style.background = on ? 'var(--gold)' : '#555';
}

function updateHeaderDate(dateStr) {
  const el = document.getElementById('header-date');
  if (el && dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    el.textContent = d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
  }
}

// ─── Tab navigation ───────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  S.activeTab = name;
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-section').forEach(s => {
    const on = s.id === `tab-${name}`;
    s.classList.toggle('active', on);
    s.classList.toggle('hidden', !on);
  });
  if (name === 'season')    loadSeason();
  if (name === 'scorecard') loadScorecard();
  if (name === 'locker' && !S.fameLoaded) loadFame();
}

// Sub-tabs
document.querySelectorAll('.sub-tab').forEach(btn => {
  btn.addEventListener('click', () => switchSub(btn.dataset.sub));
});

function switchSub(name) {
  S.activeSub = name;
  document.querySelectorAll('.sub-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.sub === name));
  document.querySelectorAll('.sub-panel').forEach(p => {
    const on = p.id === `sub-${name}`;
    p.classList.toggle('active', on);
    p.classList.toggle('hidden', !on);
  });
  if (name === 'monthly' && !S.monthlyLoaded) fetchMonthly();
  if (name === 'alltime'  && !S.alltimeLoaded) fetchAlltime();
}

// ─── Players ──────────────────────────────────────────────
async function loadPlayers() {
  S.players = await apiFetch('/api/players');
  ['player-select', 'stats-player-select'].forEach(id => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = `<option value="">Select a golfer…</option>` +
      S.players.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if (prev) sel.value = prev;
  });
}

document.getElementById('add-player-btn').addEventListener('click', () => {
  const w = document.getElementById('new-player-wrap');
  w.classList.toggle('hidden');
  if (!w.classList.contains('hidden')) document.getElementById('new-player-name').focus();
});

document.getElementById('save-player-btn').addEventListener('click', savePlayer);
document.getElementById('new-player-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); savePlayer(); }
});

async function savePlayer() {
  const input = document.getElementById('new-player-name');
  const name  = input.value.trim();
  if (!name) return;
  try {
    const p = await apiFetch('/api/players', {
      method: 'POST', body: JSON.stringify({ name }),
    });
    await loadPlayers();
    document.getElementById('player-select').value = p.id;
    input.value = '';
    document.getElementById('new-player-wrap').classList.add('hidden');
  } catch (e) {
    showFormMsg(e.message, 'error');
  }
}

// ─── Clipboard paste ──────────────────────────────────────
document.getElementById('paste-btn').addEventListener('click', pasteWordle);

async function pasteWordle() {
  try {
    const text = await navigator.clipboard.readText();
    // Wordle share format: "Wordle 1,234 3/6" or "Wordle 1234 X/6*"
    const m = text.match(/Wordle\s+([\d,]+)\s+([1-6X])\/6/i);
    if (!m) {
      showFormMsg('⛳ No Wordle score found in clipboard', 'error');
      return;
    }
    const puzzleNum = parseInt(m[1].replace(/,/g, ''));
    const guessChar = m[2].toUpperCase();
    const guesses   = guessChar === 'X' ? 0 : parseInt(guessChar);
    const strokes   = guesses === 0 ? 7 : guesses;
    const vsPar     = strokes - 4;

    // Store pasted puzzle number
    S.pastedPuzzle = puzzleNum;
    document.getElementById('puzzle-number').value = puzzleNum;
    document.getElementById('result-select').value = guesses;

    // Compute date from puzzle number
    const dateStr  = await apiFetch(`/api/today`).then(() => null).catch(() => null);
    const epoch    = new Date('2021-06-19T12:00:00Z').getTime();
    const d        = new Date(epoch + (puzzleNum - 1) * 86400000);
    const dateFmt  = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const vParFmt  = fmtVsPar(vsPar);
    const shot     = shotName(strokes);

    const det = document.getElementById('paste-detection');
    det.innerHTML = `
      📋 Detected: <strong>${dateFmt}</strong><br>
      ⛳ Round ${puzzleNum} · ${fmtGuesses(guesses)} · ${shot}
      <span style="color:${vsPar < 0 ? 'var(--red)' : 'var(--cream)'}">(${vParFmt})</span>
    `;
    det.classList.remove('hidden');

    // Update round badge
    document.getElementById('round-badge').textContent = `Round ${puzzleNum}`;
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      showFormMsg('📋 Allow clipboard access to paste — try copying your Wordle score first', 'error');
    } else {
      showFormMsg('Could not read clipboard', 'error');
    }
  }
}

// ─── Score submission ─────────────────────────────────────
document.getElementById('score-form').addEventListener('submit', async e => {
  e.preventDefault();
  const playerId  = parseInt(document.getElementById('player-select').value);
  const puzzleNum = parseInt(document.getElementById('puzzle-number').value) || S.todayPuzzle;
  const guesses   = parseInt(document.getElementById('result-select').value);
  const btn       = document.getElementById('submit-btn');

  if (!playerId)  return showFormMsg('Select a golfer first 🏌️', 'error');
  if (!puzzleNum) return showFormMsg('No round number detected', 'error');

  btn.disabled    = true;
  btn.textContent = '⛳ Posting…';

  try {
    const result = await apiFetch('/api/scores', {
      method: 'POST',
      body: JSON.stringify({ player_id: playerId, puzzle_number: puzzleNum, guesses }),
    });
    const strokes = guesses === 0 ? 7 : guesses;
    const vsPar   = strokes - 4;
    showFormMsg(`Score posted! ${fmtGuesses(guesses)} · ${shotName(strokes)} (${fmtVsPar(vsPar)}) 🏌️`, 'success');

    // Reset paste state
    S.pastedPuzzle = null;
    document.getElementById('paste-detection').classList.add('hidden');
    document.getElementById('puzzle-number').value = S.todayPuzzle || '';
    document.getElementById('round-badge').textContent = `Round ${S.todayPuzzle || '—'}`;

    // 18th hole celebration
    if (result.completed_18th) {
      const playerName = S.players.find(p => p.id === playerId)?.name ?? 'You';
      triggerCelebration(playerName, result);
    }
  } catch (err) {
    showFormMsg(err.message, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = '🏌️ Post Score';
  }
});

function showFormMsg(text, type) {
  const el = document.getElementById('form-msg');
  el.innerHTML = text;
  el.className = `form-msg ${type}`;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 5000);
}

// ─── 18th Hole Celebration ────────────────────────────────
function triggerCelebration(name, result) {
  document.getElementById('cele-name').textContent = name;
  document.getElementById('cele-score').textContent =
    `Season complete · ${result.strokes} strokes on hole 18`;
  document.getElementById('celebration-overlay').classList.remove('hidden');
  spawnConfetti();
}

window.closeCelebration = function() {
  document.getElementById('celebration-overlay').classList.add('hidden');
  document.getElementById('confetti-wrap').innerHTML = '';
};

function spawnConfetti() {
  const wrap   = document.getElementById('confetti-wrap');
  wrap.innerHTML = '';
  const colors = ['#d4af37','#f0d060','#2d5a27','#f5f0dc','#dc2626','#ffffff'];
  for (let i = 0; i < 80; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    el.style.left     = `${Math.random() * 100}%`;
    el.style.background = colors[Math.floor(Math.random() * colors.length)];
    el.style.width    = `${6 + Math.random() * 8}px`;
    el.style.height   = `${6 + Math.random() * 8}px`;
    el.style.animationDuration = `${1.5 + Math.random() * 2.5}s`;
    el.style.animationDelay   = `${Math.random() * 0.8}s`;
    wrap.appendChild(el);
  }
}

// ─── Render: Daily leaderboard ───────────────────────────
function renderDailyLeaderboard(entries) {
  const el = document.getElementById('daily-leaderboard');
  if (!entries.length) {
    el.innerHTML = '<div class="state-msg">No scores yet today — first on the tee! ⛳</div>';
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  let prev = null, rank = 0;
  el.innerHTML = entries.map((e, i) => {
    if (e.strokes !== prev) { rank = i + 1; prev = e.strokes; }
    const tied = i > 0 && e.strokes === entries[i - 1].strokes;
    const pos  = tied ? `T${rank}` : `${rank}`;
    const vpd  = e.strokes - 4;
    const vStr = fmtVsPar(vpd);
    const cls  = parClass(vpd);
    return `
      <div class="sb-row ${i < 3 ? `r${i+1}` : ''}">
        <div class="sb-pos ${tied ? 'tied' : ''}">${medals[i] ?? pos}</div>
        <div>
          <div class="sb-name">${esc(e.name)}</div>
          <div class="sb-sub">${shotName(e.strokes)}</div>
        </div>
        <div class="sb-rounds">${fmtGuesses(e.guesses)}</div>
        <div class="sb-score ${cls}">${vStr}<small>${e.strokes} strokes</small></div>
      </div>`;
  }).join('');
}

// ─── Share to WhatsApp ────────────────────────────────────
document.getElementById('share-btn').addEventListener('click', async () => {
  try {
    const date = S.todayDate || new Date().toISOString().split('T')[0];
    const { text } = await apiFetch(`/api/share/daily?date=${date}`);
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  } catch {
    alert('Could not generate scorecard.');
  }
});

// ─── Season ───────────────────────────────────────────────
function loadSeason() {
  if (S.seasonData) renderSeason(S.seasonData);
  apiFetch('/api/leaderboard/season')
    .then(data => { S.seasonData = data; renderSeason(data); })
    .catch(() => {});
}

function renderSeason(data) {
  const { rows, season_start, season_end } = data;

  // Range label
  document.getElementById('season-range').textContent =
    `${fmtDateShort(season_start)} → ${fmtDateShort(season_end)}`;

  // Podium
  const pod = document.getElementById('season-podium');
  if (!rows.length) {
    pod.innerHTML = '<div class="state-msg">No rounds played this season yet ⛳</div>';
    document.getElementById('season-leaderboard').innerHTML = '';
    return;
  }

  const icons = ['🏆', '🥈', '🥉'];
  const pos   = ['p1', 'p2', 'p3'];
  const top   = rows.slice(0, 3);
  pod.innerHTML = `<div class="podium-wrap">${top.map((r, i) => {
    const vpd = parseFloat(r.avg_strokes) - 4;
    const cls = vpd < 0 ? 'under' : vpd > 0 ? 'over' : 'even';
    const vStr = fmtVsPar(Math.round(vpd * r.rounds_played));
    return `
      <div class="podium-slot ${pos[i]}">
        <div class="podium-icon">${icons[i]}</div>
        <div class="podium-name">${esc(r.name)}</div>
        <div class="podium-score ${cls}">${vStr}</div>
        <div class="podium-rounds">${r.rounds_played}/18 rounds</div>
        <div class="podium-block"></div>
      </div>`;
  }).join('')}</div>`;

  // Full standings
  const lb = document.getElementById('season-leaderboard');
  lb.innerHTML = rows.map((r, i) => {
    const vpd  = parseFloat(r.avg_strokes) - 4;
    const vStr = fmtVsPar(Math.round(vpd * r.rounds_played));
    const cls  = vpd < 0 ? 'under' : vpd > 0 ? 'over' : 'even';
    const tied = i > 0 && r.avg_strokes === rows[i - 1].avg_strokes;
    return `
      <div class="sb-row ${i < 3 ? `r${i+1}` : ''}">
        <div class="sb-pos ${tied ? 'tied' : ''}">${tied ? `T${i+1}` : i+1}</div>
        <div>
          <div class="sb-name">${esc(r.name)}</div>
          <div class="sb-sub">avg ${r.avg_strokes} · hdcp ${fmtVsPar(Math.round((parseFloat(r.avg_strokes)-4)*10)/10)}</div>
        </div>
        <div class="sb-rounds">${r.rounds_played}/18</div>
        <div class="sb-score ${cls}">${vStr}<small>total</small></div>
      </div>`;
  }).join('');
}

// ─── Scoreboard (monthly / all-time) ─────────────────────
function loadScorecard() {
  if (!S.monthlyLoaded) fetchMonthly();
}

async function fetchMonthly() {
  const month = (S.todayDate || new Date().toISOString().split('T')[0]).slice(0, 7);
  try {
    const rows = await apiFetch(`/api/leaderboard/monthly?month=${month}`);
    S.monthlyLoaded = true;
    renderRankings('monthly-leaderboard', rows);
  } catch {}
}

async function fetchAlltime() {
  try {
    const rows = await apiFetch('/api/leaderboard/alltime');
    S.alltimeLoaded = true;
    renderRankings('alltime-leaderboard', rows);
  } catch {}
}

function renderRankings(elId, rows) {
  const el = document.getElementById(elId);
  if (!rows.length) {
    el.innerHTML = '<div class="state-msg">No rounds played yet ⛳</div>';
    return;
  }
  el.innerHTML = rows.map((r, i) => {
    const vpd  = parseFloat(r.avg_strokes) - 4;
    const cls  = vpd < 0 ? 'under' : vpd > 0 ? 'over' : 'even';
    const vStr = fmtVsPar(r.total_strokes - r.rounds_played * 4);
    const tied = i > 0 && r.avg_strokes === rows[i - 1].avg_strokes;
    return `
      <div class="sb-row ${i < 3 ? `r${i+1}` : ''}">
        <div class="sb-pos ${tied ? 'tied' : ''}">${tied ? `T${i+1}` : i+1}</div>
        <div>
          <div class="sb-name">${esc(r.name)}</div>
          <div class="sb-sub">${r.rounds_played} rounds · best ${r.best_round ?? '—'}</div>
        </div>
        <div class="sb-rounds">avg ${r.avg_strokes ?? '—'}</div>
        <div class="sb-score ${cls}">${vStr}<small>${r.total_strokes} total</small></div>
      </div>`;
  }).join('');
}

// Sub-tab triggers
document.querySelectorAll('.sub-tab').forEach(b => {
  b.addEventListener('click', () => {
    if (b.dataset.sub === 'alltime'  && !S.alltimeLoaded)  fetchAlltime();
    if (b.dataset.sub === 'monthly'  && !S.monthlyLoaded)  fetchMonthly();
  });
});

// ─── Player Stats (My Scorecard) ─────────────────────────
document.getElementById('stats-player-select').addEventListener('change', function() {
  if (this.value) loadStats(parseInt(this.value));
  else document.getElementById('player-stats').classList.add('hidden');
});

async function loadStats(id) {
  try {
    const s = await apiFetch(`/api/players/${id}/stats`);
    document.getElementById('player-stats').classList.remove('hidden');

    const hcpNum = parseFloat(s.handicap ?? 0);
    const hcpStr = s.handicap !== null
      ? (hcpNum >= 0 ? `+${s.handicap}` : s.handicap)
      : '—';

    document.getElementById('st-rounds').textContent   = s.total;
    document.getElementById('st-handicap').textContent = hcpStr;
    document.getElementById('st-best').textContent     = s.best_round ? `${s.best_round} ⛳` : '—';
    document.getElementById('st-under').textContent    = s.under_par;
    document.getElementById('st-streak').textContent   = s.current_streak;
    document.getElementById('st-vspar').textContent    = s.season_vs_par;

    // color handicap
    const hcpEl = document.getElementById('st-handicap');
    hcpEl.classList.toggle('under', hcpNum < 0);

    renderDist(s.distribution, s.total);
  } catch {
    document.getElementById('player-stats').classList.add('hidden');
  }
}

function renderDist(dist, total) {
  const el = document.getElementById('guess-dist');
  const bars = [
    { key: '1', label: '⛳ Hole in One', cls: 'eagle' },
    { key: '2', label: '🦅 Eagle',       cls: 'eagle' },
    { key: '3', label: '🐦 Birdie',      cls: 'birdie' },
    { key: '4', label: 'Par',            cls: 'par' },
    { key: '5', label: 'Bogey',          cls: 'bogey' },
    { key: '6', label: 'Dbl Bogey',      cls: 'double' },
    { key: '7', label: '💀 Penalty',     cls: 'penalty' },
  ];
  const maxCount = Math.max(1, ...Object.values(dist));
  el.innerHTML = bars.map(({ key, label, cls }) => {
    const count = dist[key] ?? 0;
    const pct   = Math.round((count / maxCount) * 100);
    return `
      <div class="dist-row">
        <div class="dist-label">${label}</div>
        <div class="dist-track">
          <div class="dist-bar ${cls}" style="width:${Math.max(pct, count > 0 ? 8 : 0)}%">${count || ''}</div>
        </div>
      </div>`;
  }).join('');
}

// ─── Hall of Fame (Champions Locker Room) ─────────────────
async function loadFame() {
  S.fameLoaded = true;
  try {
    const weeks = await apiFetch('/api/hall-of-fame');
    const el = document.getElementById('hall-of-fame');
    if (!weeks.length) {
      el.innerHTML = '<div class="state-msg">No completed weeks yet — keep playing! ⛳</div>';
      return;
    }
    const medals = ['🏆', '🥈', '🥉'];
    el.innerHTML = weeks.map(w => `
      <div class="hof-card">
        <div class="hof-week">🗓️ ${esc(w.week_label)}</div>
        ${w.podium.map((p, i) => {
          const under = p.vs_par.startsWith('-');
          return `
            <div class="hof-entry">
              <div class="hof-medal">${medals[i] ?? `${i+1}.`}</div>
              <div class="hof-name">${esc(p.name)}</div>
              <div class="hof-score ${under ? 'under' : ''}">${p.vs_par} · ${p.total_strokes} strokes · ${p.rounds_played} rounds</div>
            </div>`;
        }).join('')}
      </div>`).join('');
  } catch {
    document.getElementById('hall-of-fame').innerHTML =
      '<div class="state-msg">Could not load champions 🏌️</div>';
  }
}

// ─── Init ─────────────────────────────────────────────────
async function init() {
  await loadPlayers();
  try {
    const { puzzle_number, date } = await apiFetch('/api/today');
    S.todayPuzzle = puzzle_number;
    S.todayDate   = date;
    document.getElementById('puzzle-number').value = puzzle_number;
    document.getElementById('round-badge').textContent = `Round ${puzzle_number}`;
    updateHeaderDate(date);
  } catch {}
}

document.addEventListener('DOMContentLoaded', init);
