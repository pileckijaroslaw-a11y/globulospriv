// Serwer gry Kulki: strona statyczna + pokoje z kolejką graczy (WebSocket).
// Fizykę liczy serwer. W pokoju grają dwie osoby, reszta obserwuje i czeka w kolejce.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const { create, C } = require("./public/game.js");   // tryb Football
const Lms = require("./public/lms.js");                // tryb Last man standing
const APP = require("./public/version.js");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };
const MAX_ROOMS = 30, MAX_MEMBERS = 20;
const GRACE_MS = 60 * 1000;                                   // czas na powrót rozłączonej osoby
const NEXT_MATCH_MS = Number(process.env.NEXT_MATCH_MS) || 6000;   // przerwa po meczu

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
// room: { id, name, g, members: Map(id -> {id, token, name, ws, timer}),
//         slots: {blue, red} (id lub null), queue: [id...], chat: [], overTimer }
const rooms = new Map();
const ID_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
function newRoomId() {
  let s;
  do { s = ""; for (let i = 0; i < 6; i++) s += ID_CHARS[crypto.randomInt(ID_CHARS.length)]; } while (rooms.has(s));
  return s;
}
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const clean = (n, d, max) => String(n || "").replace(/[<>&"'`]/g, "").trim().slice(0, max || 16) || d;
const roleOf = (r, id) => r.slots.blue === id ? "blue" : r.slots.red === id ? "red" : "queue";
const isOnline = (r, id) => { const m = id && r.members.get(id); return !!(m && m.ws && m.ws.readyState === 1); };
function statusOf(r) {
  if (r.mode === "lms") {
    if (!r.g) return "waiting";
    return r.players.every((id, i) => r.g.out[i] || isOnline(r, id)) ? "playing" : "paused";
  }
  const { blue, red } = r.slots;
  if (!blue || !red) return "waiting";
  return isOnline(r, blue) && isOnline(r, red) ? "playing" : "paused";
}
const eachMember = (r, fn) => r.members.forEach(m => { if (m.ws) fn(m); });
const broadcast = (r, obj) => eachMember(r, m => send(m.ws, obj));
const sendState = r => { if (r.g) broadcast(r, Object.assign({ t: "s" }, r.g.snapshot())); };
const playerInfo = (r, id) => { const m = id && r.members.get(id); return m ? { id: m.id, name: m.name, online: isOnline(r, id) } : null; };

// ---------- Last man standing: gracze, kolory, wysyłanie stanu pokoju ----------
const lmsIdx = (r, id) => r.g ? r.players.indexOf(id) : (r.order.indexOf(id) < Lms.L.MAX_PLAYERS ? r.order.indexOf(id) : -1);
const lmsColor = (r, id) => { const i = r.mode === "lms" ? lmsIdx(r, id) : -1; return i >= 0 ? Lms.COLORS[i] : undefined; };
function lmsPlayers(r) {   // przed startem: pierwsi dołączeni; po starcie: stała lista graczy
  const ids = r.g ? r.players : r.order.slice(0, Lms.L.MAX_PLAYERS);
  return ids.map((id, i) => ({
    id, name: r.g ? r.pnames[i] : r.members.get(id).name, online: isOnline(r, id), out: r.g && r.g.out[i] ? 1 : 0
  }));
}
function sendRoomLms(r) {
  const players = lmsPlayers(r), ids = players.map(p => p.id);
  const spectators = r.order.filter(id => !ids.includes(id)).map(id => ({ id, name: r.members.get(id).name }));
  const base = { t: "room", mode: "lms", id: r.id, name: r.name, status: statusOf(r), started: !!r.g,
    host: r.host, timerOn: r.timerOn, players, spectators };
  eachMember(r, m => send(m.ws, Object.assign({ you: { id: m.id, idx: ids.indexOf(m.id) } }, base)));
}

function sendRoom(r) {
  if (r.mode === "lms") return sendRoomLms(r);
  const base = {
    t: "room", id: r.id, name: r.name, status: statusOf(r),
    blue: playerInfo(r, r.slots.blue), red: playerInfo(r, r.slots.red),
    queue: r.queue.map(id => ({ id, name: r.members.get(id).name }))
  };
  eachMember(r, m => send(m.ws, Object.assign({ you: { id: m.id, role: roleOf(r, m.id), pos: r.queue.indexOf(m.id) + 1 } }, base)));
}

// ---------- Strona główna (lista pokoi) ----------
function lobbyList() {
  return [...rooms.values()].map(r => r.mode === "lms"
    ? { id: r.id, name: r.name, mode: "lms", status: statusOf(r),
        players: Math.min(r.order.length, Lms.L.MAX_PLAYERS), queue: Math.max(0, r.order.length - Lms.L.MAX_PLAYERS) }
    : { id: r.id, name: r.name, mode: "football", status: statusOf(r), queue: r.queue.length,
        blue: r.slots.blue ? r.members.get(r.slots.blue).name : null,
        red: r.slots.red ? r.members.get(r.slots.red).name : null });
}
function broadcastLobby() {
  const msg = { t: "lobby", rooms: lobbyList() };
  wss.clients.forEach(ws => { if (ws.lobby && !ws.room) send(ws, msg); });
}

// ---------- Logika pokoju ----------
function resetGame(r) {
  clearTimeout(r.overTimer); r.overTimer = null;
  r.g.newGame();
}
function fillSlots(r) {            // wolne miejsca przy grze zajmują pierwsi z kolejki
  let changed = false;
  for (const team of ["blue", "red"]) {
    if (!r.slots[team] && r.queue.length) { r.slots[team] = r.queue.shift(); changed = true; }
  }
  return changed;
}
function updated(r, reset) {
  if (fillSlots(r) || reset) resetGame(r);
  sendRoom(r); sendState(r); broadcastLobby();
}

function join(ws, r, name) {
  const id = crypto.randomBytes(4).toString("hex"), token = crypto.randomBytes(12).toString("hex");
  r.members.set(id, { id, token, name: clean(name, "Gracz"), ws, timer: null });
  if (r.mode === "lms") { r.order.push(id); if (!r.host) r.host = id; } else r.queue.push(id);
  ws.room = r; ws.mid = id; ws.lobby = false;
  send(ws, { t: "joined", roomId: r.id, token, id });
  send(ws, { t: "chatlog", log: r.chat });
  if (r.mode === "lms") { sendRoom(r); sendState(r); broadcastLobby(); } else updated(r, false);
}

function removeMember(r, id) {
  const m = r.members.get(id);
  if (!m) return;
  if (r.mode === "lms") return removeLms(r, id, m);
  clearTimeout(m.timer);
  r.members.delete(id);
  r.queue = r.queue.filter(x => x !== id);
  let wasPlayer = false;
  for (const team of ["blue", "red"]) if (r.slots[team] === id) { r.slots[team] = null; wasPlayer = true; }
  if (!r.members.size) { clearTimeout(r.overTimer); rooms.delete(r.id); return broadcastLobby(); }
  updated(r, wasPlayer);     // gdy odszedł gracz: mecz przepada, na jego miejsce wchodzi pierwszy z kolejki
}

// Last man standing: gracz odszedł, jego kulki znikają, a rolę założyciela przejmuje następna osoba.
function removeLms(r, id, m) {
  clearTimeout(m.timer);
  const idx = r.players.indexOf(id);
  r.members.delete(id);
  r.order = r.order.filter(x => x !== id);
  if (!r.members.size) { clearTimeout(r.overTimer); rooms.delete(r.id); return broadcastLobby(); }
  if (r.host === id) r.host = r.order[0];
  if (r.g && idx >= 0) r.g.eliminate(idx);
  sendRoom(r); sendState(r); broadcastLobby();
}
// Po meczu Last man standing pokój wraca do oczekiwania na kolejny START.
function endLms(r) {
  r.overTimer = null; r.g = null; r.players = []; r.pnames = [];
  sendRoom(r); broadcastLobby();
}

// Po meczu: zwycięzca zostaje, przegrany idzie na koniec kolejki, a jego miejsce zajmuje pierwszy z kolejki.
function rotate(r) {
  r.overTimer = null;
  const g = r.g;
  if (g.phase !== "over" || !g.winner) return;
  const loserTeam = g.winner === "blue" ? "red" : "blue";
  if (r.queue.length) {
    const loser = r.slots[loserTeam];
    r.slots[loserTeam] = r.queue.shift();
    r.queue.push(loser);
  }
  resetGame(r);
  sendRoom(r); sendState(r); broadcastLobby();
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 2048 });

wss.on("connection", ws => {
  ws.alive = true; ws.lobby = false; ws.room = null; ws.mid = null;
  ws.on("pong", () => { ws.alive = true; });

  ws.on("message", raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== "string") return;

    if (m.t === "ping") return send(ws, { t: "pong" });
    if (m.t === "lobby") { ws.lobby = true; if (!ws.room) send(ws, { t: "lobby", rooms: lobbyList() }); return; }

    if (m.t === "create") {
      if (ws.room) return;
      if (rooms.size >= MAX_ROOMS) return send(ws, { t: "error", msg: "Za dużo pokoi. Spróbuj później." });
      const name = clean(m.name, "Gracz");
      const mode = m.mode === "lms" ? "lms" : "football";
      const r = {
        id: newRoomId(), name: clean(m.roomName, "Pokój gracza " + name, 24), mode, g: mode === "lms" ? null : create(),
        members: new Map(), slots: { blue: null, red: null }, queue: [], chat: [], overTimer: null, tick: 0,
        order: [], host: null, players: [], pnames: [], timerOn: true      // pola trybu Last man standing
      };
      rooms.set(r.id, r);
      return join(ws, r, name);
    }
    if (m.t === "enter") {
      if (ws.room) return;
      const r = rooms.get(String(m.roomId || ""));
      if (!r) return send(ws, { t: "error", msg: "Ten pokój już nie istnieje." });
      if (r.members.size >= MAX_MEMBERS) return send(ws, { t: "error", msg: "Ten pokój jest pełny." });
      return join(ws, r, m.name);
    }
    if (m.t === "rejoin") {
      const r = rooms.get(String(m.roomId || ""));
      let mem = null;
      if (r) r.members.forEach(x => { if (x.token === m.token) mem = x; });
      if (!r || !mem) return send(ws, { t: "left", msg: "Ta gra już nie istnieje albo wypadłeś z pokoju." });
      clearTimeout(mem.timer);
      if (mem.ws && mem.ws !== ws) { mem.ws.room = null; mem.ws.terminate(); }
      mem.ws = ws; ws.room = r; ws.mid = mem.id; ws.lobby = false;
      send(ws, { t: "joined", roomId: r.id, token: mem.token, id: mem.id });
      send(ws, { t: "chatlog", log: r.chat });
      sendRoom(r); sendState(r); broadcastLobby();
      return;
    }

    const r = ws.room;
    if (!r) return;
    if (m.t === "leave") {
      ws.room = null; ws.lobby = true;
      removeMember(r, ws.mid);
      send(ws, { t: "left" });
      return send(ws, { t: "lobby", rooms: lobbyList() });
    }
    const role = roleOf(r, ws.mid);

    // Czat: każdy w pokoju (gracze i obserwatorzy), z ograniczeniem częstotliwości i długości.
    if (m.t === "chat") {
      const now = Date.now();
      if (now - (ws.lastChat || 0) < 500) return;
      ws.lastChat = now;
      const text = String(m.text || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 200);
      if (!text) return;
      const msg = { t: "chat", team: role, c: lmsColor(r, ws.mid), name: r.members.get(ws.mid).name, text };
      r.chat.push(msg);
      if (r.chat.length > 50) r.chat.shift();
      return broadcast(r, msg);
    }

    // Last man standing: START zakłada gospodarz, plany i gotowość wysyłają gracze z listy.
    if (r.mode === "lms") {
      if (m.t === "start") {
        if (ws.mid !== r.host || r.g) return;
        const ids = r.order.slice(0, Lms.L.MAX_PLAYERS).filter(id => isOnline(r, id));
        if (ids.length < 2) return;
        r.players = ids; r.pnames = ids.map(id => r.members.get(id).name);
        r.g = Lms.create(ids.length); r.g.timerOn = r.timerOn;
        sendRoom(r); sendState(r); broadcastLobby();
      } else if (m.t === "settings") {
        if (ws.mid !== r.host) return;
        r.timerOn = !!m.timerOn;
        if (r.g) r.g.timerOn = r.timerOn;
        sendRoom(r); sendState(r);
      } else {
        const idx = r.players.indexOf(ws.mid);
        if (!r.g || idx < 0 || statusOf(r) !== "playing") return;
        if (m.t === "plans") r.g.setPlans(idx, m.plans);
        else if (m.t === "ready") r.g.setReady(idx, true);
        else if (m.t === "unready") r.g.setReady(idx, false);
        else return;
        sendState(r);
      }
      return;
    }

    // Sterowanie grą (Football): tylko dwaj gracze i tylko gdy obaj są połączeni.
    if (role === "queue" || statusOf(r) !== "playing") return;
    const g = r.g;
    if (m.t === "plans") g.setPlans(role, m.plans);
    else if (m.t === "ready") g.setReady(role, true);
    else if (m.t === "unready") g.setReady(role, false);
    else if (m.t === "settings") g.timerOn = !!m.timerOn;
    else return;
    sendState(r);
  });

  ws.on("close", () => {
    const r = ws.room;
    if (!r) return;
    const mem = r.members.get(ws.mid);
    if (!mem || mem.ws !== ws) return;
    mem.ws = null;
    mem.timer = setTimeout(() => removeMember(r, mem.id), GRACE_MS);
    sendRoom(r); broadcastLobby();
  });
});

setInterval(() => {   // wykrywanie martwych połączeń
  wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); });
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
      if (!r.g || statusOf(r) !== "playing") continue;
      r.g.step();
      r.tick++;
      if (r.g.phase === "over" && !r.overTimer) r.overTimer = setTimeout(() => (r.mode === "lms" ? endLms(r) : rotate(r)), NEXT_MATCH_MS);
      if ((r.g.phase !== "plan" && r.g.phase !== "over") || r.tick % 6 === 0) sendState(r);
    }
  }
}, 8);

server.listen(PORT, () => console.log(APP.NAME + " v" + APP.VERSION + " działa: http://localhost:" + PORT));
if (process.env.GLOBULOS_TEST) module.exports = { rooms };
