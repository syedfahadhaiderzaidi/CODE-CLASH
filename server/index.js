// Local dev entry point: same app as the serverless function, plus process-lifetime
// conveniences that serverless can't have (SQLite file WAL mode is in db.js).
const app = require("./app");

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`CodeClash running → http://localhost:${PORT}`));
