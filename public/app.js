/* ═══════════════════════════════════════════════════════════
   The Wordle Open — Frontend
   All dates are computed in the browser using LOCAL time.
   The server never decides what "today" is.
═══════════════════════════════════════════════════════════ */

// ─── Local date helpers (timezone-safe) ──────────────────
function localToday() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function localPuzzleNumber() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);                       // local midnight
  const epoch = new Date(2021, 5, 19);           // June 19 2021 local midnight
  return Math.floor((d - epoch) / 86400000);
}

function dateFromPuzzle(num) {
  const epoch = new Date(2021, 5, 19);
  const d = new Date(epoch.getTime() + num * 86400000);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function fmtLocalDate(dateStr) {
  // Parse as local date (avoids UTC-offset shift)
  const [y, m, day] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

// ─── State ────────────────────────────────────────────────
const S = {
  players:       [],
  todayDate:     localToday(),
  todayPuzzle:   localPuzzleNumber(),
  activeTab:     'today',
  activeSub:     'monthly',
  seasonLoaded:  false,
  monthlyLoaded: false,
  alltimeLoaded: false,
  fameLoaded:    false,
  dailyData:     [],
  seasonData:    null,
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
  return { 1:'⛳ Hole in One!', 2:'🦅 Eagle', 3:'🐦 Birdie',
           4:'Par', 5:'Bogey', 6:'Dbl Bogey', 7:'💀 Penalty' }[strokes] ?? strokes;
}
function fmtGuesses(g) { return g === 0 ? 'X/6' : `${g}/6`; }

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── API ──────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
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
  // Intentionally ignore server's today_date / puzzle_number — use local time only
  if (data.daily) {
    S.dailyData = data.daily;
    if (S.activeTab === 'today') renderDailyLeaderboard(data.daily);
  }
  if (data.season) {
    S.seasonData = data.season;
    if (S.activeTab === 'season') renderSeason(data.season);
  }
  renderPlayoffBanner(data.playoff ?? null);
});

function setLive(on) {
  const d = document.querySelector('.live-dot');
  if (d) d.style.background = on ? 'var(--gold)' : '#555';
}

function updateHeaderDate() {
  const el = document.getElementById('header-date');
  if (el) el.textContent = fmtLocalDate(S.todayDate) + ', ' + new Date().getFullYear();
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
    const p = await apiFetch('/api/players', { method: 'POST', body: JSON.stringify({ name }) });
    await loadPlayers();
    document.getElementById('player-select').value = p.id;
    input.value = '';
    document.getElementById('new-player-wrap').classList.add('hidden');
  } catch (e) { showFormMsg(e.message, 'error'); }
}

// ─── Wordle text parser (shared) ─────────────────────────
function parseWordleText(text) {
  const m = text.match(/Wordle\s+([\d,]+)\s+([1-6X])\/6/i);
  if (!m) return null;
  return {
    puzzleNum: parseInt(m[1].replace(/,/g, '')),
    guesses:   m[2].toUpperCase() === 'X' ? 0 : parseInt(m[2]),
  };
}

function applyDetectedScore(puzzleNum, guesses) {
  const strokes = guesses === 0 ? 7 : guesses;
  const vsPar   = strokes - 4;

  S.pastedPuzzle = puzzleNum;
  document.getElementById('puzzle-number').value  = puzzleNum;
  document.getElementById('result-select').value  = guesses;
  document.getElementById('round-badge').textContent = `Round ${puzzleNum}`;

  const dateStr = dateFromPuzzle(puzzleNum);
  const det = document.getElementById('paste-detection');
  det.innerHTML = `
    📋 Detected: <strong>${fmtLocalDate(dateStr)}</strong><br>
    ⛳ Round ${puzzleNum} · ${fmtGuesses(guesses)} · ${shotName(strokes)}
    <span style="color:${vsPar < 0 ? 'var(--red)' : 'var(--cream)'}">(${fmtVsPar(vsPar)})</span>
  `;
  det.classList.remove('hidden');

  // Clear manual paste textarea if it exists
  const manual = document.getElementById('manual-paste-input');
  if (manual) manual.value = '';
}

// ─── Clipboard paste ──────────────────────────────────────
document.getElementById('paste-btn').addEventListener('click', pasteWordle);

async function pasteWordle() {
  try {
    const text   = await navigator.clipboard.readText();
    const result = parseWordleText(text);
    if (!result) {
      showFormMsg('⛳ No Wordle score found in clipboard', 'error');
      return;
    }
    applyDetectedScore(result.puzzleNum, result.guesses);
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      showFormMsg('Allow clipboard access — copy your Wordle score first, then try again', 'error');
    } else {
      showFormMsg('Could not read clipboard', 'error');
    }
  }
}

// ─── Manual paste (fallback) ─────────────────────────────
document.getElementById('detect-manual-btn')?.addEventListener('click', () => {
  const text   = document.getElementById('manual-paste-input')?.value ?? '';
  const result = parseWordleText(text);
  if (!result) {
    showFormMsg('⛳ No Wordle score found — make sure to paste the full share text', 'error');
    return;
  }
  applyDetectedScore(result.puzzleNum, result.guesses);
  showFormMsg(`Detected Round ${result.puzzleNum} — ${fmtGuesses(result.guesses)} 🏌️`, 'success');
});

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
    showFormMsg(`Posted! ${fmtGuesses(guesses)} · ${shotName(strokes)} (${fmtVsPar(strokes - 4)}) 🏌️`, 'success');

    // Reset paste state
    S.pastedPuzzle = null;
    document.getElementById('paste-detection').classList.add('hidden');
    const manual = document.getElementById('manual-paste-input');
    if (manual) manual.value = '';
    document.getElementById('puzzle-number').value     = S.todayPuzzle;
    document.getElementById('round-badge').textContent = `Round ${S.todayPuzzle}`;

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
  document.getElementById('cele-name').textContent  = name;
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
    el.style.cssText = `left:${Math.random()*100}%;background:${colors[~~(Math.random()*colors.length)]};width:${6+Math.random()*8}px;height:${6+Math.random()*8}px;animation-duration:${1.5+Math.random()*2.5}s;animation-delay:${Math.random()*0.8}s`;
    wrap.appendChild(el);
  }
}

// ─── Daily leaderboard ────────────────────────────────────
function renderDailyLeaderboard(entries) {
  const el = document.getElementById('daily-leaderboard');
  if (!entries.length) {
    el.innerHTML = '<div class="state-msg">No scores yet today — first on the tee! ⛳</div>';
    return;
  }
  const medals = ['🥇','🥈','🥉'];
  let prev = null, rank = 0;
  el.innerHTML = entries.map((e, i) => {
    if (e.strokes !== prev) { rank = i + 1; prev = e.strokes; }
    const tied = i > 0 && e.strokes === entries[i-1].strokes;
    const pos  = tied ? `T${rank}` : `${rank}`;
    const vpd  = e.strokes - 4;
    return `
      <div class="sb-row ${i < 3 ? `r${i+1}` : ''}">
        <div class="sb-pos ${tied ? 'tied' : ''}">${medals[i] ?? pos}</div>
        <div>
          <div class="sb-name">${esc(e.name)}</div>
          <div class="sb-sub">${shotName(e.strokes)}</div>
        </div>
        <div class="sb-rounds">${fmtGuesses(e.guesses)}</div>
        <div class="sb-score ${parClass(vpd)}">${fmtVsPar(vpd)}<small>${e.strokes} strokes</small></div>
      </div>`;
  }).join('');
}

// ─── Share to WhatsApp ────────────────────────────────────
document.getElementById('share-btn').addEventListener('click', async () => {
  try {
    const { text } = await apiFetch(`/api/share/daily?date=${S.todayDate}`);
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  } catch { alert('Could not generate scorecard.'); }
});

// ─── Playoff banner ───────────────────────────────────────
function renderPlayoffBanner(playoff) {
  const el = document.getElementById('playoff-banner');
  if (!el) return;
  if (!playoff) { el.classList.add('hidden'); return; }

  const icons  = { active: '⚡', eliminated: '❌', winner: '🏆' };
  const isOver = playoff.status === 'complete';
  const active = playoff.players.filter(p => p.status === 'active');

  el.innerHTML = `
    <div class="playoff-banner">
      <div class="playoff-title">${isOver ? '🏆 PLAYOFF COMPLETE' : '⚡ SUDDEN DEATH PLAYOFF IN PROGRESS'}</div>
      <div class="playoff-players">
        ${playoff.players.map(p => `
          <div class="playoff-player ${p.status}">
            <div class="playoff-dot ${p.status}"></div>
            <span>${icons[p.status]} ${esc(p.name)}</span>
            ${p.status === 'eliminated'
              ? `<span class="playoff-elim-note">eliminated ${p.elim_date ?? ''}</span>`
              : p.status === 'winner'
              ? `<span class="playoff-elim-note">🏆 CHAMPION</span>`
              : `<span class="playoff-elim-note">still in</span>`}
          </div>`).join('')}
      </div>
      ${!isOver && active.length >= 2 ? `
        <div style="font-size:11px;color:var(--muted);margin-top:10px;text-align:center">
          Highest scorer each day is eliminated · ${active.length} golfer${active.length !== 1 ? 's' : ''} remain
        </div>` : ''}
    </div>`;
  el.classList.remove('hidden');
}

// ─── Season ───────────────────────────────────────────────
function loadSeason() {
  if (S.seasonData) renderSeason(S.seasonData);
  // Pass local date so season window is correct for player's timezone
  apiFetch(`/api/leaderboard/season?date=${S.todayDate}`)
    .then(data => { S.seasonData = data; renderSeason(data); })
    .catch(() => {});
  apiFetch('/api/playoff')
    .then(({ active }) => renderPlayoffBanner(active))
    .catch(() => {});
}

function renderSeason(data) {
  const { rows, season_start, season_end } = data;
  document.getElementById('season-range').textContent =
    `${fmtDateShort(season_start)} → ${fmtDateShort(season_end)}`;

  const pod = document.getElementById('season-podium');
  if (!rows.length) {
    pod.innerHTML = '<div class="state-msg">No rounds played this season yet ⛳</div>';
    document.getElementById('season-leaderboard').innerHTML = '';
    return;
  }

  const icons = ['🏆','🥈','🥉'], pos = ['p1','p2','p3'];
  pod.innerHTML = `<div class="podium-wrap">${rows.slice(0,3).map((r, i) => {
    const vpd  = parseFloat(r.avg_strokes) - 4;
    const vStr = fmtVsPar(Math.round(vpd * r.rounds_played));
    return `
      <div class="podium-slot ${pos[i]}">
        <div class="podium-icon">${icons[i]}</div>
        <div class="podium-name">${esc(r.name)}</div>
        <div class="podium-score ${parClass(vpd)}">${vStr}</div>
        <div class="podium-rounds">${r.rounds_played}/18 rounds</div>
        <div class="podium-block"></div>
      </div>`; }).join('')}</div>`;

  document.getElementById('season-leaderboard').innerHTML = rows.map((r, i) => {
    const vpd  = parseFloat(r.avg_strokes) - 4;
    const vStr = fmtVsPar(Math.round(vpd * r.rounds_played));
    const tied = i > 0 && r.avg_strokes === rows[i-1].avg_strokes;
    return `
      <div class="sb-row ${i < 3 ? `r${i+1}` : ''}">
        <div class="sb-pos ${tied ? 'tied' : ''}">${tied ? `T${i+1}` : i+1}</div>
        <div>
          <div class="sb-name">${esc(r.name)}</div>
          <div class="sb-sub">avg ${r.avg_strokes} · hdcp ${fmtVsPar(Math.round((parseFloat(r.avg_strokes)-4)*10)/10)}</div>
        </div>
        <div class="sb-rounds">${r.rounds_played}/18</div>
        <div class="sb-score ${parClass(vpd)}">${vStr}<small>total</small></div>
      </div>`; }).join('');
}

// ─── Scoreboard ───────────────────────────────────────────
function loadScorecard() {
  if (!S.monthlyLoaded) fetchMonthly();
}
async function fetchMonthly() {
  const month = S.todayDate.slice(0, 7); // local month
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
  if (!rows.length) { el.innerHTML = '<div class="state-msg">No rounds played yet ⛳</div>'; return; }
  el.innerHTML = rows.map((r, i) => {
    const vpd  = parseFloat(r.avg_strokes) - 4;
    const vStr = fmtVsPar(r.total_strokes - r.rounds_played * 4);
    const tied = i > 0 && r.avg_strokes === rows[i-1].avg_strokes;
    return `
      <div class="sb-row ${i < 3 ? `r${i+1}` : ''}">
        <div class="sb-pos ${tied ? 'tied' : ''}">${tied ? `T${i+1}` : i+1}</div>
        <div>
          <div class="sb-name">${esc(r.name)}</div>
          <div class="sb-sub">${r.rounds_played} rounds · best ${r.best_round ?? '—'}</div>
        </div>
        <div class="sb-rounds">avg ${r.avg_strokes ?? '—'}</div>
        <div class="sb-score ${parClass(vpd)}">${vStr}<small>${r.total_strokes} total</small></div>
      </div>`; }).join('');
}

document.querySelectorAll('.sub-tab').forEach(b => {
  b.addEventListener('click', () => {
    if (b.dataset.sub === 'alltime'  && !S.alltimeLoaded) fetchAlltime();
    if (b.dataset.sub === 'monthly'  && !S.monthlyLoaded) fetchMonthly();
  });
});

// ─── Player Stats ─────────────────────────────────────────
document.getElementById('stats-player-select').addEventListener('change', function() {
  if (this.value) loadStats(parseInt(this.value));
  else document.getElementById('player-stats').classList.add('hidden');
});

async function loadStats(id) {
  try {
    const s = await apiFetch(`/api/players/${id}/stats`);
    document.getElementById('player-stats').classList.remove('hidden');
    const hcpNum = parseFloat(s.handicap ?? 0);
    document.getElementById('st-rounds').textContent   = s.total;
    document.getElementById('st-handicap').textContent =
      s.handicap !== null ? (hcpNum >= 0 ? `+${s.handicap}` : s.handicap) : '—';
    document.getElementById('st-best').textContent   = s.best_round ? `${s.best_round} ⛳` : '—';
    document.getElementById('st-under').textContent  = s.under_par;
    document.getElementById('st-streak').textContent = s.current_streak;
    document.getElementById('st-vspar').textContent  = s.season_vs_par;
    document.getElementById('st-handicap').classList.toggle('under', hcpNum < 0);
    renderDist(s.distribution, s.total);
  } catch { document.getElementById('player-stats').classList.add('hidden'); }
}

function renderDist(dist) {
  const el = document.getElementById('guess-dist');
  const bars = [
    { key:'1', label:'⛳ Hole in One', cls:'eagle'   },
    { key:'2', label:'🦅 Eagle',       cls:'eagle'   },
    { key:'3', label:'🐦 Birdie',      cls:'birdie'  },
    { key:'4', label:'Par',            cls:'par'     },
    { key:'5', label:'Bogey',          cls:'bogey'   },
    { key:'6', label:'Dbl Bogey',      cls:'double'  },
    { key:'7', label:'💀 Penalty',     cls:'penalty' },
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
      </div>`; }).join('');
}

// ─── Hall of Fame ─────────────────────────────────────────
async function loadFame() {
  S.fameLoaded = true;
  try {
    const weeks = await apiFetch('/api/hall-of-fame');
    const el = document.getElementById('hall-of-fame');
    if (!weeks.length) {
      el.innerHTML = '<div class="state-msg">No completed weeks yet — keep playing! ⛳</div>';
      return;
    }
    const medals = ['🏆','🥈','🥉'];
    el.innerHTML = weeks.map(w => `
      <div class="hof-card">
        <div class="hof-week">🗓️ ${esc(w.week_label)}</div>
        ${w.podium.map((p, i) => `
          <div class="hof-entry">
            <div class="hof-medal">${medals[i] ?? `${i+1}.`}</div>
            <div class="hof-name">${esc(p.name)}</div>
            <div class="hof-score ${p.vs_par.startsWith('-') ? 'under' : ''}">${p.vs_par} · ${p.total_strokes} strokes · ${p.rounds_played} rounds</div>
          </div>`).join('')}
      </div>`).join('');
  } catch {
    document.getElementById('hall-of-fame').innerHTML =
      '<div class="state-msg">Could not load champions 🏌️</div>';
  }
}

// ─── Init ─────────────────────────────────────────────────
async function init() {
  // Dates computed locally — never wait for server
  S.todayDate   = localToday();
  S.todayPuzzle = localPuzzleNumber();
  document.getElementById('puzzle-number').value     = S.todayPuzzle;
  document.getElementById('round-badge').textContent = `Round ${S.todayPuzzle}`;
  updateHeaderDate();

  await loadPlayers();

  // Load today's leaderboard with local date
  apiFetch(`/api/leaderboard/daily?date=${S.todayDate}`)
    .then(entries => { S.dailyData = entries; renderDailyLeaderboard(entries); })
    .catch(() => {});
}

document.addEventListener('DOMContentLoaded', init);
