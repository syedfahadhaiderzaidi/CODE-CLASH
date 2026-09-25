# CodeClash — Full-Stack Live Quiz Platform

The original single-file HTML quiz, upgraded to a real **frontend + backend + database** stack.

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla HTML/CSS/JS served from `public/` (same cyber-tech design) |
| Backend | Node.js + Express REST API + WebSocket (`ws`) for live buzzer sync |
| Database | SQLite via `better-sqlite3`, file at `data/codeclash.db` |

## Run

```bash
npm install
npm start        # → http://localhost:3000
npm run dev      # same, with auto-reload on server changes
```

Set `PORT` to change the port: `PORT=4000 npm start`

## Try it

- **Student:** open the app → *Continue as Student* → room `TECH101`, any name → *Try Demo Room*
- **Admin:** *Admin Login* → username `admin`, password `1234` → select a room → *Push MCQ Live*
- Open a second browser window as another student to see the buzzer race live.

## Architecture

```
public/index.html   ← frontend (original design, now API-driven)
server/index.js     ← Express REST API + WebSocket server
server/db.js        ← SQLite schema + seed data
data/codeclash.db   ← the database (created on first run)
```

Tables: `rooms`, `questions`, `queues`, `users`, `live_state`, `answers`.
Answers are also logged to `answers` for future analytics/exports.

## API

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/login` | Admin login (`admin` / `1234`) |
| GET/POST | `/api/rooms` | List / create rooms |
| GET | `/api/rooms/:id/exists` | Room existence check |
| GET/POST | `/api/questions` | List / create MCQs |
| GET/POST | `/api/rooms/:id/queue` | View / append to queue |
| DELETE | `/api/rooms/:id/queue[/:index]` | Clear / remove queue item |
| POST | `/api/rooms/:id/join` | Student joins a room |
| POST | `/api/rooms/:id/heartbeat` · `/leave` | Presence tracking |
| GET | `/api/rooms/:id/users` | Leaderboard |
| GET | `/api/rooms/:id/live` | Current live state |
| POST | `/api/rooms/:id/push` · `/unlock` · `/reset` | Admin round controls |
| POST | `/api/rooms/:id/buzz` · `/answer` | Student gameplay |
| WS | `/ws?room=ID` | Live state + leaderboard push |

## Notes

- Buzzer and answer endpoints are transactional — two students hitting *BUZZ* at the
  same millisecond cannot both win, and non-joined users are rejected (403).
- Students never receive the correct answer while a round is live; it is only
  revealed once someone has answered.
- The old localStorage client is preserved (commented out) at the bottom of
  `public/index.html` for reference; the original standalone file is untouched.
