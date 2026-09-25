const path = require("path");
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const db = require("./db");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const api = express.Router();

// ---------- helpers ----------
// Students must never receive the correct answer index — only admins see it.
function shapeQuestion(row, { reveal = false } = {}) {
  if (!row) return null;
  const base = { id: row.id, q: row.question, code: row.code, opts: JSON.parse(row.options) };
  if (reveal) base.correct = row.correct_index;
  return base;
}
function shapeLive(row) {
  if (!row) return null;
  // Embed a sanitized question (no correct answer) so students never hit /questions.
  const qRow = row.question_id
    ? db.prepare("SELECT id, question, code, options FROM questions WHERE id = ?").get(row.question_id)
    : null;
  const out = {
    questionId: row.question_id,
    active: !!row.active,
    first: row.first_user,
    end: row.round_end,
    duration: row.duration,
    result: row.result ? JSON.parse(row.result) : null,
    question: qRow ? { id: qRow.id, q: qRow.question, code: qRow.code, opts: JSON.parse(qRow.options) } : null
  };
  // Once a round has a result it is public knowledge — everyone sees the right answer.
  if (out.result) {
    const q = db.prepare("SELECT correct_index FROM questions WHERE id = ?").get(row.question_id);
    out.result.correctIndex = q ? q.correct_index : null;
  }
  return out;
}
function getLive(roomId) {
  return shapeLive(db.prepare("SELECT * FROM live_state WHERE room_id = ?").get(roomId));
}
function broadcast(roomId, type, payload = {}) {
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN && ws.roomId === roomId) {
      ws.send(JSON.stringify({ type, ...payload }));
    }
  }
}
function pushState(roomId) {
  broadcast(roomId, "state", { live: getLive(roomId) });
}

// ---------- auth ----------
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "1234";
api.post("/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    return res.json({ ok: true, token: "admin-token" });
  }
  res.status(401).json({ ok: false, error: "Invalid username or password" });
});

// ---------- rooms ----------
api.get("/rooms", (req, res) => {
  res.json(db.prepare("SELECT id, name, created_at FROM rooms ORDER BY created_at").all());
});
api.post("/rooms", (req, res) => {
  const id = String(req.body.id || "").trim().toUpperCase();
  const name = String(req.body.name || "").trim() || "Live Quiz Room";
  if (!id) return res.status(400).json({ error: "Enter a room ID" });
  if (db.prepare("SELECT 1 FROM rooms WHERE id = ?").get(id)) {
    return res.status(409).json({ error: "Room already exists" });
  }
  db.prepare("INSERT INTO rooms (id, name) VALUES (?, ?)").run(id, name);
  db.prepare("INSERT INTO live_state (room_id) VALUES (?)").run(id);
  res.status(201).json({ id, name });
});
api.get("/rooms/:id/exists", (req, res) => {
  res.json({ exists: !!db.prepare("SELECT 1 FROM rooms WHERE id = ?").get(req.params.id.toUpperCase()) });
});

// ---------- questions ----------
api.get("/questions", (req, res) => {
  res.json(db.prepare("SELECT * FROM questions ORDER BY created_at").all().map(r => shapeQuestion(r, { reveal: true })));
});
api.post("/questions", (req, res) => {
  const { q, code = "", opts, correct } = req.body || {};
  if (!q || !Array.isArray(opts) || opts.length < 2) {
    return res.status(400).json({ error: "Enter question and at least 2 options" });
  }
  const ci = Number(correct);
  if (!Number.isInteger(ci) || ci < 0 || ci >= opts.length) {
    return res.status(400).json({ error: "Invalid correct option" });
  }
  const id = "Q" + Date.now();
  db.prepare("INSERT INTO questions (id, question, code, options, correct_index) VALUES (?, ?, ?, ?, ?)")
    .run(id, q, code, JSON.stringify(opts), ci);
  res.status(201).json(shapeQuestion(db.prepare("SELECT * FROM questions WHERE id = ?").get(id), { reveal: true }));
});

// ---------- queue ----------
api.get("/rooms/:id/queue", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const rows = db.prepare(
    `SELECT q.id, q.question, q.code, q.options, q.correct_index
     FROM queues qu JOIN questions q ON q.id = qu.question_id
     WHERE qu.room_id = ? ORDER BY qu.rowid`
  ).all(roomId);
  res.json(rows.map(r => shapeQuestion(r, { reveal: true })));
});
api.post("/rooms/:id/queue", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const { questionId } = req.body || {};
  if (!db.prepare("SELECT 1 FROM rooms WHERE id = ?").get(roomId)) return res.status(404).json({ error: "Room not found" });
  if (!db.prepare("SELECT 1 FROM questions WHERE id = ?").get(questionId)) return res.status(404).json({ error: "Question not found" });
  db.prepare("INSERT INTO queues (room_id, question_id) VALUES (?, ?)").run(roomId, questionId);
  res.status(201).json({ ok: true });
});
api.delete("/rooms/:id/queue/:index", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const idx = Number(req.params.index);
  const rows = db.prepare("SELECT rowid FROM queues WHERE room_id = ? ORDER BY rowid").all(roomId);
  if (!rows[idx]) return res.status(404).json({ error: "Queue item not found" });
  db.prepare("DELETE FROM queues WHERE rowid = ?").run(rows[idx].rowid);
  res.json({ ok: true });
});
api.delete("/rooms/:id/queue", (req, res) => {
  db.prepare("DELETE FROM queues WHERE room_id = ?").run(req.params.id.toUpperCase());
  res.json({ ok: true });
});

// ---------- users / leaderboard ----------
api.post("/rooms/:id/join", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Enter your name" });
  if (!db.prepare("SELECT 1 FROM rooms WHERE id = ?").get(roomId)) return res.status(404).json({ error: "Room not found" });
  const uid = `${name}@${roomId}`;
  const existing = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
  if (existing) {
    db.prepare("UPDATE users SET online = 1, last_seen = ? WHERE id = ?").run(Date.now(), uid);
  } else {
    db.prepare("INSERT INTO users (id, name, room_id, score, online, last_seen) VALUES (?, ?, ?, 0, 1, ?)")
      .run(uid, name, roomId, Date.now());
  }
  broadcast(roomId, "users");
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
  res.json({ name: user.name, room: user.room_id, score: user.score });
});
api.post("/rooms/:id/heartbeat", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const name = String(req.body.name || "").trim();
  db.prepare("UPDATE users SET online = 1, last_seen = ? WHERE id = ?").run(Date.now(), `${name}@${roomId}`);
  res.json({ ok: true });
});
// sweep users who vanished without leaving (closed tab, dropped connection)
setInterval(() => {
  db.prepare("UPDATE users SET online = 0 WHERE online = 1 AND last_seen < ?").run(Date.now() - 15000);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN && ws.roomId) broadcast(ws.roomId, "users");
  }
}, 10000);
api.post("/rooms/:id/leave", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const name = String(req.body.name || "").trim();
  db.prepare("UPDATE users SET online = 0 WHERE id = ?").run(`${name}@${roomId}`);
  broadcast(roomId, "users");
  res.json({ ok: true });
});
api.get("/rooms/:id/users", (req, res) => {
  res.json(db.prepare("SELECT name, score, online FROM users WHERE room_id = ? ORDER BY score DESC, name").all(req.params.id.toUpperCase()));
});

// ---------- live game ----------
api.get("/rooms/:id/live", (req, res) => {
  res.json({ live: getLive(req.params.id.toUpperCase()) });
});
api.post("/rooms/:id/push", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const next = db.prepare(
    `SELECT qu.question_id FROM queues qu WHERE qu.room_id = ? ORDER BY qu.rowid LIMIT 1`
  ).get(roomId);
  if (!next) return res.status(400).json({ error: "Add an MCQ to the queue first" });
  const q = db.prepare("SELECT id FROM questions WHERE id = ?").get(next.question_id);
  db.prepare("DELETE FROM queues WHERE rowid = (SELECT rowid FROM queues WHERE room_id = ? ORDER BY rowid LIMIT 1)").run(roomId);
  db.prepare(
    `INSERT INTO live_state (room_id, question_id, active, first_user, round_end, duration, result)
     VALUES (?, ?, 1, NULL, 0, 30, NULL)
     ON CONFLICT(room_id) DO UPDATE SET question_id = excluded.question_id, active = 1,
       first_user = NULL, round_end = 0, duration = 30, result = NULL`
  ).run(roomId, q.id);
  pushState(roomId);
  res.json({ live: getLive(roomId) });
});
api.post("/rooms/:id/unlock", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  db.prepare("UPDATE live_state SET active = 1, first_user = NULL, round_end = 0 WHERE room_id = ?").run(roomId);
  pushState(roomId);
  res.json({ live: getLive(roomId) });
});
api.post("/rooms/:id/reset", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  db.prepare("UPDATE live_state SET question_id = NULL, active = 0, first_user = NULL, round_end = 0, result = NULL WHERE room_id = ?").run(roomId);
  pushState(roomId);
  res.json({ ok: true });
});

// buzz: first user claims the buzzer (atomic via transaction)
api.post("/rooms/:id/buzz", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const name = String(req.body.name || "").trim();
  if (!name || !db.prepare("SELECT 1 FROM users WHERE id = ?").get(`${name}@${roomId}`)) {
    return res.status(403).json({ ok: false, error: "Join the room first" });
  }
  const tx = db.transaction(() => {
    const live = db.prepare("SELECT * FROM live_state WHERE room_id = ?").get(roomId);
    if (!live || !live.active || live.first_user) return { ok: false, error: "Buzzer already taken or closed" };
    db.prepare("UPDATE live_state SET first_user = ?, round_end = ? WHERE room_id = ?")
      .run(name, Date.now() + live.duration * 1000, roomId);
    return { ok: true };
  });
  const result = tx();
  if (!result.ok) return res.status(409).json(result);
  pushState(roomId);
  res.json(result);
});

// answer: only the buzzer winner may answer
api.post("/rooms/:id/answer", (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const name = String(req.body.name || "").trim();
  const answerIndex = Number(req.body.answerIndex);
  if (!name || !db.prepare("SELECT 1 FROM users WHERE id = ?").get(`${name}@${roomId}`)) {
    return res.status(403).json({ ok: false, error: "Join the room first" });
  }
  const tx = db.transaction(() => {
    const live = db.prepare("SELECT * FROM live_state WHERE room_id = ?").get(roomId);
    if (!live || !live.question_id) return { ok: false, error: "No live question" };
    if (live.first_user !== name) return { ok: false, error: "You must hit the buzzer first" };
    if (live.round_end && Date.now() > live.round_end) return { ok: false, error: "Time is up" };
    if (live.result) return { ok: false, error: "Already answered" };
    const q = db.prepare("SELECT * FROM questions WHERE id = ?").get(live.question_id);
    const opts = JSON.parse(q.options);
    const correct = answerIndex === q.correct_index;
    if (correct) db.prepare("UPDATE users SET score = score + 10 WHERE id = ?").run(`${name}@${roomId}`);
    db.prepare("UPDATE live_state SET result = ?, active = 0, round_end = 0 WHERE room_id = ?")
      .run(JSON.stringify({ user: name, answerIndex, answerText: opts[answerIndex], correct }), roomId);
    db.prepare("INSERT INTO answers (room_id, question_id, user_name, answer_index, correct, answered_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(roomId, q.id, name, answerIndex, correct ? 1 : 0, Date.now());
    return { ok: true, correct };
  });
  const result = tx();
  if (!result.ok) return res.status(409).json(result);
  pushState(roomId);
  broadcast(roomId, "users");
  res.json(result);
});

app.use("/api", api);
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// ---------- WebSocket: live sync per room ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  ws.roomId = (url.searchParams.get("room") || "").toUpperCase();
  ws.isAdmin = url.searchParams.get("admin") === "1";
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  if (ws.roomId && db.prepare("SELECT 1 FROM rooms WHERE id = ?").get(ws.roomId)) {
    ws.send(JSON.stringify({ type: "state", live: getLive(ws.roomId) }));
  }
});

// drop dead connections
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`CodeClash running → http://localhost:${PORT}`));
