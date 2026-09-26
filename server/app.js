const path = require("path");
const express = require("express");
const db = require("./db");

const app = express();
app.use(express.json());

// Static frontend in dev/local; on Vercel it is served directly from /public.
app.use(express.static(path.join(__dirname, "..", "public")));

const api = express.Router();

// Health first — answers even if the DB is unreachable, so any deployment can be
// diagnosed straight from the browser: {ok:true, dbStatus:"ok"} = fully working.
api.get("/health", async (req, res) => {
  let dbStatus = "ok";
  try { await db.ensureInit(); }
  catch (e) { dbStatus = "unreachable: " + (e && e.message ? e.message : "unknown"); }
  res.json({ ok: true, db: process.env.TURSO_DATABASE_URL ? "turso" : "local-file", dbStatus });
});

// Every other API request guarantees the schema exists (idempotent, cached per process).
api.use(async (req, res, next) => {
  try { await db.ensureInit(); next(); }
  catch (err) { console.error("db init failed:", err); res.status(500).json({ error: "Database unavailable" }); }
});

// ---------- helpers ----------
// Students must never receive the correct answer index while a round is live.
function shapeQuestion(row, { reveal = false } = {}) {
  if (!row) return null;
  const base = { id: row.id, q: row.question, code: row.code, opts: JSON.parse(row.options) };
  if (reveal) base.correct = row.correct_index;
  return base;
}
function shapeLive(row) {
  if (!row) return null;
  const out = {
    questionId: row.question_id,
    active: !!Number(row.active),
    first: row.first_user,
    end: Number(row.round_end),
    duration: Number(row.duration),
    result: row.result ? JSON.parse(row.result) : null,
    question: row.q_question
      ? { id: row.question_id, q: row.q_question, code: row.q_code, opts: JSON.parse(row.q_options) }
      : null
  };
  // Once a round has a result it is public knowledge — everyone sees the right answer.
  if (out.result && row.q_correct_index !== undefined && row.q_correct_index !== null) {
    out.result.correctIndex = Number(row.q_correct_index);
  }
  return out;
}
async function livePayload(roomId) {
  return shapeLive(await db.getLiveRow(roomId));
}
// One poll = everything a client needs to render: live round + leaderboard.
async function statePayload(roomId) {
  const [live, users] = await Promise.all([
    db.getLiveRow(roomId),
    db.listUsers(roomId)
  ]);
  return { live: shapeLive(live), users };
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
api.get("/rooms", async (req, res) => {
  res.json(await db.listRooms());
});
api.post("/rooms", async (req, res) => {
  const id = String(req.body.id || "").trim().toUpperCase();
  const name = String(req.body.name || "").trim() || "Live Quiz Room";
  if (!id) return res.status(400).json({ error: "Enter a room ID" });
  if (await db.roomExists(id)) return res.status(409).json({ error: "Room already exists" });
  await db.createRoom(id, name);
  res.status(201).json({ id, name });
});
api.get("/rooms/:id/exists", async (req, res) => {
  res.json({ exists: await db.roomExists(req.params.id.toUpperCase()) });
});

// ---------- questions ----------
api.get("/questions", async (req, res) => {
  res.json((await db.listQuestions()).map(r => shapeQuestion(r, { reveal: true })));
});
api.post("/questions", async (req, res) => {
  const { q, code = "", opts, correct } = req.body || {};
  if (!q || !Array.isArray(opts) || opts.length < 2) {
    return res.status(400).json({ error: "Enter question and at least 2 options" });
  }
  const ci = Number(correct);
  if (!Number.isInteger(ci) || ci < 0 || ci >= opts.length) {
    return res.status(400).json({ error: "Invalid correct option" });
  }
  const row = await db.createQuestion({ q, code, opts, correct: ci });
  res.status(201).json(shapeQuestion(row, { reveal: true }));
});

// ---------- queue ----------
api.get("/rooms/:id/queue", async (req, res) => {
  res.json((await db.getQueue(req.params.id.toUpperCase())).map(r => shapeQuestion(r, { reveal: true })));
});
api.post("/rooms/:id/queue", async (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const { questionId } = req.body || {};
  if (!(await db.roomExists(roomId))) return res.status(404).json({ error: "Room not found" });
  if (!(await db.getQuestion(questionId))) return res.status(404).json({ error: "Question not found" });
  await db.addToQueue(roomId, questionId);
  res.status(201).json({ ok: true });
});
api.delete("/rooms/:id/queue/:index", async (req, res) => {
  const ok = await db.removeQueueAt(req.params.id.toUpperCase(), Number(req.params.index));
  if (!ok) return res.status(404).json({ error: "Queue item not found" });
  res.json({ ok: true });
});
api.delete("/rooms/:id/queue", async (req, res) => {
  await db.clearQueue(req.params.id.toUpperCase());
  res.json({ ok: true });
});

// ---------- users / leaderboard ----------
api.post("/rooms/:id/join", async (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Enter your name" });
  if (!(await db.roomExists(roomId))) return res.status(404).json({ error: "Room not found" });
  const user = await db.joinUser(roomId, name);
  res.json({ name: user.name, room: user.room_id, score: user.score });
});
api.post("/rooms/:id/heartbeat", async (req, res) => {
  await db.touchUser(req.params.id.toUpperCase(), String(req.body.name || "").trim());
  res.json({ ok: true });
});
api.post("/rooms/:id/leave", async (req, res) => {
  await db.leaveUser(req.params.id.toUpperCase(), String(req.body.name || "").trim());
  res.json({ ok: true });
});
// Combined poll: live round + leaderboard for the room. Replaces WebSocket sync.
api.get("/rooms/:id/state", async (req, res) => {
  res.json(await statePayload(req.params.id.toUpperCase()));
});
api.get("/rooms/:id/live", async (req, res) => {
  res.json({ live: await livePayload(req.params.id.toUpperCase()) });
});

// ---------- live game ----------
api.post("/rooms/:id/push", async (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const qid = await db.popQueueHead(roomId);
  if (!qid) return res.status(400).json({ error: "Add an MCQ to the queue first" });
  await db.setLivePush(roomId, qid);
  res.json({ live: await livePayload(roomId) });
});
api.post("/rooms/:id/unlock", async (req, res) => {
  await db.setLiveUnlock(req.params.id.toUpperCase());
  res.json({ live: await livePayload(req.params.id.toUpperCase()) });
});
api.post("/rooms/:id/reset", async (req, res) => {
  await db.setLiveReset(req.params.id.toUpperCase());
  res.json({ ok: true });
});

// buzz: first user claims the buzzer (single-row conditional UPDATE = atomic)
api.post("/rooms/:id/buzz", async (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const name = String(req.body.name || "").trim();
  if (!name || !(await db.userExists(roomId, name))) {
    return res.status(403).json({ ok: false, error: "Join the room first" });
  }
  const result = await db.claimBuzzer(roomId, name);
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

// answer: only the buzzer winner may answer (single-row conditional UPDATE = atomic)
api.post("/rooms/:id/answer", async (req, res) => {
  const roomId = req.params.id.toUpperCase();
  const name = String(req.body.name || "").trim();
  const answerIndex = Number(req.body.answerIndex);
  if (!name || !(await db.userExists(roomId, name))) {
    return res.status(403).json({ ok: false, error: "Join the room first" });
  }
  const result = await db.submitAnswer({ roomId, name, answerIndex });
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

app.use("/api", api);
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Unexpected failures return JSON (never an HTML error page) and are logged.
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Server error: " + (err && err.message ? err.message : "unknown") });
});

module.exports = app;
