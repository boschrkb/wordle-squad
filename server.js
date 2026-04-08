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
  const today = db.getTodayDate();
  io.emit('update', {
    daily:         db.getDailyLeaderboard(today),
    season:        db.getSeasonLeaderboard(),
    puzzle_number: db.getTodayPuzzleNumber(),
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
    const score = db.submitScore(Number(player_id), Number(puzzle_number), g);
    const today = db.getTodayDate();
    const seasonRounds = db.getPlayerSeasonRounds(Number(player_id), today);
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

app.get('/api/leaderboard/season', (_req, res) => {
  res.json(db.getSeasonLeaderboard());
});

app.get('/api/leaderboard/monthly', (req, res) => {
  const month = req.query.month || db.getTodayDate().slice(0, 7);
  res.json(db.getMonthlyLeaderboard(month));
});

app.get('/api/leaderboard/alltime', (_req, res) => {
  res.json(db.getAllTimeLeaderboard());
});

// ── Stats ─────────────────────────────────────────────────

app.get('/api/players/:id/stats', (req, res) => {
  const stats = db.getPlayerStats(parseInt(req.params.id));
  if (!stats) return res.status(404).json({ error: 'Player not found' });
  res.json(stats);
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
  const today = db.getTodayDate();
  socket.emit('update', {
    daily:         db.getDailyLeaderboard(today),
    season:        db.getSeasonLeaderboard(),
    puzzle_number: db.getTodayPuzzleNumber(),
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
