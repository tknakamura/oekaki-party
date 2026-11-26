// 効果音（Web Audio でその場で合成。音声ファイルは使わない）
const SFX = (() => {
  let ctx = null, master = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem("oekaki-muted") === "1"; } catch {}

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    // iPhone のマナーモード中でも鳴らす（対応している iOS のみ）
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch {}
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ctx;
  }
  // スマホは画面に触れるまで音を出せないので、最初のタップで有効にする
  function unlock() {
    const c = ensure();
    if (c && c.state === "suspended") c.resume();
    if (c) { const b = c.createBuffer(1, 1, 22050), s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); }
  }
  ["pointerdown", "touchend", "keydown"].forEach((t) => addEventListener(t, unlock, { capture: true, passive: true }));

  const ready = () => !muted && ensure() && ctx.state === "running";

  function tone(freq, at, dur, { type = "square", vol = 0.25, to = null, attack = 0.005 } = {}) {
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(at, dur, { vol = 0.3, hp = 800, decay = true } = {}) {
    const t = ctx.currentTime + at;
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noiseBuf; f.type = "highpass"; f.frequency.value = hp;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (decay ? dur : dur * 1.2));
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  }
  const N = { C4: 262, E4: 330, G4: 392, A4: 440, B4: 494, C5: 523, D5: 587, E5: 659, F5: 698, G5: 784, A5: 880, C6: 1047, E6: 1319, G6: 1568 };
  const chord = (notes, at, dur, opt) => notes.forEach((n) => tone(N[n], at, dur, opt));

  const sounds = {
    // 参加：ピコン♪
    join() { tone(N.E5, 0, 0.08, { vol: 0.18 }); tone(N.A5, 0.08, 0.16, { vol: 0.18 }); },
    // お題発表：ジャジャーン！
    prompt() {
      tone(N.G4, 0, 0.1, { vol: 0.2 }); tone(N.G4, 0.12, 0.1, { vol: 0.2 });
      chord(["C5", "E5", "G5"], 0.26, 0.7, { type: "square", vol: 0.12 });
      tone(N.C6, 0.26, 0.7, { type: "triangle", vol: 0.25 });
      noise(0.26, 0.4, { vol: 0.15, hp: 3000 });
    },
    // 最終ラウンド：警報風
    bonus() {
      for (let i = 0; i < 4; i++) { tone(N.A5, i * 0.22, 0.1, { type: "sawtooth", vol: 0.14 }); tone(N.E5, i * 0.22 + 0.11, 0.1, { type: "sawtooth", vol: 0.14 }); }
    },
    // 残り時間：カチ
    tick(last) { tone(last ? 1600 : 1200, 0, 0.04, { vol: last ? 0.25 : 0.18 }); },
    // 時間切れ：ブブー
    buzzer() { tone(180, 0, 0.32, { type: "sawtooth", vol: 0.2 }); tone(150, 0.36, 0.45, { type: "sawtooth", vol: 0.2 }); },
    // 提出・投票：ポンッ
    pon() { tone(520, 0, 0.14, { type: "sine", vol: 0.35, to: 1040 }); },
    // 選択：ポチ
    tap() { tone(900, 0, 0.05, { type: "triangle", vol: 0.15 }); },
    // 結果発表：ドラムロール → ファンファーレ
    results() {
      const roll = 1.2;
      for (let t = 0; t < roll; t += 0.045) noise(t, 0.05, { vol: 0.05 + (t / roll) * 0.18, hp: 1200 });
      noise(roll, 0.9, { vol: 0.35, hp: 4000 });
      tone(N.C5, roll, 0.12); tone(N.E5, roll + 0.13, 0.12); tone(N.G5, roll + 0.26, 0.12);
      chord(["C5", "E5", "G5"], roll + 0.4, 0.8, { vol: 0.1 });
      tone(N.C6, roll + 0.4, 0.8, { type: "triangle", vol: 0.25 });
      return roll; // 1位発表までの秒数
    },
    // 優勝発表：長めのファンファーレ
    champion() {
      const roll = 1.6;
      for (let t = 0; t < roll; t += 0.04) noise(t, 0.045, { vol: 0.05 + (t / roll) * 0.22, hp: 1200 });
      const mel = [["G4", 0.14], ["C5", 0.14], ["E5", 0.14], ["G5", 0.3], ["E5", 0.14], ["G5", 0.6]];
      let at = roll;
      noise(roll, 1.2, { vol: 0.35, hp: 4000 });
      for (const [n, d] of mel) { tone(N[n], at, d, { vol: 0.2 }); tone(N[n] / 2, at, d, { type: "triangle", vol: 0.2 }); at += d + 0.02; }
      chord(["C5", "E5", "G5", "C6"], at, 1.4, { vol: 0.09 });
      tone(N.C4, at, 1.4, { type: "triangle", vol: 0.3 });
      noise(at, 1.4, { vol: 0.3, hp: 5000 });
      return roll;
    },
  };

  return {
    play(name, ...args) { try { if (ready()) return sounds[name](...args); } catch {} return 0; },
    isMuted: () => muted,
    setMuted(m) { muted = m; try { localStorage.setItem("oekaki-muted", m ? "1" : "0"); } catch {} if (!m) { unlock(); setTimeout(() => SFX.play("pon"), 50); } },
  };
})();
