# TacTix — Worldwide Tic-Tac-Toe

A production-style Tic-Tac-Toe platform with Local 2-Player, an AI opponent
(Easy / Medium / unbeatable Minimax Hard), and real-time Online Worldwide
multiplayer with matchmaking, private rooms, ELO ratings, and a leaderboard.

## Project structure

```
tictactoe/
├── index.html          ← the entire frontend (open this file / host it anywhere)
├── README.md            ← this file
└── backend/
    ├── server.js         ← Socket.io real-time server (matchmaking, rooms, ELO)
    ├── package.json
    └── data.json          ← auto-created flat-file store (players, ratings, history)
```

The frontend and backend are fully separate. `index.html` works completely
on its own for **Local 2 Player** and **Play Against AI** — no server, no
build step, no dependencies. **Online Worldwide** additionally needs the
backend running somewhere reachable over the internet (or on `localhost`
for local testing).

---

## 1. Running the frontend

Just open `index.html` in a browser, or host it as a static file anywhere
(GitHub Pages, Netlify, Vercel, S3, nginx, etc. — it's a single file with
no build step).

```bash
# quickest local preview
npx serve .
# then open the printed http://localhost:xxxx address
```

### Testing Local 2 Player
1. From the home screen, choose **👥 Local 2 Player**.
2. Set both players' names, marks, and avatars, pick a board size /
   timer / best-of, then **Start Match**.
3. Play by tapping cells — turns alternate on the same device.

### Testing AI mode
1. Choose **🤖 Play Against AI**.
2. Pick **Easy**, **Medium**, or **Hard**.
   - Easy: mostly random moves.
   - Medium: blocks your wins and takes its own when available, otherwise
     plays positionally.
   - Hard: full Minimax with alpha-beta pruning on 3×3 (provably
     unbeatable — best you can do is draw); depth-limited minimax with a
     positional heuristic on 4×4/5×5 boards for performance.
3. Confirm it behaves differently at each difficulty — Hard should never
   lose on a 3×3 board.

---

## 2. Running the backend (required for Online Worldwide)

The backend is a small Node.js + Express + Socket.io service. It is the
**source of truth** for every online match:

- It rejects moves that are out of turn, out of bounds, or on an occupied
  cell — the client cannot fake a result.
- It performs matchmaking (`Find Opponent`) and private rooms
  (`Create Room` / `Join Room` by 6-character code).
- It computes ELO-style rating changes and keeps a leaderboard.
- Match results and ratings persist to `backend/data.json` (a flat-file
  store, so the demo needs zero external database setup). Swap this for
  Postgres/MongoDB/Redis for a production deployment with real user
  accounts — the storage calls are isolated at the top of `server.js`
  (`loadDB` / `saveDB` / `getOrCreatePlayer`) specifically so that swap
  is a small, contained change.

### Local setup

```bash
cd backend
npm install
npm start
# TacTix server listening on port 3001
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | Port the server listens on. Most hosts (Render, Railway, Heroku) set this automatically. |

No API keys or secrets are required for the demo backend, so nothing
needs to be kept out of the frontend. If you add authentication (see
"Extending" below), keep any provider secret keys **only** in backend
environment variables — never in `index.html` or any frontend code.

### Deploying the backend (example: Render.com, free tier)

1. Push the `backend/` folder to a GitHub repo (or the whole project —
   Render can build from a subdirectory).
2. On Render: **New → Web Service** → connect the repo.
   - Root directory: `backend`
   - Build command: `npm install`
   - Start command: `npm start`
3. Deploy. Render gives you a URL like
   `https://tactix-server.onrender.com`.
4. Open the frontend, go to **Settings → Multiplayer Server**, paste that
   URL, and click **Connect**.

Railway, Fly.io, or any Node-capable host work the same way — install,
start with `npm start`, expose the port, and point the frontend at the
resulting URL. A `wss://` (secure WebSocket) URL is required once the
frontend itself is served over HTTPS.

### Testing Online Worldwide

1. Start the backend locally (`npm start` in `backend/`).
2. Open `index.html` in **two separate browser tabs or two devices**.
3. In Settings on both, connect to `http://localhost:3001` (or your
   deployed URL).
4. In tab A: **Online Worldwide → Find Opponent** (or **Create Room** and
   share the code).
5. In tab B: **Online Worldwide → Find Opponent** (or **Join Room** with
   the code from tab A).
6. Confirm moves sync instantly in both tabs, turn order is enforced,
   the winner/draw is announced identically on both sides, and rating
   changes appear on the result screen.
7. Close one tab mid-match to confirm the other tab receives an
   "opponent disconnected" notice.

---

## 3. Feature notes

- **Board sizes**: 3×3 (3 in a row), 4×4 and 5×5 (4 in a row), all using
  the same win-detection routine on both client and server.
- **Themes**: Classic (with Dark/Light), Neon, and Glassmorphism, saved
  to `localStorage`.
- **Sound**: synthesized on the fly with the Web Audio API — no audio
  files to ship, and nothing plays before the first user interaction.
- **Stats & history**: stored per-device in `localStorage` for Local/AI
  play; online results are additionally recorded server-side against
  your player name for the shared leaderboard (`GET /leaderboard`).
- **Accessibility**: every interactive control is a real `<button>` with
  visible focus outlines, board cells carry `aria-label`s describing
  their state, and game status is never communicated by color alone
  (status text + shapes accompany every color cue).

## 4. Extending toward production

This ships as a strong, honestly-scoped foundation rather than a fake
"everything works" demo. To take it further:

- **Accounts**: add an auth provider (e.g. email/password or OAuth) in
  the backend, issue a session token, and key players by that ID instead
  of by display name.
- **Reconnection grace period**: `server.js` currently closes a room
  immediately on disconnect; add a short timer that lets a dropped
  player rejoin the same `roomId` before forfeiting.
- **Real database**: replace the flat-file store with Postgres or
  MongoDB for concurrent-write safety at scale.
- **Anti-abuse**: rate-limit `find_opponent`/`create_room` per socket and
  validate `profile.name` length/content server-side.
