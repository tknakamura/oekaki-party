// 参加者が出したお題の中から、宴会が盛り上がるものを Claude に選んでもらう。
// ANTHROPIC_API_KEY が設定されていない、またはエラー・タイムアウトのときは null を返し、
// 呼び出し側はランダム選択に切り替える。

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const TIMEOUT_MS = 12000;

const aiEnabled = () => !!API_KEY;

const SYSTEM = `あなたは日本の会社の宴会（忘年会・新年会・打ち上げ）を盛り上げるプロの幹事です。
「お題に合わせてスマホに指で絵を描き、みんなで投票する」ゲームのお題を選びます。

良いお題の基準:
- 60秒前後で描ける。絵が下手でも笑える、描き手ごとに解釈が分かれる
- 参加者みんなが共感できる・身内ネタとして盛り上がる
- 序盤は描きやすいもの、終盤ほど盛り上がる・ひねりのあるものにする
- 似たお題が続かないようにバランスを取る

必ず避けるもの:
- 特定の人をばかにする、容姿・性別・年齢・国籍などをいじる、ハラスメントになりうるもの
- 性的・下品すぎるもの、絵にしようがないもの、意味が通らないもの`;

// Claude を呼んで JSON を受け取る。失敗時は null
async function callClaude(user, timeoutMs = TIMEOUT_MS, system = SYSTEM) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) {
      console.error("AI 呼び出しエラー", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data = await res.json();
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch (e) {
    console.error("AI 呼び出しに失敗", e.name === "AbortError" ? "timeout" : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// AI にお題を考えてもらう
// theme: 幹事が入れたテーマ（任意）, hints: 参加者が出したネタ, avoid: すでに使ったお題
async function generatePrompts({ count, theme = "", hints = [], avoid = [] }) {
  if (!API_KEY || count <= 0) return null;
  const user = `お絵かきゲームのお題を ${count} 個考えてください。出題する順番に並べてください。
${theme ? `\n宴会のテーマ・参加者の情報（幹事が入力）: ${theme}\nこのテーマに寄せて、参加者が「わかる〜！」と笑える身内感のあるお題にしてください。` : "\n一般的な会社の宴会（忘年会など）向けにしてください。"}
${hints.length ? `\n参加者が出したネタ（ヒントとして活用。そのまま使ってもアレンジしてもよい）:\n${hints.map((h) => "- " + h).join("\n")}` : ""}
${avoid.length ? `\n次のお題はすでに使ったので、同じものや似たものは避けてください:\n${avoid.map((h) => "- " + h).join("\n")}` : ""}

条件:
- お題は 4〜16 文字くらいの短い日本語。名詞句（例：「月曜日の朝の部長」「給料日のペンギン」）
- 60秒で描ける具体的な場面・キャラ・モノ。抽象的すぎるものは避ける
- 実在の個人名は使わない（「部長」「新人」など役職や立場はOK）
- それぞれに、描く人へのひとこと（20文字以内、楽しくあおる感じ）を付ける

次の JSON だけを出力してください（説明文やコードブロックは不要）:
{"prompts":[{"prompt":"お題","comment":"ひとこと"}]}`;
  const json = await callClaude(user, 20000);
  if (!json) return null;
  const seen = new Set(avoid);
  const out = [];
  for (const p of json.prompts || []) {
    const prompt = String(p.prompt || "").replace(/[「」]/g, "").trim().slice(0, 30);
    if (!prompt || seen.has(prompt)) continue;
    seen.add(prompt);
    out.push({ prompt, comment: String(p.comment || "").slice(0, 30) });
    if (out.length >= count) break;
  }
  return out.length ? out : null;
}

const JUDGE_SYSTEM = `あなたは会社の宴会のお絵かき大会で審査員を務める、ノリがよくて愛のある AI 審査員です。
参加者がスマホに指で60秒で描いた絵を、お題に沿って採点します。

採点の観点（合計100点）:
- お題をどれだけ表現できているか（40点）
- 笑い・発想・ひねり（40点）
- 描き込み・工夫（20点）
画力の高さだけで決めないこと。下手でも発想が面白ければ高得点にします。
白紙や、ほとんど描かれていない絵は低めの点にします。

コメントは、宴会で読み上げて盛り上がるよう、明るく、少しツッコミを入れつつ褒めます。
人を傷つける言い方や、描いた人自身をけなす言い方はしません。`;

// AI 審査員：絵を見て採点する
// entries: [{label: "A", image: "data:image/jpeg;base64,..."}]
async function judgeDrawings(promptText, entries) {
  if (!API_KEY || !entries.length) return null;
  const content = [{ type: "text", text: `お題：「${promptText}」\n\n${entries.length} 枚の絵を採点してください。` }];
  for (const e of entries) {
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/.exec(e.image || "");
    if (!m) continue;
    content.push({ type: "text", text: `絵 ${e.label}:` });
    content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }
  content.push({
    type: "text",
    text: `それぞれの絵に 0〜100 の点数と、30文字以内のコメントを付けてください。順位がはっきりつくよう、なるべく同点は避けてください。
最後に、このラウンド全体の総評を40文字以内で書いてください。

次の JSON だけを出力してください（説明文やコードブロックは不要）:
{"results":[{"label":"A","score":点数,"comment":"コメント"}],"summary":"総評"}`,
  });
  const json = await callClaude(content, 40000, JUDGE_SYSTEM);
  if (!json || !Array.isArray(json.results)) return null;
  const byLabel = new Map();
  for (const r of json.results) {
    const label = String(r.label || "").trim().toUpperCase();
    const score = Math.max(0, Math.min(100, Math.round(Number(r.score))));
    if (!label || !Number.isFinite(score)) continue;
    byLabel.set(label, { score, comment: String(r.comment || "").slice(0, 40) });
  }
  if (!entries.every((e) => byLabel.has(e.label))) return null;
  return { byLabel, summary: String(json.summary || "").slice(0, 60) };
}

async function pickPrompts(prompts, count) {
  if (!API_KEY || prompts.length <= count) return null;
  const list = prompts.map((p, i) => `${i}: ${p}`).join("\n");
  const user = `参加者が出したお題の候補（番号: お題）:
${list}

この中から ${count} 個を選び、出題する順番に並べてください。
それぞれに、描く人へのひとこと（20文字以内、楽しくあおる感じ）を付けてください。
避けるべきお題は選ばないでください。条件を満たすものが足りなければ、選ぶ数は ${count} 個より少なくてかまいません。

次の JSON だけを出力してください（説明文やコードブロックは不要）:
{"picks":[{"index":番号,"comment":"ひとこと"}]}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      console.error("AI お題選定エラー", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data = await res.json();
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const seen = new Set();
    const picks = [];
    for (const p of json.picks || []) {
      const i = Number(p.index);
      if (!Number.isInteger(i) || i < 0 || i >= prompts.length || seen.has(i)) continue;
      seen.add(i);
      picks.push({ index: i, comment: String(p.comment || "").slice(0, 30) });
      if (picks.length >= count) break;
    }
    return picks.length ? picks : null;
  } catch (e) {
    console.error("AI お題選定に失敗", e.name === "AbortError" ? "timeout" : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { pickPrompts, generatePrompts, judgeDrawings, aiEnabled };
