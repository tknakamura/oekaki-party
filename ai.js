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

module.exports = { pickPrompts, aiEnabled };
