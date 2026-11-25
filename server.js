const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const BUILTIN_PROMPTS = require("./prompts");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 4e6, pingTimeout: 30000 });

app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (_req, res) => res.send("ok"));
app.get("/api/qr", async (req, res) => {
  const text = String(req.query.text || "").slice(0, 300);
  if (!text) return res.status(400).end();
  try {
    const svg = await QRCode.toString(text, { type: "svg", margin: 1, width: 260 });
    res.type("image/svg+xml").send(svg);
  } catch {
    res.status(500).end();
  }
});

// ---------- ゲーム状態 ----------
const rooms = new Map();
const MAX_PLAYERS = 20;
const VOTE_SECONDS = 40;
const GRACE_MS = 2500; // 時間切れ後、自動提出を待つ猶予
const HOST_HANDOFF_MS = 20000;

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}
const token = () => crypto.randomBytes(12).toString("hex");
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const cleanName = (s) => String(s || "").replace(/\s+/g, " ").trim().slice(0, 12);

function createRoom() {
  const room = {
    code: makeCode(),
    hostId: null,
    players: new Map(), // id -> {id, name, score, socketId, connected, dcAt}
    phase: "lobby",
    settings: { rounds: 3, drawSeconds: 60 },
    round: 0,
    prompt: "",
    playerPrompts: [],
    usedPrompts: new Set(),
    drawings: new Map(), // playerId -> dataURL
    entries: [], // 投票用 [{entryId, playerId, image}]
    votes: new Map(), // voterId -> entryId
    lastResult: null,
    deadline: 0,
    timer: null,
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

const connectedPlayers = (room) => [...room.players.values()].filter((p) => p.connected);

function publicState(room, forId) {
  const base = {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    me: forId,
    settings: room.settings,
    round: room.round,
    prompt: room.phase === "lobby" ? "" : room.prompt,
    deadline: room.deadline,
    now: Date.now(),
    promptCount: room.playerPrompts.length,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      history: p.history || {},
      connected: p.connected,
      submitted: room.drawings.has(p.id),
      voted: room.votes.has(p.id),
    })),
  };
  if (room.phase === "voting") {
    base.entries = room.entries.map((e) => ({ entryId: e.entryId, image: e.image, mine: e.playerId === forId }));
    base.myVote = room.votes.get(forId) || null;
  }
  if (room.phase === "results" || room.phase === "final") base.result = room.lastResult;
  return base;
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players.values()) {
    if (p.connected && p.socketId) io.to(p.socketId).emit("state", publicState(room, p.id));
  }
}

function setTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.timer = setTimeout(fn, ms);
}

function pickPrompt(room) {
  // 参加者が出したお題を優先、なければ内蔵リストから
  if (room.playerPrompts.length) {
    const i = Math.floor(Math.random() * room.playerPrompts.length);
    return room.playerPrompts.splice(i, 1)[0];
  }
  let pool = BUILTIN_PROMPTS.filter((p) => !room.usedPrompts.has(p));
  if (!pool.length) {
    room.usedPrompts.clear();
    pool = BUILTIN_PROMPTS;
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function startRound(room) {
  room.round += 1;
  room.prompt = pickPrompt(room);
  room.usedPrompts.add(room.prompt);
  room.drawings.clear();
  room.votes.clear();
  room.entries = [];
  room.phase = "drawing";
  room.deadline = Date.now() + room.settings.drawSeconds * 1000;
  setTimer(room, room.settings.drawSeconds * 1000 + GRACE_MS, () => startVoting(room));
  broadcast(room);
}

function startVoting(room) {
  if (room.phase !== "drawing") return;
  room.entries = shuffle(
    [...room.drawings.entries()].map(([playerId, image]) => ({ entryId: token().slice(0, 8), playerId, image }))
  );
  if (room.entries.length < 2) {
    // 投票できるほど絵が集まらなかった
    room.lastResult = { prompt: room.prompt, round: room.round, ranking: rankEntries(room), skipped: true };
    recordHistory(room, []);
    room.phase = room.round >= room.settings.rounds ? "final" : "results";
    clearTimeout(room.timer);
    return broadcast(room);
  }
  room.phase = "voting";
  room.deadline = Date.now() + VOTE_SECONDS * 1000;
  setTimer(room, VOTE_SECONDS * 1000 + 1000, () => finishVoting(room));
  broadcast(room);
}

function rankEntries(room) {
  const counts = new Map(room.entries.map((e) => [e.entryId, 0]));
  for (const v of room.votes.values()) counts.set(v, (counts.get(v) || 0) + 1);
  return room.entries
    .map((e) => ({
      playerId: e.playerId,
      name: room.players.get(e.playerId)?.name || "?",
      image: e.image,
      votes: counts.get(e.entryId) || 0,
    }))
    .sort((a, b) => b.votes - a.votes);
}

// ラウンドごとの獲得点を記録（描かなかった人は0点）
function recordHistory(room, ranking) {
  const pts = new Map(ranking.map((r) => [r.playerId, r.points || 0]));
  for (const p of room.players.values()) {
    p.history = p.history || {};
    p.history[room.round] = pts.get(p.id) || 0;
  }
}

function finishVoting(room) {
  if (room.phase !== "voting") return;
  clearTimeout(room.timer);
  const ranking = rankEntries(room);
  const top = ranking[0]?.votes || 0;
  for (const r of ranking) {
    const p = room.players.get(r.playerId);
    if (!p) continue;
    r.points = r.votes * 100 + (top > 0 && r.votes === top ? 50 : 0); // 1位ボーナス
    p.score += r.points;
  }
  recordHistory(room, ranking);
  room.lastResult = { prompt: room.prompt, round: room.round, ranking };
  room.phase = room.round >= room.settings.rounds ? "final" : "results";
  room.deadline = 0;
  broadcast(room);
}

function checkAllSubmitted(room) {
  const active = connectedPlayers(room);
  if (room.phase === "drawing" && active.length && active.every((p) => room.drawings.has(p.id))) {
    startVoting(room);
  }
}

function canVote(room, pid) {
  return room.entries.some((e) => e.playerId !== pid);
}
function checkAllVoted(room) {
  if (room.phase !== "voting") return;
  const voters = connectedPlayers(room).filter((p) => canVote(room, p.id));
  if (voters.every((p) => room.votes.has(p.id))) finishVoting(room);
}

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.connected) return;
  if (host && Date.now() - host.dcAt < HOST_HANDOFF_MS) return;
  const next = connectedPlayers(room)[0];
  if (next) room.hostId = next.id;
}

// ---------- 通信 ----------
io.on("connection", (socket) => {
  let room = null;
  let player = null;

  const fail = (msg) => socket.emit("errorMsg", msg);

  function attach(r, p) {
    room = r;
    player = p;
    p.socketId = socket.id;
    p.connected = true;
    socket.emit("joined", { code: r.code, playerId: p.id, token: p.token });
    ensureHost(r);
    broadcast(r);
  }

  socket.on("create", ({ name }) => {
    name = cleanName(name);
    if (!name) return fail("名前を入力してください");
    const r = createRoom();
    const p = { id: token().slice(0, 10), token: token(), name, score: 0, history: {}, connected: true };
    r.players.set(p.id, p);
    r.hostId = p.id;
    attach(r, p);
  });

  socket.on("join", ({ code, name }) => {
    const r = rooms.get(String(code || "").toUpperCase().trim());
    if (!r) return fail("ルームが見つかりません。コードを確認してください");
    name = cleanName(name);
    if (!name) return fail("名前を入力してください");
    if (r.players.size >= MAX_PLAYERS) return fail("このルームは満員です");
    const names = new Set([...r.players.values()].map((p) => p.name));
    let n = name, i = 2;
    while (names.has(n)) n = `${name}${i++}`;
    const p = { id: token().slice(0, 10), token: token(), name: n, score: 0, history: {}, connected: true };
    r.players.set(p.id, p);
    attach(r, p);
  });

  socket.on("resume", ({ code, token: t }) => {
    const r = rooms.get(String(code || "").toUpperCase());
    const p = r && [...r.players.values()].find((x) => x.token === t);
    if (!p) return socket.emit("resumeFailed");
    attach(r, p);
  });

  const isHost = () => room && player && room.hostId === player.id;

  socket.on("addPrompt", (text) => {
    if (!room) return;
    const t = String(text || "").trim().slice(0, 30);
    if (!t || room.playerPrompts.length >= 100) return;
    room.playerPrompts.push(t);
    broadcast(room);
  });

  socket.on("settings", (s) => {
    if (!isHost() || room.phase !== "lobby") return;
    const rounds = Math.min(10, Math.max(1, parseInt(s.rounds) || 3));
    const drawSeconds = [30, 45, 60, 90, 120].includes(+s.drawSeconds) ? +s.drawSeconds : 60;
    room.settings = { rounds, drawSeconds };
    broadcast(room);
  });

  socket.on("start", () => {
    if (!isHost() || room.phase !== "lobby") return;
    if (connectedPlayers(room).length < 2) return fail("2人以上で始められます");
    for (const p of room.players.values()) { p.score = 0; p.history = {}; }
    room.round = 0;
    startRound(room);
  });

  socket.on("submitDrawing", (image) => {
    if (!room || room.phase !== "drawing") return;
    if (typeof image !== "string" || !image.startsWith("data:image/") || image.length > 3e6) return;
    room.drawings.set(player.id, image);
    broadcast(room);
    checkAllSubmitted(room);
  });

  socket.on("vote", (entryId) => {
    if (!room || room.phase !== "voting") return;
    const e = room.entries.find((x) => x.entryId === entryId);
    if (!e || e.playerId === player.id) return;
    room.votes.set(player.id, entryId);
    broadcast(room);
    checkAllVoted(room);
  });

  socket.on("skip", () => {
    // 幹事が待ちきれないときに次へ進める
    if (!isHost()) return;
    if (room.phase === "drawing") startVoting(room);
    else if (room.phase === "voting") finishVoting(room);
  });

  socket.on("next", () => {
    if (!isHost()) return;
    if (room.phase === "results") startRound(room);
  });

  socket.on("backToLobby", () => {
    if (!isHost()) return;
    clearTimeout(room.timer);
    room.phase = "lobby";
    room.round = 0;
    room.lastResult = null;
    room.drawings.clear();
    room.votes.clear();
    broadcast(room);
  });

  socket.on("kick", (pid) => {
    if (!isHost() || pid === player.id) return;
    const p = room.players.get(pid);
    if (!p) return;
    room.players.delete(pid);
    if (p.socketId) io.to(p.socketId).emit("kicked");
    broadcast(room);
    checkAllSubmitted(room);
    checkAllVoted(room);
  });

  socket.on("leave", () => {
    if (!room || !player) return;
    room.players.delete(player.id);
    const r = room;
    room = player = null;
    if (!r.players.size) {
      clearTimeout(r.timer);
      rooms.delete(r.code);
      return;
    }
    ensureHost(r);
    if (!r.players.has(r.hostId)) r.hostId = connectedPlayers(r)[0]?.id || [...r.players.keys()][0];
    broadcast(r);
    checkAllSubmitted(r);
    checkAllVoted(r);
  });

  socket.on("disconnect", () => {
    if (!room || !player || player.socketId !== socket.id) return;
    player.connected = false;
    player.dcAt = Date.now();
    const r = room;
    broadcast(r);
    checkAllSubmitted(r);
    checkAllVoted(r);
    setTimeout(() => {
      if (rooms.has(r.code)) {
        const before = r.hostId;
        ensureHost(r);
        if (before !== r.hostId) broadcast(r);
      }
    }, HOST_HANDOFF_MS + 500);
  });
});

// 3時間使われていないルームを片付ける
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [code, r] of rooms) {
    if (r.lastActive < cutoff) {
      clearTimeout(r.timer);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`oekaki-party listening on ${PORT}`));
