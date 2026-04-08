const path = require('path');
const fs   = require('fs');

// Storage: a single JSON file. No npm packages, no compilation, works everywhere.
// On Railway: set DB_PATH=/data/scores.json and mount a Volume at /data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH  = process.env.DB_PATH  || path.join(DATA_DIR, 'scores.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
console.log(`[db] Using storage at: ${DB_PATH}`);

// ─── JSON read / write ────────────────────────────────────
function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { players: [], scores: [], playoffs: [], playoff_players: [] };
  }
}

function writeDB(data) {
  // Write to a temp file then rename for atomic replacement
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function nextId(arr) {
  return arr.length === 0 ? 1 : Math.max(...arr.map(x => x.id)) + 1;
}

// ─── Startup log ──────────────────────────────────────────
{
  const { players, scores } = readDB();
  console.log(`[db] Loaded — ${players.length} players, ${scores.length} scores`);
}

// ─── Helpers ──────────────────────────────────────────────
const WORDLE_EPOCH = new Date('2021-06-19T12:00:00Z').getTime();
const DAY_MS = 86400000;
const PAR = 4;

// Seasons: fixed 18-round blocks. Season 1 = puzzles 1754–1771, Season 2 = 1772–1789, …
const SEASON_EPOCH  = 1754;
const SEASON_LENGTH = 18;

function currentSeasonBounds(puzzleNum) {
  const idx   = Math.floor((puzzleNum - SEASON_EPOCH) / SEASON_LENGTH);
  const start = SEASON_EPOCH + idx * SEASON_LENGTH;
  return { start, end: start + SEASON_LENGTH - 1 };
}

function puzzleToDate(num) {
  return new Date(WORDLE_EPOCH + num * DAY_MS).toISOString().split('T')[0];
}

function dateToPuzzle(dateStr) {
  return Math.floor((new Date(dateStr + 'T12:00:00Z').getTime() - WORDLE_EPOCH) / DAY_MS);
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function getWeekBounds(dateStr) {
  const d     = new Date(dateStr + 'T12:00:00Z');
  const day   = d.getUTCDay();
  const toMon = day === 0 ? -6 : 1 - day;
  const mon   = new Date(d.getTime() + toMon * DAY_MS);
  const sun   = new Date(mon.getTime() + 6 * DAY_MS);
  const fmt   = x => x.toISOString().split('T')[0];
  return { start: fmt(mon), end: fmt(sun) };
}

function weekLabel(start, end) {
  const fmt = d => new Date(d + 'T12:00:00Z')
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}, ${end.slice(0, 4)}`;
}

function fmtVsPar(diff) {
  if (diff === 0) return 'E';
  return diff < 0 ? `${diff}` : `+${diff}`;
}

// Group scores by player_id → { total_strokes, rounds_played, ... }
function groupByPlayer(scores, players, extra = () => ({})) {
  const map = new Map();
  for (const s of scores) {
    if (!map.has(s.player_id)) {
      const p = players.find(pl => pl.id === s.player_id);
      map.set(s.player_id, { id: s.player_id, name: p?.name ?? 'Unknown', total_strokes: 0, rounds_played: 0 });
    }
    const e = map.get(s.player_id);
    e.total_strokes += s.strokes;
    e.rounds_played += 1;
    Object.assign(e, extra(e, s));
  }
  return [...map.values()];
}

// ─── Players ──────────────────────────────────────────────
function getPlayers() {
  const { players } = readDB();
  return [...players]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map(p => ({ id: p.id, name: p.name }));
}

function createOrGetPlayer(name) {
  const data = readDB();
  const existing = data.players.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (existing) return { id: existing.id, name: existing.name };
  const p = { id: nextId(data.players), name, created_at: new Date().toISOString() };
  data.players.push(p);
  writeDB(data);
  return { id: p.id, name: p.name };
}

// ─── Scores ───────────────────────────────────────────────
function submitScore(playerId, puzzleNumber, guesses, date) {
  const strokes   = guesses === 0 ? 7 : guesses;
  const scoreDate = date || puzzleToDate(puzzleNumber);
  const data      = readDB();
  if (data.scores.find(s => s.player_id === playerId && s.puzzle_number === puzzleNumber)) {
    throw new Error('UNIQUE constraint failed: scores already submitted for this round');
  }
  const score = {
    id: nextId(data.scores),
    player_id: playerId,
    puzzle_number: puzzleNumber,
    date: scoreDate,
    guesses,
    strokes,
    created_at: new Date().toISOString(),
  };
  data.scores.push(score);
  writeDB(data);
  return { playerId, puzzleNumber, date: scoreDate, guesses, strokes };
}

function getPlayerSeasonRounds(playerId, puzzleNum) {
  const { start, end } = currentSeasonBounds(puzzleNum);
  const { scores } = readDB();
  return scores.filter(s => s.player_id === playerId && s.puzzle_number >= start && s.puzzle_number <= end).length;
}

// ─── Daily leaderboard ────────────────────────────────────
function getDailyLeaderboard(date) {
  const { players, scores } = readDB();
  return scores
    .filter(s => s.date === date)
    .sort((a, b) => a.strokes - b.strokes || a.created_at.localeCompare(b.created_at))
    .map(s => {
      const p = players.find(pl => pl.id === s.player_id);
      return { id: s.id, name: p?.name ?? 'Unknown', guesses: s.guesses, strokes: s.strokes, puzzle_number: s.puzzle_number, date: s.date, vs_par: s.strokes - PAR };
    });
}

// ─── Season leaderboard ───────────────────────────────────
function getSeasonLeaderboard(puzzleNum) {
  const pNum = puzzleNum || dateToPuzzle(todayStr());
  const { start, end } = currentSeasonBounds(pNum);
  const { players, scores } = readDB();

  const seasonScores = scores.filter(s => s.puzzle_number >= start && s.puzzle_number <= end);
  const grouped = groupByPlayer(seasonScores, players);
  const rows = grouped
    .sort((a, b) => a.total_strokes - b.total_strokes || b.rounds_played - a.rounds_played)
    .map(r => ({
      ...r,
      avg_strokes:  r.rounds_played > 0 ? (r.total_strokes / r.rounds_played).toFixed(2) : null,
      vs_par:       r.total_strokes - r.rounds_played * PAR,
      season_vs_par: fmtVsPar(r.total_strokes - r.rounds_played * PAR),
    }));

  return {
    rows,
    season_start_puzzle: start,
    season_end_puzzle:   end,
    season_start_date:   puzzleToDate(start),
    season_end_date:     puzzleToDate(end),
  };
}

// ─── All-time leaderboard ─────────────────────────────────
function getAllTimeLeaderboard() {
  const { players, scores } = readDB();
  const map = new Map();
  for (const s of scores) {
    if (!map.has(s.player_id)) {
      const p = players.find(pl => pl.id === s.player_id);
      map.set(s.player_id, { id: s.player_id, name: p?.name ?? 'Unknown', total_strokes: 0, rounds_played: 0, best_round: null, penalty_rounds: 0 });
    }
    const e = map.get(s.player_id);
    e.total_strokes  += s.strokes;
    e.rounds_played  += 1;
    e.penalty_rounds += s.guesses === 0 ? 1 : 0;
    if (e.best_round === null || s.strokes < e.best_round) e.best_round = s.strokes;
  }
  return [...map.values()]
    .sort((a, b) => {
      const avgA = a.rounds_played > 0 ? a.total_strokes / a.rounds_played : Infinity;
      const avgB = b.rounds_played > 0 ? b.total_strokes / b.rounds_played : Infinity;
      return avgA - avgB || a.total_strokes - b.total_strokes;
    })
    .map(r => ({
      ...r,
      avg_strokes:  r.rounds_played > 0 ? (r.total_strokes / r.rounds_played).toFixed(2) : null,
      season_vs_par: fmtVsPar(r.total_strokes - r.rounds_played * PAR),
    }));
}

// ─── Player stats ─────────────────────────────────────────
function getPlayerStats(playerId) {
  const { players, scores } = readDB();
  const player = players.find(p => p.id === playerId);
  if (!player) return null;

  const ps = scores
    .filter(s => s.player_id === playerId)
    .sort((a, b) => a.puzzle_number - b.puzzle_number);

  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
  let totalStrokes = 0;
  for (const s of ps) { dist[s.strokes] = (dist[s.strokes] || 0) + 1; totalStrokes += s.strokes; }

  const total      = ps.length;
  const underPar   = ps.filter(s => s.strokes < PAR).length;
  const penalties  = ps.filter(s => s.guesses === 0).length;
  const bestRound  = total > 0 ? Math.min(...ps.map(s => s.strokes)) : null;
  const avgStrokes = total > 0 ? (totalStrokes / total).toFixed(2) : null;
  const handicap   = avgStrokes ? (parseFloat(avgStrokes) - PAR).toFixed(2) : null;
  const totalVsPar = totalStrokes - total * PAR;

  let curStreak = 0;
  for (let i = ps.length - 1; i >= 0; i--) {
    if (i < ps.length - 1 && ps[i].puzzle_number !== ps[i + 1].puzzle_number - 1) break;
    curStreak++;
  }
  let maxStreak = 0, streak = 0;
  ps.forEach((s, i) => {
    streak = (i === 0 || s.puzzle_number === ps[i - 1].puzzle_number + 1) ? streak + 1 : 1;
    maxStreak = Math.max(maxStreak, streak);
  });

  return {
    player:         { id: player.id, name: player.name },
    total,
    under_par:      underPar,
    penalties,
    best_round:     bestRound,
    avg_strokes:    avgStrokes,
    handicap,
    total_strokes:  totalStrokes,
    total_vs_par:   totalVsPar,
    season_vs_par:  fmtVsPar(totalVsPar),
    current_streak: curStreak,
    max_streak:     maxStreak,
    distribution:   dist,
  };
}

// ─── Group stats ──────────────────────────────────────────
function getGroupStats() {
  const { players, scores } = readDB();
  if (!scores.length) return { total_rounds: 0, group_avg: null, best_round: null, total_birdies: 0, top_birdie_player: null };

  const totalStrokes = scores.reduce((n, s) => n + s.strokes, 0);
  const groupAvg     = (totalStrokes / scores.length).toFixed(2);

  const best     = scores.reduce((b, s) => s.strokes < b.strokes || (s.strokes === b.strokes && s.created_at < b.created_at) ? s : b, scores[0]);
  const bestName = players.find(p => p.id === best.player_id)?.name ?? 'Unknown';

  const birdies   = scores.filter(s => s.strokes <= 2);
  const birdieMap = new Map();
  for (const s of birdies) birdieMap.set(s.player_id, (birdieMap.get(s.player_id) || 0) + 1);
  let topBirdie = null;
  if (birdieMap.size > 0) {
    const [topId, topCount] = [...birdieMap.entries()].sort((a, b) => b[1] - a[1])[0];
    topBirdie = { name: players.find(p => p.id === topId)?.name ?? 'Unknown', birdies: topCount };
  }

  return {
    total_rounds:      scores.length,
    group_avg:         groupAvg,
    best_round:        { strokes: best.strokes, puzzle: best.puzzle_number, name: bestName },
    total_birdies:     birdies.length,
    top_birdie_player: topBirdie,
  };
}

// ─── Season champions ─────────────────────────────────────
function getSeasonChampions() {
  const { players, scores } = readDB();
  const currentPuzzle = dateToPuzzle(todayStr());
  const champions = [];
  for (let idx = 0; idx < 200; idx++) {
    const start = SEASON_EPOCH + idx * SEASON_LENGTH;
    const end   = start + SEASON_LENGTH - 1;
    if (end >= currentPuzzle) break;
    const ss = scores.filter(s => s.puzzle_number >= start && s.puzzle_number <= end);
    if (!ss.length) { idx++; continue; }
    const grouped = groupByPlayer(ss, players)
      .sort((a, b) => a.total_strokes - b.total_strokes);
    const top = grouped[0].total_strokes;
    champions.push({
      season:       idx + 1,
      start_puzzle: start,
      end_puzzle:   end,
      start_date:   puzzleToDate(start),
      end_date:     puzzleToDate(end),
      winners: grouped.filter(r => r.total_strokes === top).map(r => ({
        name:          r.name,
        total_strokes: r.total_strokes,
        rounds_played: r.rounds_played,
        vs_par:        fmtVsPar(r.total_strokes - r.rounds_played * PAR),
      })),
    });
  }
  return champions.reverse();
}

// ─── Hall of Fame ─────────────────────────────────────────
function getHallOfFame() {
  const { players, scores } = readDB();
  const { start: thisWeekStart } = getWeekBounds(todayStr());

  const weekMap = new Map();
  for (const s of scores) {
    if (s.date >= thisWeekStart) continue;
    const b = getWeekBounds(s.date);
    if (!weekMap.has(b.start)) weekMap.set(b.start, b);
  }

  return [...weekMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([, bounds]) => {
      const ws = scores.filter(s => s.date >= bounds.start && s.date <= bounds.end);
      const podium = groupByPlayer(ws, players)
        .sort((a, b) => a.total_strokes - b.total_strokes)
        .slice(0, 3)
        .map(p => ({ ...p, vs_par: fmtVsPar(p.total_strokes - p.rounds_played * PAR) }));
      return podium.length ? { week_label: weekLabel(bounds.start, bounds.end), week_start: bounds.start, week_end: bounds.end, podium } : null;
    })
    .filter(Boolean);
}

// ─── Share text ───────────────────────────────────────────
function getShareText(date) {
  const entries   = getDailyLeaderboard(date);
  const puzzle    = dateToPuzzle(date);
  const dateLabel = new Date(date + 'T12:00:00Z')
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const medals    = ['🥇', '🥈', '🥉'];
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
function _playoffWithPlayers(playoff, data) {
  if (!playoff) return null;
  const pps = data.playoff_players
    .filter(pp => pp.playoff_id === playoff.id)
    .sort((a, b) => a.status.localeCompare(b.status) || (a.elim_date || '').localeCompare(b.elim_date || ''))
    .map(pp => ({ ...pp, name: data.players.find(p => p.id === pp.player_id)?.name ?? 'Unknown' }));
  return { ...playoff, players: pps };
}

function getActivePlayoff() {
  const data = readDB();
  return _playoffWithPlayers(data.playoffs.find(p => p.status === 'active') ?? null, data);
}

function getCompletedPlayoffs() {
  const data = readDB();
  return data.playoffs
    .filter(p => p.status === 'complete')
    .sort((a, b) => (b.ended_date || '').localeCompare(a.ended_date || ''))
    .map(p => _playoffWithPlayers(p, data));
}

function checkAndStartPlayoff() {
  const data = readDB();
  if (data.playoffs.find(p => p.status === 'active')) return null;

  const puzzleNum  = dateToPuzzle(todayStr());
  const { rows }   = getSeasonLeaderboard(puzzleNum);
  const complete   = rows.filter(r => r.rounds_played >= SEASON_LENGTH);
  if (complete.length < 2) return null;

  const topStrokes = complete[0].total_strokes;
  const tied       = complete.filter(r => r.total_strokes === topStrokes);
  if (tied.length < 2) return null;

  const pid = nextId(data.playoffs);
  data.playoffs.push({ id: pid, status: 'active', winner_id: null, started_date: todayStr(), ended_date: null, created_at: new Date().toISOString() });
  for (const p of tied) data.playoff_players.push({ playoff_id: pid, player_id: p.id, status: 'active', elim_date: null });
  writeDB(data);
  return getActivePlayoff();
}

function processPlayoffDay(date) {
  const data    = readDB();
  const playoff = data.playoffs.find(p => p.status === 'active');
  if (!playoff) return null;

  const activePPs = data.playoff_players.filter(pp => pp.playoff_id === playoff.id && pp.status === 'active');
  if (activePPs.length < 2) return null;

  const ids       = activePPs.map(pp => pp.player_id);
  const submitted = data.scores.filter(s => s.date === date && ids.includes(s.player_id));
  if (submitted.length < activePPs.length) return null;

  const minStrokes = Math.min(...submitted.map(s => s.strokes));
  const toElim     = submitted.filter(s => s.strokes > minStrokes);
  const survivors  = submitted.filter(s => s.strokes === minStrokes);

  for (const s of toElim) {
    const pp = data.playoff_players.find(x => x.playoff_id === playoff.id && x.player_id === s.player_id);
    if (pp) { pp.status = 'eliminated'; pp.elim_date = date; }
  }

  if (activePPs.length - toElim.length === 1) {
    const winner = survivors[0];
    const pp = data.playoff_players.find(x => x.playoff_id === playoff.id && x.player_id === winner.player_id);
    if (pp) pp.status = 'winner';
    playoff.status    = 'complete';
    playoff.winner_id = winner.player_id;
    playoff.ended_date = date;
  }

  writeDB(data);
  return _playoffWithPlayers(playoff, data);
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
  getAllTimeLeaderboard,
  getGroupStats,
  getSeasonChampions,
  getPlayerStats,
  getHallOfFame,
  getShareText,
  getActivePlayoff,
  getCompletedPlayoffs,
  checkAndStartPlayoff,
  processPlayoffDay,
};
