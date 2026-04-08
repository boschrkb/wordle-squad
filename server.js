const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const db       = require('./database');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function broadcast() {
  const today  = db.getTodayDate();
  const puzzle = db.getTodayPuzzleNumber();
  io.emit('update', {
    daily:         db.getDailyLeaderboard(today),
    season:        db.getSeasonLeaderboard(puzzle),
    playoff:       db.getActivePlayoff(),
    puzzle_number: puzzle,
    today_date:    today,
  });
}

// ── Players ───────────────────────────────────────────────

app.get('/api/players', (_req, res) => {
  res.json(db.getPlayers());
});

app.post('/api/players', (req, res) => {
  const name = req.body?.name?.trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    res.json(db.createOrGetPlayer(name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Scores ────────────────────────────────────────────────

app.post('/api/scores', (req, res) => {
  const { player_id, puzzle_number, guesses } = req.body ?? {};
  if (player_id == null || puzzle_number == null || guesses == null) {
    return res.status(400).json({ error: 'player_id, puzzle_number and guesses are required' });
  }
  const g = Number(guesses);
  if (!Number.isInteger(g) || g < 0 || g > 6) {
    return res.status(400).json({ error: 'guesses must be 0–6 (0 = X/6)' });
  }
  try {
    // Use the date the browser sent (local time) — never recompute from UTC server clock
    const clientDate   = typeof req.body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date)
                         ? req.body.date : null;
    const score        = db.submitScore(Number(player_id), Number(puzzle_number), g, clientDate);
    const seasonRounds = db.getPlayerSeasonRounds(Number(player_id), Number(puzzle_number));

    // Playoff: check if season just completed with a tie, then resolve today's playoff day
    db.checkAndStartPlayoff();
    db.processPlayoffDay(score.date);

    broadcast();
    res.json({ ...score, completed_18th: seasonRounds === 18 });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Score already posted for this round' });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── Leaderboards ──────────────────────────────────────────

app.get('/api/leaderboard/daily', (req, res) => {
  const date = req.query.date || db.getTodayDate();
  res.json(db.getDailyLeaderboard(date));
});

app.get('/api/leaderboard/season', (req, res) => {
  const puzzle = req.query.puzzle ? Number(req.query.puzzle) : db.getTodayPuzzleNumber();
  res.json(db.getSeasonLeaderboard(puzzle));
});

app.get('/api/leaderboard/alltime', (_req, res) => {
  res.json(db.getAllTimeLeaderboard());
});

// ── Group stats & Season champions ────────────────────────

app.get('/api/stats/group', (_req, res) => {
  res.json(db.getGroupStats());
});

app.get('/api/seasons/champions', (_req, res) => {
  res.json(db.getSeasonChampions());
});

// ── Stats ─────────────────────────────────────────────────

app.get('/api/players/:id/stats', (req, res) => {
  const stats = db.getPlayerStats(parseInt(req.params.id));
  if (!stats) return res.status(404).json({ error: 'Player not found' });
  res.json(stats);
});

// ── Playoffs ──────────────────────────────────────────────

app.get('/api/playoff', (_req, res) => {
  res.json({
    active:    db.getActivePlayoff(),
    completed: db.getCompletedPlayoffs(),
  });
});

// ── Hall of Fame ──────────────────────────────────────────

app.get('/api/hall-of-fame', (_req, res) => {
  res.json(db.getHallOfFame());
});

// ── Share text ────────────────────────────────────────────

app.get('/api/share/daily', (req, res) => {
  const date = req.query.date || db.getTodayDate();
  res.json({ text: db.getShareText(date) });
});

// ── Meta ──────────────────────────────────────────────────

app.get('/api/today', (_req, res) => {
  res.json({
    puzzle_number: db.getTodayPuzzleNumber(),
    date: db.getTodayDate(),
  });
});

// ── Socket.IO ─────────────────────────────────────────────

io.on('connection', socket => {
  const today  = db.getTodayDate();
  const puzzle = db.getTodayPuzzleNumber();
  socket.emit('update', {
    daily:         db.getDailyLeaderboard(today),
    season:        db.getSeasonLeaderboard(puzzle),
    puzzle_number: puzzle,
    today_date:    today,
  });
});

// ── Start ─────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
⛳  The Wordle Open is live!
👉  http://localhost:${PORT}
`);
});
