# CodeClash — Full-Stack Live Quiz Platform

The original single-file HTML quiz, upgraded to a real **frontend + backend + database** stack — and deployable to **Vercel** (serverless) or runnable locally.

## Stack
| Layer | Tech |
|---|---|
| Frontend | Vanilla HTML/CSS/JS served from `public/` (same cyber-tech design) |
| Backend | Node.js + Express REST API (`server/app.js`), also exported as a Vercel serverless function (`api/index.js`) |
| Live sync | 1.5s polling of `/api/rooms/:id/state` (serverless platforms don't support WebSockets) |
| Database | SQLite via `@libsql/client` — **local file** in dev, **Turso cloud DB** in production |

## Run locally
```bash
npm install
npm start        # → http://localhost:3000
```
No setup needed: a SQLite file database is created and seeded automatically at `data/codeclash.db`.

## Deploy on Vercel (with Turso)
The app is serverless-ready, but the database must live in the cloud (a file DB would reset between requests). Turso has a free tier.

1. **Create the Turso database** ([turso.tech](https://turso.tech), free account):
   ```bash
   turso db create codeclash
   turso db show codeclash --url        # → TURSO_DATABASE_URL
   turso db tokens create codeclash     # → TURSO_AUTH_TOKEN
   ```
2. **Push this repo to GitHub** (already done if you followed the earlier steps).
3. **Import the repo on Vercel** ([vercel.com/new](https://vercel.com/new)) — framework preset **Other**, no build command.
4. **Add environment variables** in Vercel → Project → Settings → Environment Variables:
   | Name | Value |
   |---|---|
   | `TURSO_DATABASE_URL` | the `libsql://...` URL from step 1 |
   | `TURSO_AUTH_TOKEN` | the token from step 1 |
5. **Deploy.** The schema and demo rooms (`TECH101`, `CS2026`) are created automatically on the first API request.

> **Note on Vercel:** everything works — rooms, questions, queue, buzzer race (atomic), scoring, leaderboard. The only difference from local: live updates arrive via 1.5s polling instead of instant WebSocket pushes.

## Admin
Default login: `admin` / `1234`. After login you choose a room — create a new one or re-enter an existing room ID.

## API overview
All endpoints live under `/api`:

- `POST /login` — admin auth
- `GET /rooms` · `POST /rooms` · `GET /rooms/:id/exists`
- `GET /questions` · `POST /questions`
- `GET/POST /rooms/:id/queue` · `DELETE /rooms/:id/queue[/:index]`
- `POST /rooms/:id/join|heartbeat|leave` · `GET /rooms/:id/users`
- `GET /rooms/:id/state` — combined live-round + leaderboard poll
- `GET /rooms/:id/live`
- `POST /rooms/:id/push|unlock|reset|buzz|answer`

Every answer is logged in the `answers` table for future analytics.

## Project layout
```
├── public/index.html     ← Frontend (API + polling client)
├── server/app.js         ← Express app (all REST routes)
├── server/db.js          ← Data layer (libSQL: local file or Turso)
├── server/index.js       ← Local dev entry (`npm start`)
├── api/index.js          ← Vercel serverless entry
├── vercel.json           ← Routes all requests to the function (static files served first)
└── CodeClash-Tech-Interactive.html  ← the original standalone file, kept for reference
```
