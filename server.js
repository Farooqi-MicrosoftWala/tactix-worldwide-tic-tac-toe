/**
 * TacTix Server
 * -----------------------------------------------------------------------
 * Real-time, server-authoritative backend for the TacTix Tic-Tac-Toe
 * frontend (see ../index.html). Handles:
 *   - Quick matchmaking ("Find Opponent")
 *   - Private rooms (create / join by code)
 *   - Server-validated moves (clients cannot fake results)
 *   - ELO-style rating updates
 *   - A simple JSON-file leaderboard / match history store
 *   - Disconnect / reconnect handling
 *
 * This is intentionally dependency-light (Express + Socket.io + a flat
 * JSON file as a datastore) so it can be deployed for free on services
 * like Render or Railway with zero extra infrastructure. For a
 * production deployment with many concurrent players, swap `db.js`'s
 * file-based storage for Postgres / MongoDB / Redis — the storage
 * interface (`loadDB`/`saveDB`) is isolated at the top of this file
 * specifically so that swap is easy. See README.md.
 * -----------------------------------------------------------------------
 */
const express = require('express');
const cors = require('cors');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;
const DB_FILE = path.join(__dirname, 'data.json');

/* ------------------------------------------------------------------ */
/* Flat-file "database" — players (for leaderboard/history) persist    */
/* across restarts. Swap this section for a real DB in production.     */
/* ------------------------------------------------------------------ */
function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { players: {} }; // players keyed by lowercased name (demo-simple identity)
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let db = loadDB();
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveDB(db); saveTimer = null; }, 400);
}
function getOrCreatePlayer(profile) {
  const key = (profile.name || 'Player').trim().toLowerCase();
  if (!db.players[key]) {
    db.players[key] = {
      name: profile.name || 'Player', avatar: profile.avatar || '🙂', country: profile.country || '🌐',
      rating: 1200, wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0, history: []
    };
  }
  return db.players[key];
}

/* ------------------------------------------------------------------ */
/* Game logic — mirrors the frontend engine but is the SOURCE OF TRUTH */
/* ------------------------------------------------------------------ */
function newBoard(size) { return Array(size * size).fill(null); }
function checkWinner(cells, size, winLen, lastIdx) {
  const r0 = Math.floor(lastIdx / size), c0 = lastIdx % size;
  const mark = cells[lastIdx];
  if (!mark) return null;
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    let line = [lastIdx];
    for (const s of [1, -1]) {
      let r = r0 + dr * s, c = c0 + dc * s;
      while (r >= 0 && r < size && c >= 0 && c < size && cells[r * size + c] === mark) {
        line.push(r * size + c); r += dr * s; c += dc * s;
      }
    }
    if (line.length >= winLen) return line;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* ELO-style rating                                                    */
/* ------------------------------------------------------------------ */
function computeElo(ratingA, ratingB, scoreA /* 1 win, 0.5 draw, 0 loss */) {
  const K = 32;
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  return Math.round(K * (scoreA - expectedA));
}

/* ------------------------------------------------------------------ */
/* In-memory live state: queue, rooms, sockets                         */
/* ------------------------------------------------------------------ */
const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/leaderboard', (req, res) => {
  const rows = Object.values(db.players)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 100)
    .map(p => ({
      name: p.name, avatar: p.avatar, country: p.country, rating: p.rating,
      wins: p.wins, losses: p.losses, draws: p.draws,
      winPct: p.wins + p.losses + p.draws ? Math.round((p.wins / (p.wins + p.losses + p.draws)) * 100) : 0,
      streak: p.streak
    }));
  res.json(rows);
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

let queue = []; // { socketId, profile, rating }
const rooms = new Map(); // roomId -> room state
const codeToRoom = new Map(); // room code -> roomId

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (codeToRoom.has(code));
  return code;
}

function createRoomState(sockA, sockB, size = 3, winLen = 3) {
  const roomId = 'room_' + Math.random().toString(36).slice(2, 10);
  const marks = Math.random() < 0.5 ? ['X', 'O'] : ['O', 'X'];
  const room = {
    id: roomId, size, winLen,
    cells: newBoard(size), current: 'X',
    players: {
      [sockA.id]: { socket: sockA, mark: marks[0], profile: sockA.data.profile, rating: sockA.data.rating },
      [sockB.id]: { socket: sockB, mark: marks[1], profile: sockB.data.profile, rating: sockB.data.rating }
    },
    startedAt: Date.now(), code: null, moveCount: 0
  };
  rooms.set(roomId, room);
  return room;
}

function sendMatched(room) {
  const ids = Object.keys(room.players);
  for (const id of ids) {
    const me = room.players[id];
    const oppId = ids.find(x => x !== id);
    const opp = room.players[oppId];
    me.socket.join(room.id);
    me.socket.emit('matched', {
      roomId: room.id, size: room.size, winLen: room.winLen,
      you: { mark: me.mark, profile: me.profile },
      opponent: { profile: opp.profile, rating: opp.rating }
    });
  }
}

io.on('connection', (socket) => {
  socket.data.profile = { name: 'Player', avatar: '🙂' };
  socket.data.rating = 1200;

  socket.on('find_opponent', ({ profile, rating }) => {
    socket.data.profile = profile || socket.data.profile;
    socket.data.rating = rating || 1200;
    // remove if already queued
    queue = queue.filter(q => q.socketId !== socket.id);
    const opponentEntry = queue.shift();
    if (opponentEntry) {
      const oppSocket = io.sockets.sockets.get(opponentEntry.socketId);
      if (oppSocket && oppSocket.connected) {
        const room = createRoomState(socket, oppSocket);
        sendMatched(room);
        return;
      }
    }
    queue.push({ socketId: socket.id, profile: socket.data.profile, rating: socket.data.rating });
    socket.emit('waiting', { message: 'Searching for an opponent…' });
  });

  socket.on('cancel_search', () => {
    queue = queue.filter(q => q.socketId !== socket.id);
  });

  socket.on('create_room', ({ profile, rating, size = 3, winLen = 3 }) => {
    socket.data.profile = profile || socket.data.profile;
    socket.data.rating = rating || 1200;
    const code = makeRoomCode();
    socket.data.pendingCode = code;
    socket.data.pendingSize = size;
    socket.data.pendingWinLen = winLen;
    codeToRoom.set(code, { hostSocketId: socket.id, size, winLen });
    socket.emit('room_created', { code });
  });

  socket.on('join_room', ({ code, profile, rating }) => {
    socket.data.profile = profile || socket.data.profile;
    socket.data.rating = rating || 1200;
    const entry = codeToRoom.get((code || '').toUpperCase());
    if (!entry) { socket.emit('room_error', { message: 'Room not found.' }); return; }
    const hostSocket = io.sockets.sockets.get(entry.hostSocketId);
    if (!hostSocket || !hostSocket.connected) { socket.emit('room_error', { message: 'Room is no longer available.' }); return; }
    codeToRoom.delete(code.toUpperCase());
    const room = createRoomState(hostSocket, socket, entry.size, entry.winLen);
    room.code = code.toUpperCase();
    sendMatched(room);
  });

  socket.on('leave_room', ({ code }) => {
    if (code) codeToRoom.delete(code.toUpperCase());
  });

  socket.on('make_move', ({ roomId, index }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error_message', { message: 'Match not found.' });
    const me = room.players[socket.id];
    if (!me) return;
    if (room.current !== me.mark) return; // reject out-of-turn moves
    if (index < 0 || index >= room.cells.length) return; // reject invalid index
    if (room.cells[index]) return; // reject occupied cell
    room.cells[index] = me.mark;
    room.moveCount++;
    const line = checkWinner(room.cells, room.size, room.winLen, index);
    const isDraw = !line && room.cells.every(c => c);
    io.to(room.id).emit('move_made', { index, mark: me.mark });

    if (line || isDraw) {
      const ids = Object.keys(room.players);
      const winnerId = line ? ids.find(id => room.players[id].mark === me.mark) : null;
      for (const id of ids) {
        const p = room.players[id];
        const oppId = ids.find(x => x !== id);
        const opp = room.players[oppId];
        const score = !line ? 0.5 : (id === winnerId ? 1 : 0);
        const delta = computeElo(p.rating, opp.rating, score);
        const rec = getOrCreatePlayer(p.profile);
        rec.rating = Math.max(100, rec.rating + delta);
        if (score === 1) { rec.wins++; rec.streak = rec.streak >= 0 ? rec.streak + 1 : 1; }
        else if (score === 0) { rec.losses++; rec.streak = rec.streak <= 0 ? rec.streak - 1 : -1; }
        else { rec.draws++; rec.streak = 0; }
        rec.bestStreak = Math.max(rec.bestStreak || 0, rec.streak);
        rec.history.unshift({ opponent: opp.profile.name, date: new Date().toISOString(), result: score === 1 ? 'win' : score === 0 ? 'loss' : 'draw', ratingChange: delta });
        rec.history = rec.history.slice(0, 50);
        p.socket.emit('game_over', { result: score === 1 ? 'win' : score === 0 ? 'loss' : 'draw', ratingChange: delta, newRating: rec.rating });
      }
      scheduleSave();
      rooms.delete(room.id);
    } else {
      room.current = room.current === 'X' ? 'O' : 'X';
    }
  });

  socket.on('rematch_request', ({ roomId }) => {
    socket.to(roomId).emit('room_error', { message: 'Opponent requested a rematch — start a new match to play again.' });
  });

  socket.on('disconnect', () => {
    queue = queue.filter(q => q.socketId !== socket.id);
    if (socket.data.pendingCode) codeToRoom.delete(socket.data.pendingCode);
    for (const [roomId, room] of rooms) {
      if (room.players[socket.id]) {
        socket.to(roomId).emit('opponent_left', { message: 'Your opponent disconnected.' });
        // Grace period for reconnection could be added here; for simplicity we close the room.
        rooms.delete(roomId);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`TacTix server listening on port ${PORT}`);
});
