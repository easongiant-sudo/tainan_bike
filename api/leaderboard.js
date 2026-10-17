// =====================================================================
//  台南騎車生存記：排行榜 API（Vercel Serverless Function）
//  資料存在 Upstash Redis（在 Vercel 的 Storage 頁面一鍵建立，免費方案就夠用）
//
//  GET  /api/leaderboard?name=玩家名字        → 三個排行榜的前五名 + 這位玩家的名次
//  POST /api/leaderboard { action: "register", name, token }          → 註冊名字（一個名字只能一個人用）
//  POST /api/leaderboard { action: "score", name, token, level, score } → 上傳分數（只留最高分）
//  POST /api/leaderboard { action: "time", name, token, seconds }      → 累加遊玩時間
// =====================================================================

const crypto = require("crypto");

// Vercel 連接 Upstash 後會自動提供這兩個環境變數（兩種名字都支援）
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const SCORE_BOARDS = {
  lixing: "bike:score:lixing",   // 力行校區
  guiren: "bike:score:guiren"    // 歸仁校區
};
const PLAYTIME = "bike:playtime";   // 遊玩時間（秒）
const USERS = "bike:users";         // 名字 → 密碼（雜湊過的）
const LAST_TIME = "bike:lasttime";  // 每個人上次回報遊玩時間的時刻
const MAX_SCORE = 50000;            // 正常玩不可能超過的分數

// 一次送出好幾個 Redis 指令
async function redis(commands) {
  const res = await fetch(REDIS_URL + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(commands)
  });
  if (!res.ok) throw new Error("redis " + res.status);
  const data = await res.json();
  return data.map(d => {
    if (d.error) throw new Error(d.error);
    return d.result;
  });
}

// 整理名字：去掉看不見的字元和前後空白，最多 12 個字
function cleanName(name) {
  if (typeof name !== "string") return null;
  name = name.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || Array.from(name).length > 12) return null;
  return name;
}

function hash(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

// 檢查這個名字是不是真的屬於這位玩家
async function isOwner(name, token) {
  const [stored] = await redis([["HGET", USERS, name.toLowerCase()]]);
  return !!stored && stored === hash(token);
}

// Redis 回傳的 [名字, 分數, 名字, 分數…] → [{ name, value }, …]
function toEntries(list) {
  const out = [];
  for (let i = 0; i + 1 < (list || []).length; i += 2) {
    out.push({ name: list[i], value: Number(list[i + 1]) });
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(503).json({ error: "no-storage" });   // 還沒在 Vercel 接上資料庫
  }

  try {
    // ----- 讀取排行榜 -----
    if (req.method === "GET") {
      const name = cleanName((req.query && req.query.name) || "");
      const boards = [["lixing", SCORE_BOARDS.lixing], ["guiren", SCORE_BOARDS.guiren], ["playtime", PLAYTIME]];
      const commands = [];
      for (const [, key] of boards) {
        commands.push(["ZREVRANGE", key, "0", "4", "WITHSCORES"]);   // 前五名
        commands.push(["ZCARD", key]);                                // 總共幾個人
        if (name) {
          commands.push(["ZREVRANK", key, name]);                     // 我的名次（從 0 開始）
          commands.push(["ZSCORE", key, name]);                       // 我的分數
        }
      }
      const out = await redis(commands);
      const result = {};
      let i = 0;
      for (const [label] of boards) {
        const top = toEntries(out[i++]);
        const total = Number(out[i++]) || 0;
        let me = null;
        if (name) {
          const rank = out[i++];
          const value = out[i++];
          if (rank !== null && rank !== undefined) me = { rank: Number(rank) + 1, value: Number(value) };
        }
        result[label] = { top: top, total: total, me: me };
      }
      return res.status(200).json(result);
    }

    if (req.method !== "POST") return res.status(405).json({ error: "method" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const name = cleanName(body.name);
    const token = body.token;
    if (!name || typeof token !== "string" || token.length < 16) {
      return res.status(400).json({ error: "bad-name" });
    }

    // ----- 註冊名字：沒人用過就登記給你；你自己的名字可以重複登入 -----
    if (body.action === "register") {
      const key = name.toLowerCase();
      const [isNew, stored] = await redis([["HSETNX", USERS, key, hash(token)], ["HGET", USERS, key]]);
      if (Number(isNew) === 1 || stored === hash(token)) return res.status(200).json({ ok: true });
      return res.status(409).json({ error: "taken" });
    }

    // 以下都要確認是名字的主人
    if (!(await isOwner(name, token))) return res.status(403).json({ error: "not-owner" });

    // ----- 上傳分數：只留最高分 -----
    if (body.action === "score") {
      const key = SCORE_BOARDS[body.level];
      const score = Math.floor(Number(body.score));
      if (!key || !Number.isFinite(score) || score < 0 || score > MAX_SCORE) {
        return res.status(400).json({ error: "bad-score" });
      }
      await redis([["ZADD", key, "GT", String(score), name]]);
      const [rank, best, total] = await redis([["ZREVRANK", key, name], ["ZSCORE", key, name], ["ZCARD", key]]);
      return res.status(200).json({ ok: true, rank: Number(rank) + 1, best: Number(best), total: Number(total) });
    }

    // ----- 累加遊玩時間：不能比真實經過的時間還多（防止亂灌）-----
    if (body.action === "time") {
      let seconds = Math.floor(Number(body.seconds));
      if (!Number.isFinite(seconds) || seconds <= 0) return res.status(400).json({ error: "bad-time" });
      const now = Math.floor(Date.now() / 1000);
      const [last] = await redis([["HGET", LAST_TIME, name]]);
      const since = last ? now - Number(last) : 600;
      seconds = Math.min(seconds, since + 10, 600);
      if (seconds <= 0) return res.status(200).json({ ok: true, added: 0 });
      const [, total] = await redis([["HSET", LAST_TIME, name, String(now)], ["ZINCRBY", PLAYTIME, String(seconds), name]]);
      return res.status(200).json({ ok: true, added: seconds, total: Number(total) });
    }

    return res.status(400).json({ error: "bad-action" });
  } catch (e) {
    return res.status(500).json({ error: "server", detail: String((e && e.message) || e) });
  }
};
