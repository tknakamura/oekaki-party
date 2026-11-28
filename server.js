const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const BUILTIN_PROMPTS = require("./prompts");
const { pickPrompts, generatePrompts, judgeDrawings, aiEnabled } = require("./ai");

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
    settings: { rounds: 3, drawSeconds: 60, doubleFinal: true, promptMode: "players", theme: "", judgeMode: "vote" },
    round: 0,
    prompt: "",
    playerPrompts: [],
    queue: [], // AI が選んだお題の出題順 [{prompt, comment}]
    promptComment: "",
    promptByAI: false,
    promptSource: "", // "ai-made" | "ai-picked" | "player" | "builtin"
    selectingMode: "",
    judge: "vote", // このラウンドの審査方法
    aiJudge: null, // {byPlayer: Map(playerId -> {score, comment}), summary}
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
  // 同じ絵を何度も送らない（投票のたびに全員分の画像を送り直すと重くなるため）
  const viewer = room.players.get(forId);
  const sent = viewer ? (viewer.sentImgs ||= new Set()) : new Set();
  const img = (key, image) => (sent.has(key) ? null : (sent.add(key), image));
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
    aiEnabled: aiEnabled(),
    promptComment: room.phase === "lobby" ? "" : room.promptComment,
    promptByAI: room.phase !== "lobby" && room.promptByAI,
    promptSource: room.phase === "lobby" ? "" : room.promptSource,
    selectingMode: room.selectingMode,
    judge: room.judge,
    aiPickCount: room.queue.length,
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
  if (room.phase === "voting" || room.phase === "judging") {
    base.entries = room.entries.map((e) => {
      const imgKey = `${room.round}:${e.playerId}`;
      return { entryId: e.entryId, imgKey, image: img(imgKey, e.image), mine: e.playerId === forId };
    });
    base.myVote = room.votes.get(forId) || null;
  }
  if ((room.phase === "results" || room.phase === "final") && room.lastResult) {
    const r = room.lastResult;
    base.result = {
      ...r,
      ranking: r.ranking.map((x) => {
        const imgKey = `${r.round}:${x.playerId}`;
        return { ...x, imgKey, image: img(imgKey, x.image) };
      }),
    };
  }
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
  room.promptComment = "";
  room.promptByAI = false;
  // AI が選んだお題があればその順番で
  if (room.queue.length) {
    const q = room.queue.shift();
    room.promptComment = q.comment || "";
    room.promptByAI = q.source !== "player";
    room.promptSource = q.source;
    return q.prompt;
  }
  room.promptSource = room.playerPrompts.length ? "player" : "builtin";
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

// このラウンドの審査方法。2人だと投票は必ず引き分けになるので AI 審査員にする
function judgeFor(room) {
  if (!aiEnabled()) return "vote";
  if (room.entries.length <= 2 || connectedPlayers(room).length <= 2) return "ai";
  return room.settings.judgeMode;
}

function startVoting(room) {
  if (room.phase !== "drawing") return;
  clearTimeout(room.timer);
  room.entries = shuffle(
    [...room.drawings.entries()].map(([playerId, image]) => ({ entryId: token().slice(0, 8), playerId, image }))
  );
  room.aiJudge = null;
  const minEntries = aiEnabled() ? 1 : 2; // AI 審査員がいれば1枚でも採点できる
  if (room.entries.length < minEntries) {
    // 審査できるほど絵が集まらなかった
    room.lastResult = { prompt: room.prompt, round: room.round, ranking: [], skipped: true };
    recordHistory(room, []);
    room.phase = room.round >= room.settings.rounds ? "final" : "results";
    return broadcast(room);
  }
  room.judge = room.entries.length < 2 ? "ai" : judgeFor(room);
  if (room.judge === "ai") return startJudging(room);
  room.phase = "voting";
  room.deadline = Date.now() + VOTE_SECONDS * 1000;
  setTimer(room, VOTE_SECONDS * 1000 + 1000, () => finishVoting(room));
  broadcast(room);
}

function finishVoting(room) {
  if (room.phase !== "voting") return;
  clearTimeout(room.timer);
  if (room.judge === "both") return startJudging(room);
  finalizeRound(room);
}

// AI 審査員が採点する
async function startJudging(room) {
  room.phase = "judging";
  room.deadline = 0;
  broadcast(room);
  const round = room.round;
  const labels = room.entries.map((e, i) => ({ label: String.fromCharCode(65 + i), playerId: e.playerId, image: e.image }));
  const res = await judgeDrawings(room.prompt, labels);
  if (!rooms.has(room.code) || room.phase !== "judging" || room.round !== round) return;
  if (res) {
    room.aiJudge = {
      byPlayer: new Map(labels.map((l) => [l.playerId, res.byLabel.get(l.label)])),
      summary: res.summary,
    };
  } else if (room.judge === "ai" && room.entries.length >= 2 && connectedPlayers(room).length > 2) {
    // AI が使えなかったときは投票に切り替える（3人以上のとき）
    room.judge = "vote";
    room.phase = "voting";
    room.deadline = Date.now() + VOTE_SECONDS * 1000;
    setTimer(room, VOTE_SECONDS * 1000 + 1000, () => finishVoting(room));
    for (const p of connectedPlayers(room)) if (p.socketId) io.to(p.socketId).emit("errorMsg", "AI審査員が応答しないので、みんなの投票に切り替えます");
    return broadcast(room);
  }
  finalizeRound(room);
}

// 得点計算：投票1票=100点、AI審査員の点数はそのまま加算、トップに+50点、最終ラウンドは2倍
function finalizeRound(room) {
  if (room.phase !== "voting" && room.phase !== "judging") return;
  clearTimeout(room.timer);
  const counts = new Map(room.entries.map((e) => [e.entryId, 0]));
  for (const v of room.votes.values()) counts.set(v, (counts.get(v) || 0) + 1);
  const useVotes = room.judge !== "ai";
  const ai = room.aiJudge;
  const ranking = room.entries.map((e) => {
    const j = ai && ai.byPlayer.get(e.playerId);
    const votes = useVotes ? counts.get(e.entryId) || 0 : null;
    return {
      playerId: e.playerId,
      name: room.players.get(e.playerId)?.name || "?",
      image: e.image,
      votes,
      aiScore: j ? j.score : null,
      aiComment: j ? j.comment : "",
      base: (votes || 0) * 100 + (j ? j.score : 0),
    };
  });
  ranking.sort((a, b) => b.base - a.base);
  const top = ranking[0]?.base || 0;
  const multiplier = isBonusRound(room) ? 2 : 1;
  for (const r of ranking) {
    r.points = (r.base + (top > 0 && r.base === top ? 50 : 0)) * multiplier;
    const p = room.players.get(r.playerId);
    if (p) p.score += r.points;
  }
  recordHistory(room, ranking);
  room.lastResult = {
    prompt: room.prompt, round: room.round, ranking, multiplier,
    judge: room.judge, aiSummary: ai ? ai.summary : "", aiFailed: room.judge !== "vote" && !ai,
  };
  room.phase = room.round >= room.settings.rounds ? "final" : "results";
  room.deadline = 0;
  broadcast(room);
}

// ラウンドごとの獲得点を記録（描かなかった人は0点）
function recordHistory(room, ranking) {
  const pts = new Map(ranking.map((r) => [r.playerId, r.points || 0]));
  for (const p of room.players.values()) {
    p.history = p.history || {};
    p.history[room.round] = pts.get(p.id) || 0;
  }
}

// 最終ラウンドは得点2倍（2ラウンド以上のときだけ）
const isBonusRound = (room) => room.settings.doubleFinal && room.settings.rounds >= 2 && room.round === room.settings.rounds;

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
    p.sentImgs = new Set(); // 新しい接続には画像を送り直す
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
    const promptMode = s.promptMode === "ai" && aiEnabled() ? "ai" : "players";
    const theme = String(s.theme ?? room.settings.theme ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const judgeMode = ["ai", "both"].includes(s.judgeMode) && aiEnabled() ? s.judgeMode : "vote";
    room.settings = { rounds, drawSeconds, doubleFinal: s.doubleFinal !== false, promptMode, theme, judgeMode };
    broadcast(room);
  });

  socket.on("start", async () => {
    if (!isHost() || room.phase !== "lobby") return;
    if (connectedPlayers(room).length < 2) return fail("2人以上で始められます");
    for (const p of room.players.values()) { p.score = 0; p.history = {}; }
    room.round = 0;
    room.queue = [];
    const r = room;
    const rounds = r.settings.rounds;
    const avoid = [...r.usedPrompts];
    const begin = (mode) => { r.selectingMode = mode; r.phase = "selecting"; broadcast(r); };
    const alive = () => rooms.has(r.code) && r.phase === "selecting";

    if (aiEnabled() && r.settings.promptMode === "ai") {
      // AI におまかせ：参加者のネタはヒントとして渡す
      begin("generate");
      const hints = [...r.playerPrompts];
      const made = await generatePrompts({ count: rounds, theme: r.settings.theme, hints, avoid });
      if (!alive()) return;
      if (made) {
        r.queue = made.map((m) => ({ ...m, source: "ai-made" }));
        r.playerPrompts = []; // ヒントとして使い切り
      }
    } else if (aiEnabled() && r.playerPrompts.length > rounds) {
      // お題がラウンド数より多いときは AI に盛り上がるお題を選んでもらう
      begin("pick");
      const candidates = [...r.playerPrompts];
      const picks = await pickPrompts(candidates, rounds);
      if (!alive()) return;
      if (picks) {
        r.queue = picks.map((p) => ({ prompt: candidates[p.index], comment: p.comment, source: "ai-picked" }));
        const used = new Set(picks.map((p) => p.index));
        r.playerPrompts = candidates.filter((_, i) => !used.has(i));
      }
    } else if (aiEnabled() && r.playerPrompts.length < rounds) {
      // 足りない分は（定番お題の代わりに）AI が考える
      begin("fill");
      const own = shuffle([...r.playerPrompts]);
      const made = await generatePrompts({ count: rounds - own.length, theme: r.settings.theme, hints: own, avoid: [...avoid, ...own] });
      if (!alive()) return;
      if (made) {
        r.queue = shuffle([...own.map((prompt) => ({ prompt, comment: "", source: "player" })), ...made.map((m) => ({ ...m, source: "ai-made" }))]);
        r.playerPrompts = [];
      }
    }
    startRound(r);
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
    // 使われなかった AI 選定のお題は次のゲームに回す
    room.playerPrompts.push(...room.queue.filter((q) => q.source === "player" || q.source === "ai-picked").map((q) => q.prompt));
    room.queue = [];
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
