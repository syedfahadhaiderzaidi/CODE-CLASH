const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "codeclash.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
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
  added_at    INTEGER NOT NULL DEFAULT (unixepoch())
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
`);

// Seed sample data once, mirroring the original localStorage demo data.
function seed() {
  if (db.prepare("SELECT COUNT(*) AS n FROM rooms").get().n > 0) return;
  const insRoom = db.prepare("INSERT INTO rooms (id, name) VALUES (?, ?)");
  const insQ = db.prepare(
    "INSERT INTO questions (id, question, code, options, correct_index) VALUES (?, ?, ?, ?, ?)"
  );
  const insQueue = db.prepare("INSERT INTO queues (room_id, question_id) VALUES (?, ?)");
  const insUser = db.prepare(
    "INSERT INTO users (id, name, room_id, score, online, last_seen) VALUES (?, ?, ?, ?, 0, 0)"
  );
  const insLive = db.prepare("INSERT INTO live_state (room_id) VALUES (?)");

  const samples = [
    { id: "DEMO1", q: "Which language is primarily used to structure a web page?", code: "", opts: ["CSS", "HTML", "Python", "SQL"], correct: 1 },
    { id: "DEMO2", q: "What does CPU stand for?", code: "", opts: ["Central Processing Unit", "Computer Personal Unit", "Core Program Utility", "Central Program User"], correct: 0 },
    { id: "DEMO3", q: "What is the output of this C++ code?", code: "int x = 5;\ncout << x + 2;", opts: ["5", "7", "52", "Error"], correct: 1 },
    { id: "DEMO4", q: "Which symbol is used for a single-line comment in C++?", code: "", opts: ["//", "/*", "##", "<!--"], correct: 0 }
  ];

  db.transaction(() => {
    insRoom.run("TECH101", "Web Development Demo");
    insRoom.run("CS2026", "C++ Fundamentals Demo");
    for (const s of samples) insQ.run(s.id, s.q, s.code, JSON.stringify(s.opts), s.correct);
    for (const qid of ["DEMO1", "DEMO2", "DEMO3", "DEMO4"]) insQueue.run("TECH101", qid);
    insUser.run("DemoA@TECH101", "DemoA", "TECH101", 20);
    insUser.run("DemoB@TECH101", "DemoB", "TECH101", 10);
    insUser.run("DemoC@TECH101", "DemoC", "TECH101", 0);
    insLive.run("TECH101");
    insLive.run("CS2026");
  })();
}
seed();

module.exports = db;
