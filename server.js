// Serwer Globulos Private: strona statyczna + pokoje WebSocket. Fizykę liczy serwer.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { create, C } = require("./public/game.js");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };
const GRACE_MS = 90 * 1000;   // tyle czekamy na powrót rozłączonego gracza

// ---------- Strona statyczna ----------
const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent((req.url || "/").split("?")[0]); } catch { res.writeHead(400); return res.end(); }
  if (url === "/healthz") return res.end("ok");
  const file = path.normalize(path.join(PUBLIC, url === "/" ? "index.html" : url.slice(1)));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Nie znaleziono"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---------- Pokoje ----------
const rooms = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const cleanName = (n, d) => String(n || "").replace(/[<>&"'`]/g, "").trim().slice(0, 16) || d;
const status = r => (r.socks.blue && r.socks.red) ? "playing" : (r.joinedBoth ? "paused" : "waiting");

function broadcast(r, obj) { send(r.socks.blue, obj); send(r.socks.red, obj); }
const sendRoom = r => broadcast(r, { t: "room", status: status(r), names: r.names });
const sendState = r => broadcast(r, Object.assign({ t: "s" }, r.g.snapshot()));

function makeRoom(code) {
  const g = create();
  const r = {
    code, g, socks: { blue: null, red: null }, joinedBoth: false, closeTimer: null, tick: 0,
    tokens: { blue: crypto.randomBytes(12).toString("hex"), red: crypto.randomBytes(12).toString("hex") },
    names: { blue: "Niebieski", red: "Czerwony" }
  };
  rooms.set(code, r);
  return r;
}

function attach(ws, r, team) {
  ws.room = r; ws.team = team;
  r.socks[team] = ws;
  if (r.closeTimer && r.socks.blue && r.socks.red) { clearTimeout(r.closeTimer); r.closeTimer = null; }
  send(ws, { t: "joined", code: r.code, team, token: r.tokens[team] });
  sendRoom(r);
  send(ws, Object.assign({ t: "s" }, r.g.snapshot()));
}

function scheduleClose(r) {
  if (r.closeTimer) return;
  r.closeTimer = setTimeout(() => {
    broadcast(r, { t: "closed", msg: "Przeciwnik nie wrócił do gry. Pokój został zamknięty." });
    rooms.delete(r.code);
  }, GRACE_MS);
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 2048 });

wss.on("connection", ws => {
  ws.alive = true;
  ws.on("pong", () => { ws.alive = true; });

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== "string") return;

    if (m.t === "ping") return send(ws, { t: "pong" });

    if (m.t === "create") {
      if (ws.room) return;
      const r = makeRoom(newCode());
      r.names.blue = cleanName(m.name, "Niebieski");
      return attach(ws, r, "blue");
    }
    if (m.t === "join") {
      if (ws.room) return;
      const r = rooms.get(String(m.code || "").toUpperCase().trim());
      if (!r) return send(ws, { t: "error", msg: "Nie ma takiego pokoju." });
      if (r.joinedBoth) return send(ws, { t: "error", msg: "Ten pokój jest już pełny." });
      r.names.red = cleanName(m.name, "Czerwony");
      r.joinedBoth = true;
      r.g.newGame();
      return attach(ws, r, "red");
    }
    if (m.t === "rejoin") {
      const r = rooms.get(String(m.code || ""));
      const team = r && (m.token === r.tokens.blue ? "blue" : m.token === r.tokens.red ? "red" : null);
      if (!r || !team) return send(ws, { t: "closed", msg: "Ta gra już nie istnieje. Utwórz nową." });
      const old = r.socks[team];
      if (old && old !== ws) { old.room = null; old.terminate(); }
      return attach(ws, r, team);
    }

    // Wiadomości dotyczące gry: tylko gdy obaj gracze są połączeni.
    const r = ws.room;
    if (!r || status(r) !== "playing") return;
    const g = r.g, team = ws.team;

    if (m.t === "plans") g.setPlans(team, m.plans);
    else if (m.t === "ready") g.setReady(team, true);
    else if (m.t === "unready") g.setReady(team, false);
    else if (m.t === "settings") { if (team === "blue") g.timerOn = !!m.timerOn; }
    else if (m.t === "newgame") { if (g.phase === "over" || team === "blue") g.newGame(); }
    else return;
    sendState(r);
  });

  ws.on("close", () => {
    const r = ws.room;
    if (!r || r.socks[ws.team] !== ws) return;
    r.socks[ws.team] = null;
    sendRoom(r);
    scheduleClose(r);
  });
});

// Wykrywanie martwych połączeń.
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false;
    ws.ping();
  });
}, 30000);

// ---------- Pętla gry: 60 kroków na sekundę ----------
let last = Date.now(), acc = 0;
setInterval(() => {
  const now = Date.now();
  acc += Math.min(now - last, 200);
  last = now;
  while (acc >= C.STEP_MS) {
    acc -= C.STEP_MS;
    for (const r of rooms.values()) {
      if (status(r) !== "playing") continue;
      r.g.step();
      r.tick++;
      // W ruchu wysyłamy każdy krok, w planowaniu tylko ~10 razy na sekundę.
      if ((r.g.phase !== "plan" && r.g.phase !== "over") || r.tick % 6 === 0) sendState(r);
    }
  }
}, 8);

server.listen(PORT, () => console.log("Globulos Private działa: http://localhost:" + PORT));
