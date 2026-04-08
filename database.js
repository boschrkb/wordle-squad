// Uses Node 22+ built-in SQLite (no native compilation needed)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

// DB lives in ./data/ — survives restarts, git pulls, and npm installs.
// Override with DB_PATH env var for cloud deployments with a persistent volume.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH  = process.env.DB_PATH  || path.join(DATA_DIR, 'wordle-open.db');

// Create data directory if it doesn't exist (never drops existing data)
fs.mkdirSync(DATA_DIR, { recursive: true });

console.log(`[db] Using database at: ${DB_PATH}`);
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE NOT NULL COLLATE NOCASE,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scores (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id     INTEGER NOT NULL,
    puzzle_number INTEGER NOT NULL,
    date          TEXT    NOT NULL,
    guesses       INTEGER NOT NULL CHECK(guesses >= 0 AND guesses <= 6),
    strokes       INTEGER NOT NULL,  -- golf: 1-6 for solved, 7 for X (penalty stroke)
    created_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (player_id) REFERENCES players(id),
    UNIQUE(player_id, puzzle_number)
  );

  CREATE INDEX IF NOT EXISTS idx_scores_date   ON scores(date);
  CREATE INDEX IF NOT EXISTS idx_scores_player ON scores(player_id);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS playoffs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    status       TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'complete'
    winner_id    INTEGER,
    started_date TEXT NOT NULL,
    ended_date   TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS playoff_players (
    playoff_id INTEGER NOT NULL,
    player_id  INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'eliminated' | 'winner'
    elim_date  TEXT,
    PRIMARY KEY (playoff_id, player_id),
    FOREIGN KEY (playoff_id) REFERENCES playoffs(id),
    FOREIGN KEY (player_id)  REFERENCES players(id)
  );
`);

// ─── Helpers ──────────────────────────────────────────────
const WORDLE_EPOCH = new Date('2021-06-19T12:00:00Z').getTime();
const DAY_MS = 86400000;
const PAR = 4;

function puzzleToDate(num) {
  return new Date(WORDLE_EPOCH + (num - 1) * DAY_MS).toISOString().split('T')[0];
}

function dateToPuzzle(dateStr) {
  return Math.floor((new Date(dateStr + 'T12:00:00Z').getTime() - WORDLE_EPOCH) / DAY_MS) + 1;
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function seasonStart(dateStr) {
  const d = new Date((dateStr || todayStr()) + 'T12:00:00Z');
  return new Date(d.getTime() - 17 * DAY_MS).toISOString().split('T')[0];
}

function getWeekBounds(dateStr) {
  const d   = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay();
  const toMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(d.getTime() + toMon * DAY_MS);
  const sun = new Date(mon.getTime() + 6 * DAY_MS);
  const fmt = x => x.toISOString().split('T')[0];
  return { start: fmt(mon), end: fmt(sun) };
}

function weekLabel(start, end) {
  const fmt = d => new Date(d + 'T12:00:00Z')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}, ${end.slice(0, 4)}`;
}

function vsPar(strokes, rounds) {
  return strokes - rounds * PAR;
}

function fmtVsPar(diff) {
  if (diff === 0) return 'E';
  return diff < 0 ? `${diff}` : `+${diff}`;
}

// ─── Players ──────────────────────────────────────────────
function getPlayers() {
  return db.prepare('SELECT id, name FROM players ORDER BY name COLLATE NOCASE').all();
}

function createOrGetPlayer(name) {
  let p = db.prepare('SELECT id, name FROM players WHERE name = ?').get(name);
  if (!p) {
    const r = db.prepare('INSERT INTO players (name) VALUES (?)').run(name);
    p = { id: r.lastInsertRowid, name };
  }
  return p;
}

// ─── Scores ───────────────────────────────────────────────
function submitScore(playerId, puzzleNumber, guesses, date) {
  // Golf: strokes = guesses (1-6), or 7 for X (penalty stroke)
  const strokes = guesses === 0 ? 7 : guesses;
  // Prefer the client-supplied local date; fall back to server UTC derivation
  const scoreDate = date || puzzleToDate(puzzleNumber);
  db.prepare(
    'INSERT INTO scores (player_id, puzzle_number, date, guesses, strokes) VALUES (?,?,?,?,?)'
  ).run(playerId, puzzleNumber, scoreDate, guesses, strokes);
  return { playerId, puzzleNumber, date: scoreDate, guesses, strokes };
}

function getPlayerSeasonRounds(playerId, dateStr) {
  const start = seasonStart(dateStr);
  const end   = dateStr || todayStr();
  const row = db.prepare(
    'SELECT COUNT(*) AS cnt FROM scores WHERE player_id = ? AND date BETWEEN ? AND ?'
  ).get(playerId, start, end);
  return row ? row.cnt : 0;
}

// ─── Daily leaderboard ────────────────────────────────────
function getDailyLeaderboard(date) {
  const rows = db.prepare(`
    SELECT p.id, p.name, s.guesses, s.strokes, s.puzzle_number, s.date
    FROM   scores s JOIN players p ON p.id = s.player_id
    WHERE  s.date = ?
    ORDER  BY s.strokes ASC, s.created_at ASC
  `).all(date);
  // Add vs-par
  return rows.map(r => ({ ...r, vs_par: r.strokes - PAR }));
}

// ─── Season leaderboard (18-day rolling) ──────────────────
function getSeasonLeaderboard(dateStr) {
  const today = dateStr || todayStr();
  const start = seasonStart(today);
  const rows = db.prepare(`
    SELECT p.id, p.name,
           SUM(s.strokes)  AS total_strokes,
           COUNT(s.id)     AS rounds_played,
           ROUND(AVG(CAST(s.strokes AS REAL)), 2) AS avg_strokes
    FROM   scores s JOIN players p ON p.id = s.player_id
    WHERE  s.date BETWEEN ? AND ?
    GROUP  BY p.id, p.name
    ORDER  BY avg_strokes ASC, total_strokes ASC
  `).all(start, today);
  return {
    rows: rows.map(r => ({
      ...r,
      vs_par: Math.round((r.avg_strokes - PAR) * r.rounds_played),
      season_vs_par: fmtVsPar(Math.round((r.avg_strokes - PAR) * r.rounds_played)),
    })),
    season_start: start,
    season_end:   today,
  };
}

// ─── Monthly leaderboard ──────────────────────────────────
function getMonthlyLeaderboard(month) {
  const rows = db.prepare(`
    SELECT p.id, p.name,
           SUM(s.strokes)  AS total_strokes,
           COUNT(s.id)     AS rounds_played,
           ROUND(AVG(CAST(s.strokes AS REAL)), 2) AS avg_strokes,
           MIN(s.strokes)  AS best_round
    FROM   scores s JOIN players p ON p.id = s.player_id
    WHERE  strftime('%Y-%m', s.date) = ?
    GROUP  BY p.id, p.name
    ORDER  BY avg_strokes ASC, total_strokes ASC
  `).all(month);
  return rows.map(r => ({
    ...r,
    season_vs_par: fmtVsPar(r.total_strokes - r.rounds_played * PAR),
  }));
}

// ─── All-time leaderboard ─────────────────────────────────
function getAllTimeLeaderboard() {
  const rows = db.prepare(`
    SELECT p.id, p.name,
           SUM(s.strokes)  AS total_strokes,
           COUNT(s.id)     AS rounds_played,
           ROUND(AVG(CAST(s.strokes AS REAL)), 2) AS avg_strokes,
           MIN(s.strokes)  AS best_round,
           SUM(CASE WHEN s.guesses = 0 THEN 1 ELSE 0 END) AS penalty_rounds
    FROM   scores s JOIN players p ON p.id = s.player_id
    GROUP  BY p.id, p.name
    ORDER  BY avg_strokes ASC, total_strokes ASC
  `).all();
  return rows.map(r => ({
    ...r,
    season_vs_par: fmtVsPar(r.total_strokes - r.rounds_played * PAR),
  }));
}

// ─── Player stats ─────────────────────────────────────────
function getPlayerStats(playerId) {
  const player = db.prepare('SELECT id, name FROM players WHERE id = ?').get(playerId);
  if (!player) return null;

  const scores = db.prepare(
    'SELECT * FROM scores WHERE player_id = ? ORDER BY puzzle_number ASC'
  ).all(playerId);

  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 }; // 7 = X/6
  let totalStrokes = 0;
  scores.forEach(s => {
    dist[s.strokes] = (dist[s.strokes] || 0) + 1;
    totalStrokes += s.strokes;
  });

  const total       = scores.length;
  const underPar    = scores.filter(s => s.strokes < PAR).length;
  const penalties   = scores.filter(s => s.guesses === 0).length;
  const bestRound   = total > 0 ? Math.min(...scores.map(s => s.strokes)) : null;
  const avgStrokes  = total > 0 ? (totalStrokes / total).toFixed(2) : null;
  const handicap    = avgStrokes ? (parseFloat(avgStrokes) - PAR).toFixed(2) : null;
  const totalVsPar  = totalStrokes - total * PAR;

  // Current streak (consecutive rounds played, any score)
  let curStreak = 0;
  for (let i = scores.length - 1; i >= 0; i--) {
    if (i < scores.length - 1 && scores[i].puzzle_number !== scores[i + 1].puzzle_number - 1) break;
    curStreak++;
  }

  // Max streak
  let maxStreak = 0, streak = 0;
  scores.forEach((s, i) => {
    const consec = i === 0 || s.puzzle_number === scores[i - 1].puzzle_number + 1;
    streak = consec ? streak + 1 : 1;
    maxStreak = Math.max(maxStreak, streak);
  });

  return {
    player,
    total,
    under_par:    underPar,
    penalties,
    best_round:   bestRound,
    avg_strokes:  avgStrokes,
    handicap,
    total_strokes: totalStrokes,
    total_vs_par: totalVsPar,
    season_vs_par: fmtVsPar(totalVsPar),
    current_streak: curStreak,
    max_streak:     maxStreak,
    distribution:   dist,
  };
}

// ─── Hall of Fame ─────────────────────────────────────────
function getHallOfFame() {
  const { start: thisWeekStart } = getWeekBounds(todayStr());

  const dates = db
    .prepare('SELECT DISTINCT date FROM scores WHERE date < ? ORDER BY date ASC')
    .all(thisWeekStart)
    .map(r => r.date);

  const weekMap = new Map();
  for (const date of dates) {
    const b = getWeekBounds(date);
    if (!weekMap.has(b.start)) weekMap.set(b.start, b);
  }

  const results = [];
  const sortedWeeks = [...weekMap.entries()].sort((a, b) => b[0].localeCompare(a[0]));

  for (const [, bounds] of sortedWeeks) {
    const podium = db.prepare(`
      SELECT p.id, p.name,
             SUM(s.strokes)  AS total_strokes,
             COUNT(s.id)     AS rounds_played
      FROM   scores s JOIN players p ON p.id = s.player_id
      WHERE  s.date BETWEEN ? AND ?
      GROUP  BY p.id, p.name
      ORDER  BY total_strokes ASC
      LIMIT  3
    `).all(bounds.start, bounds.end);

    if (podium.length > 0) {
      results.push({
        week_label: weekLabel(bounds.start, bounds.end),
        week_start: bounds.start,
        week_end:   bounds.end,
        podium: podium.map(p => ({
          ...p,
          vs_par: fmtVsPar(p.total_strokes - p.rounds_played * PAR),
        })),
      });
    }
  }
  return results;
}

// ─── Share text ───────────────────────────────────────────
function getShareText(date) {
  const entries  = getDailyLeaderboard(date);
  const puzzle   = dateToPuzzle(date);
  const dateLabel = new Date(date + 'T12:00:00Z')
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const medals   = ['🥇', '🥈', '🥉'];

  let text = `⛳ The Wordle Open — Round ${puzzle}\n${dateLabel}\n🏌️ Today's Scorecard:\n\n`;
  entries.forEach((e, i) => {
    const result  = e.guesses === 0 ? 'X/6' : `${e.guesses}/6`;
    const parDisp = e.vs_par === 0 ? 'E' : e.vs_par < 0 ? `${e.vs_par}` : `+${e.vs_par}`;
    text += `${medals[i] ?? `${i + 1}.`} ${e.name} — ${result} (${parDisp})\n`;
  });
  if (!entries.length) text += 'No scores yet — first one on the tee! ⛳\n';
  text += `\n🔗 wordle-open.local`;
  return text;
}

// ─── Playoffs ─────────────────────────────────────────────

function getActivePlayoff() {
  const p = db.prepare("SELECT * FROM playoffs WHERE status = 'active' LIMIT 1").get();
  if (!p) return null;
  const players = db.prepare(`
    SELECT pp.player_id, pp.status, pp.elim_date, pl.name
    FROM   playoff_players pp JOIN players pl ON pl.id = pp.player_id
    WHERE  pp.playoff_id = ?
    ORDER  BY pp.status ASC, pp.elim_date ASC
  `).all(p.id);
  return { ...p, players };
}

function getCompletedPlayoffs() {
  const list = db.prepare("SELECT * FROM playoffs WHERE status = 'complete' ORDER BY ended_date DESC").all();
  return list.map(p => {
    const players = db.prepare(`
      SELECT pp.player_id, pp.status, pp.elim_date, pl.name
      FROM   playoff_players pp JOIN players pl ON pl.id = pp.player_id
      WHERE  pp.playoff_id = ?
      ORDER  BY pp.status ASC, pp.elim_date ASC
    `).all(p.id);
    return { ...p, players };
  });
}

function checkAndStartPlayoff() {
  // Don't start if one is already active
  if (db.prepare("SELECT id FROM playoffs WHERE status = 'active' LIMIT 1").get()) return null;

  const { rows } = getSeasonLeaderboard();
  // Require players to have completed the full 18-round season
  const complete = rows.filter(r => r.rounds_played >= 18);
  if (complete.length < 2) return null;

  // Compare avg_strokes rounded to 2dp (as stored)
  const topAvg = Math.round(parseFloat(complete[0].avg_strokes) * 100);
  const tied   = complete.filter(r => Math.round(parseFloat(r.avg_strokes) * 100) === topAvg);
  if (tied.length < 2) return null;

  const today = todayStr();
  const { lastInsertRowid: pid } = db.prepare(
    "INSERT INTO playoffs (started_date) VALUES (?)"
  ).run(today);

  for (const p of tied) {
    db.prepare("INSERT INTO playoff_players (playoff_id, player_id) VALUES (?,?)").run(pid, p.id);
  }

  return getActivePlayoff();
}

function processPlayoffDay(date) {
  const playoff = getActivePlayoff();
  if (!playoff) return null;

  const active = playoff.players.filter(p => p.status === 'active');
  if (active.length < 2) return null; // already resolved

  // Check all active players have posted today
  const ids       = active.map(p => p.player_id).join(',');
  const submitted = db.prepare(
    `SELECT player_id, strokes FROM scores WHERE date = ? AND player_id IN (${ids})`
  ).all(date);

  if (submitted.length < active.length) return null; // waiting on someone

  const minStrokes = Math.min(...submitted.map(s => s.strokes));
  const toElim     = submitted.filter(s => s.strokes > minStrokes);
  const survivors  = submitted.filter(s => s.strokes === minStrokes);

  for (const p of toElim) {
    db.prepare(`
      UPDATE playoff_players SET status = 'eliminated', elim_date = ?
      WHERE  playoff_id = ? AND player_id = ?
    `).run(date, playoff.id, p.player_id);
  }

  const remaining = active.length - toElim.length;

  // Playoff resolved: one survivor OR two tied players who must continue
  if (remaining === 1) {
    const winner = survivors[0];
    db.prepare(
      "UPDATE playoff_players SET status = 'winner' WHERE playoff_id = ? AND player_id = ?"
    ).run(playoff.id, winner.player_id);
    db.prepare(
      "UPDATE playoffs SET status = 'complete', winner_id = ?, ended_date = ? WHERE id = ?"
    ).run(winner.player_id, date, playoff.id);
  }

  return getActivePlayoff();
}

module.exports = {
  getPlayers,
  createOrGetPlayer,
  submitScore,
  getPlayerSeasonRounds,
  getTodayPuzzleNumber: () => dateToPuzzle(todayStr()),
  getTodayDate:         todayStr,
  getPuzzleNumberForDate: dateToPuzzle,
  getDateForPuzzle:     puzzleToDate,
  getDailyLeaderboard,
  getSeasonLeaderboard,
  getMonthlyLeaderboard,
  getAllTimeLeaderboard,
  getPlayerStats,
  getHallOfFame,
  getShareText,
  getActivePlayoff,
  getCompletedPlayoffs,
  checkAndStartPlayoff,
  processPlayoffDay,
};
