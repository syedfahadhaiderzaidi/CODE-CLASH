const path = require("path");
const fs = require("fs");
const { createClient } = require("@libsql/client");

// ---- connection ------------------------------------------------------------
// Local dev: a plain file database at data/codeclash.db (created automatically).
// Serverless (Vercel): set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) to a Turso DB.
const localFile = path.join(__dirname, "..", "data", "codeclash.db");
const isLocal = !process.env.TURSO_DATABASE_URL;
const client = createClient({
  url: process.env.TURSO_DATABASE_URL || ("file:" + localFile),
  authToken: process.env.TURSO_AUTH_TOKEN || undefined
});
if (isLocal) fs.mkdirSync(path.dirname(localFile), { recursive: true });

// ---- schema ----------------------------------------------------------------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id            TEXT PRIMARY KEY,
  question      TEXT NOT NULL,
  code          TEXT NOT NULL DEFAULT '',
  options       TEXT NOT NULL, -- JSON array of option strings
  correct_index INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS queues (
  room_id     TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  added_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_queues_room ON queues(room_id);

CREATE TABLE IF NOT EXISTS users (
  id        TEXT PRIMARY KEY, -- "name@ROOM"
  name      TEXT NOT NULL,
  room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  score     INTEGER NOT NULL DEFAULT 0,
  online    INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_users_room ON users(room_id);

CREATE TABLE IF NOT EXISTS live_state (
  room_id     TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  question_id TEXT,
  active      INTEGER NOT NULL DEFAULT 0,
  first_user  TEXT,
  round_end   INTEGER NOT NULL DEFAULT 0, -- epoch ms
  duration    INTEGER NOT NULL DEFAULT 30,
  result      TEXT -- JSON {user, answerIndex, answerText, correct} or NULL
);

CREATE TABLE IF NOT EXISTS answers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id      TEXT NOT NULL,
  question_id  TEXT NOT NULL,
  user_name    TEXT NOT NULL,
  answer_index INTEGER NOT NULL,
  correct      INTEGER NOT NULL,
  answered_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_answers_room ON answers(room_id, question_id);
`;

// ---- init / seed (runs once per process) ------------------------------------
let initPromise = null;
async function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      await client.executeMultiple(SCHEMA);
      await seed();
    })().catch(err => { initPromise = null; throw err; });
  }
  return initPromise;
}

async function seed() {
  // Idempotent demo data, mirroring the original localStorage demo.
  const n = (await client.execute("SELECT COUNT(*) AS n FROM rooms")).rows[0].n;
  if (Number(n) > 0) return;
  const samples = [
    { id: "DEMO1", q: "Which language is primarily used to structure a web page?", code: "", opts: ["CSS", "HTML", "Python", "SQL"], correct: 1 },
    { id: "DEMO2", q: "What does CPU stand for?", code: "", opts: ["Central Processing Unit", "Computer Personal Unit", "Core Program Utility", "Central Program User"], correct: 0 },
    { id: "DEMO3", q: "What is the output of this C++ code?", code: "int x = 5;\ncout << x + 2;", opts: ["5", "7", "52", "Error"], correct: 1 },
    { id: "DEMO4", q: "Which symbol is used for a single-line comment in C++?", code: "", opts: ["//", "/*", "##", "<!--"], correct: 0 }
  ];
  const now = Date.now();
  await client.batch([
    { sql: "INSERT OR IGNORE INTO rooms (id, name) VALUES (?, ?)", args: ["TECH101", "Web Development Demo"] },
    { sql: "INSERT OR IGNORE INTO rooms (id, name) VALUES (?, ?)", args: ["CS2026", "C++ Fundamentals Demo"] },
    ...samples.map(s => ({ sql: "INSERT OR IGNORE INTO questions (id, question, code, options, correct_index) VALUES (?, ?, ?, ?, ?)", args: [s.id, s.q, s.code, JSON.stringify(s.opts), s.correct] })),
    ...["DEMO1", "DEMO2", "DEMO3", "DEMO4"].map(qid => ({ sql: "INSERT OR IGNORE INTO queues (room_id, question_id, added_at) VALUES (?, ?, ?)", args: ["TECH101", qid, now] })),
    { sql: "INSERT OR IGNORE INTO users (id, name, room_id, score, online, last_seen) VALUES (?, ?, ?, 20, 0, 0)", args: ["DemoA@TECH101", "DemoA", "TECH101"] },
    { sql: "INSERT OR IGNORE INTO users (id, name, room_id, score, online, last_seen) VALUES (?, ?, ?, 10, 0, 0)", args: ["DemoB@TECH101", "DemoB", "TECH101"] },
    { sql: "INSERT OR IGNORE INTO users (id, name, room_id, score, online, last_seen) VALUES (?, ?, ?, 0, 0, 0)", args: ["DemoC@TECH101", "DemoC", "TECH101"] },
    { sql: "INSERT OR IGNORE INTO live_state (room_id) VALUES (?)", args: ["TECH101"] },
    { sql: "INSERT OR IGNORE INTO live_state (room_id) VALUES (?)", args: ["CS2026"] }
  ], "write");
}

// ---- rooms -------------------------------------------------------------------
async function listRooms() {
  return (await client.execute("SELECT id, name, created_at FROM rooms ORDER BY created_at")).rows;
}
async function roomExists(id) {
  const r = await client.execute({ sql: "SELECT 1 AS x FROM rooms WHERE id = ?", args: [id] });
  return r.rows.length > 0;
}
async function createRoom(id, name) {
  await client.batch([
    { sql: "INSERT INTO rooms (id, name) VALUES (?, ?)", args: [id, name] },
    { sql: "INSERT INTO live_state (room_id) VALUES (?)", args: [id] }
  ], "write");
}

// ---- questions ----------------------------------------------------------------
async function listQuestions() {
  return (await client.execute("SELECT * FROM questions ORDER BY created_at")).rows;
}
async function getQuestion(id) {
  return (await client.execute({ sql: "SELECT * FROM questions WHERE id = ?", args: [id] })).rows[0] || null;
}
async function createQuestion({ q, code, opts, correct }) {
  const id = "Q" + Date.now();
  await client.execute(
    "INSERT INTO questions (id, question, code, options, correct_index) VALUES (?, ?, ?, ?, ?)",
    [id, q, code, JSON.stringify(opts), correct]
  );
  return getQuestion(id);
}

// ---- queue ---------------------------------------------------------------------
async function getQueue(roomId) {
  return (await client.execute(
    `SELECT q.id, q.question, q.code, q.options, q.correct_index
     FROM queues qu JOIN questions q ON q.id = qu.question_id
     WHERE qu.room_id = ? ORDER BY qu.rowid`, [roomId]
  )).rows;
}
async function addToQueue(roomId, questionId) {
  await client.execute(
    "INSERT INTO queues (room_id, question_id, added_at) VALUES (?, ?, ?)",
    [roomId, questionId, Date.now()]
  );
}
async function removeQueueAt(roomId, idx) {
  const rows = (await client.execute(
    { sql: "SELECT rowid AS rid FROM queues WHERE room_id = ? ORDER BY rowid", args: [roomId] }
  )).rows;
  if (!rows[idx]) return false;
  await client.execute({ sql: "DELETE FROM queues WHERE rowid = ?", args: [Number(rows[idx].rid)] });
  return true;
}
async function clearQueue(roomId) {
  await client.execute({ sql: "DELETE FROM queues WHERE room_id = ?", args: [roomId] });
}
async function popQueueHead(roomId) {
  const head = (await client.execute(
    { sql: "SELECT rowid AS rid, question_id FROM queues WHERE room_id = ? ORDER BY rowid LIMIT 1", args: [roomId] }
  )).rows[0];
  if (!head) return null;
  await client.execute({ sql: "DELETE FROM queues WHERE rowid = ?", args: [Number(head.rid)] });
  return head.question_id;
}

// ---- users ----------------------------------------------------------------------
const ONLINE_WINDOW_MS = 15000;
async function joinUser(roomId, name) {
  const uid = `${name}@${roomId}`;
  await client.execute(
    `INSERT INTO users (id, name, room_id, score, online, last_seen)
     VALUES (?, ?, ?, 0, 1, ?)
     ON CONFLICT(id) DO UPDATE SET online = 1, last_seen = excluded.last_seen`,
    [uid, name, roomId, Date.now()]
  );
  return (await client.execute(
    { sql: "SELECT name, room_id, score FROM users WHERE id = ?", args: [uid] }
  )).rows[0];
}
async function touchUser(roomId, name) {
  await client.execute(
    { sql: "UPDATE users SET online = 1, last_seen = ? WHERE id = ?", args: [Date.now(), `${name}@${roomId}`] }
  );
}
async function leaveUser(roomId, name) {
  await client.execute(
    { sql: "UPDATE users SET online = 0 WHERE id = ?", args: [`${name}@${roomId}`] }
  );
}
async function userExists(roomId, name) {
  const r = await client.execute(
    { sql: "SELECT 1 AS x FROM users WHERE id = ?", args: [`${name}@${roomId}`] }
  );
  return r.rows.length > 0;
}
async function listUsers(roomId) {
  return (await client.execute(
    { sql: `SELECT name, score,
                   CASE WHEN last_seen >= ? THEN 1 ELSE 0 END AS online
            FROM users WHERE room_id = ?
            ORDER BY score DESC, name`, args: [Date.now() - ONLINE_WINDOW_MS, roomId] }
  )).rows;
}

// ---- live state -------------------------------------------------------------------
// Row joined with its question so students get a sanitized copy in one query.
const LIVE_JOIN = `
  SELECT l.*, q.question AS q_question, q.code AS q_code,
         q.options AS q_options, q.correct_index AS q_correct_index
  FROM live_state l LEFT JOIN questions q ON q.id = l.question_id
  WHERE l.room_id = ?`;
async function getLiveRow(roomId) {
  return (await client.execute({ sql: LIVE_JOIN, args: [roomId] })).rows[0] || null;
}
async function setLivePush(roomId, questionId) {
  await client.execute(
    `INSERT INTO live_state (room_id, question_id, active, first_user, round_end, duration, result)
     VALUES (?, ?, 1, NULL, 0, 30, NULL)
     ON CONFLICT(room_id) DO UPDATE SET question_id = excluded.question_id, active = 1,
       first_user = NULL, round_end = 0, duration = 30, result = NULL`,
    [roomId, questionId]
  );
}
async function setLiveUnlock(roomId) {
  // Re-opens the buzzer; a recorded result stays until Reset or the next Push.
  await client.execute(
    { sql: "UPDATE live_state SET active = 1, first_user = NULL, round_end = 0 WHERE room_id = ?", args: [roomId] }
  );
}
async function setLiveReset(roomId) {
  await client.execute(
    { sql: "UPDATE live_state SET question_id = NULL, active = 0, first_user = NULL, round_end = 0, result = NULL WHERE room_id = ?", args: [roomId] }
  );
}

// Atomic buzzer claim: the conditional UPDATE guarantees a single winner even if
// two students hit the endpoint in the same instant (second write matches 0 rows).
async function claimBuzzer(roomId, name) {
  const live = (await client.execute(
    { sql: "SELECT * FROM live_state WHERE room_id = ?", args: [roomId] }
  )).rows[0];
  if (!live || !Number(live.active)) return { ok: false, error: "Buzzer is closed" };
  if (live.first_user) return { ok: false, error: "Buzzer already taken" };
  const r = await client.execute(
    { sql: `UPDATE live_state SET first_user = ?, round_end = ?
            WHERE room_id = ? AND active = 1 AND (first_user IS NULL OR first_user = '')`,
      args: [name, Date.now() + (Number(live.duration) || 30) * 1000, roomId] }
  );
  return r.rowsAffected ? { ok: true } : { ok: false, error: "Buzzer already taken" };
}

// Atomic answer: the conditional UPDATE on result IS NULL makes double-answers impossible.
async function submitAnswer({ roomId, name, answerIndex }) {
  const live = await getLiveRow(roomId);
  if (!live || !live.question_id) return { ok: false, error: "No live question" };
  if (live.first_user !== name) return { ok: false, error: "You must hit the buzzer first" };
  if (live.result) return { ok: false, error: "Already answered" };
  if (Number(live.round_end) && Date.now() > Number(live.round_end)) return { ok: false, error: "Time is up" };
  const opts = JSON.parse(live.q_options);
  if (answerIndex < 0 || answerIndex >= opts.length) return { ok: false, error: "Invalid answer" };
  const correct = answerIndex === Number(live.q_correct_index);
  const upd = await client.execute(
    { sql: "UPDATE live_state SET result = ?, active = 0, round_end = 0 WHERE room_id = ? AND result IS NULL AND first_user = ?",
      args: [JSON.stringify({ user: name, answerIndex, answerText: opts[answerIndex], correct }), roomId, name] }
  );
  if (!upd.rowsAffected) return { ok: false, error: "Already answered" };
  const stmts = [
    { sql: "INSERT INTO answers (room_id, question_id, user_name, answer_index, correct, answered_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [roomId, live.question_id, name, answerIndex, correct ? 1 : 0, Date.now()] }
  ];
  if (correct) stmts.push({ sql: "UPDATE users SET score = score + 10 WHERE id = ?", args: [`${name}@${roomId}`] });
  await client.batch(stmts, "write");
  return { ok: true, correct };
}

module.exports = {
  client,
  ensureInit,
  listRooms, roomExists, createRoom,
  listQuestions, getQuestion, createQuestion,
  getQueue, addToQueue, removeQueueAt, clearQueue, popQueueHead,
  joinUser, touchUser, leaveUser, userExists, listUsers,
  getLiveRow, setLivePush, setLiveUnlock, setLiveReset, claimBuzzer, submitAnswer
};
