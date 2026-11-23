// 旗標訂餐系統 - 後端
// 啟動：npm start（會讀取 .env 中的 ANTHROPIC_API_KEY）
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 5500;
const ORDERS_FILE = path.join(here, "orders.json");
const MAX_PAGE_CHARS = 150_000; // 送給模型的網頁文字上限
const MAX_IMAGES = 5; // 網頁文字太少時，改送前幾張圖片給模型看

const client = new Anthropic();

// ---------- 抓取網頁 ----------

function isBlockedHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(host)) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
  return false;
}

function decodeEntities(str) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)[^>]*>/gi, "\n")
      .replace(/<\/t[dh]>/gi, " | ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function extractImageUrls(html, baseUrl) {
  const urls = [];
  for (const m of html.matchAll(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]), baseUrl);
      if (/^https?:$/.test(u.protocol) && !/\.svg(\?|$)/i.test(u.pathname) && !urls.includes(u.href)) urls.push(u.href);
    } catch { /* 忽略無效網址 */ }
    if (urls.length >= MAX_IMAGES) break;
  }
  return urls;
}

async function fetchMenuPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MenuAnalyzer/1.0)",
      "Accept": "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new UserError(`無法讀取菜單網址（HTTP ${res.status}）`);

  const type = res.headers.get("content-type") || "";
  if (type.startsWith("image/")) return { kind: "image", imageUrls: [res.url] };

  const html = await res.text();
  let text = htmlToText(html);
  const truncated = text.length > MAX_PAGE_CHARS;
  if (truncated) text = text.slice(0, MAX_PAGE_CHARS);
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "");
  // 文字很少（例如菜單是圖片），就附上網頁上的圖片
  const imageUrls = text.length < 300 ? extractImageUrls(html, res.url) : [];
  return { kind: "html", title, text, truncated, imageUrls };
}

// ---------- 用 Claude 擷取菜單 ----------

const MENU_SCHEMA = {
  type: "object",
  properties: {
    restaurant: { type: "string", description: "店名，找不到就留空字串" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "品名" },
          price: { type: "integer", description: "價格（新台幣，只填數字；多種尺寸取最低價）" },
          options: {
            type: "array",
            items: { type: "string" },
            description: "客製化選項，例如尺寸、甜度、冰塊、辣度、加料",
          },
        },
        required: ["name", "price", "options"],
        additionalProperties: false,
      },
    },
  },
  required: ["restaurant", "items"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `你是菜單擷取助手。從使用者提供的網頁內容或圖片中，找出所有可以點的餐點與飲料。
- 品名保持原文。
- price 填整數金額；同一品項有多種尺寸或價格時，填最低價，並把各尺寸（含價格差）放進 options，例如「大杯 +10」。
- options 放這個品項可選的客製化選項（尺寸、甜度、冰塊、辣度、主食、加料等）。菜單上寫的是整家店共用的選項（例如所有飲料都能選甜度冰塊）時，也套用到對應品項上。沒有選項就給 ["正常"]。
- 忽略導覽列、廣告、營業時間等非餐點內容。
- 如果內容裡根本沒有菜單，items 回傳空陣列。`;

async function analyzeWithClaude(page, url) {
  const content = [];
  for (const imageUrl of page.imageUrls) {
    content.push({ type: "image", source: { type: "url", url: imageUrl } });
  }
  let text = `菜單網址：${url}\n`;
  if (page.kind === "html") {
    text += `網頁標題：${page.title}\n\n網頁內容：\n${page.text || "（沒有文字內容）"}`;
  } else {
    text += "這個網址是一張菜單圖片。";
  }
  content.push({ type: "text", text });

  const response = await client.beta.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "medium",
      format: { type: "json_schema", schema: MENU_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") throw new UserError("模型拒絕處理這個網址的內容");
  if (response.stop_reason === "max_tokens") throw new UserError("菜單太長，分析結果被截斷");

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("模型沒有回傳結果");
  return JSON.parse(textBlock.text);
}

// ---------- HTTP 伺服器 ----------

class UserError extends Error {}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new UserError("請求內容太大");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new UserError("請求格式錯誤");
  }
}

async function handleAnalyze(req, res) {
  const { url } = await readJsonBody(req);
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    return sendJson(res, 400, { error: "網址格式不正確" });
  }
  if (!/^https?:$/.test(parsed.protocol)) return sendJson(res, 400, { error: "只支援 http / https 網址" });
  if (isBlockedHost(parsed.hostname)) return sendJson(res, 400, { error: "不允許分析內網位址" });

  const page = await fetchMenuPage(parsed.href);
  if (page.kind === "html" && !page.text && !page.imageUrls.length) {
    return sendJson(res, 422, { error: "這個網頁沒有可讀的內容（可能需要 JavaScript 才能顯示）" });
  }

  const menu = await analyzeWithClaude(page, parsed.href);
  const items = menu.items.map((it) => ({
    name: it.name,
    price: it.price,
    options: it.options.length ? it.options : ["正常"],
  }));
  console.log(`[analyze] ${parsed.href} -> ${items.length} 個品項`);
  sendJson(res, 200, {
    restaurant: menu.restaurant,
    items,
    warning: page.truncated ? `網頁內容太長，只分析了前 ${MAX_PAGE_CHARS} 個字` : undefined,
  });
}

async function loadOrders() {
  try {
    return JSON.parse(await fs.readFile(ORDERS_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function handleCreateOrder(req, res) {
  const order = await readJsonBody(req);
  const name = String(order.name || "").trim();
  const items = Array.isArray(order.items) ? order.items : [];
  if (!name) return sendJson(res, 400, { error: "請輸入姓名" });
  if (!items.length) return sendJson(res, 400, { error: "訂單沒有任何品項" });

  const clean = items.map((o) => ({
    name: String(o.name),
    price: Number(o.price) || 0,
    option: String(o.option || ""),
    quantity: Math.max(1, parseInt(o.quantity, 10) || 1),
    note: String(o.note || ""),
  }));
  const saved = {
    id: Date.now().toString(36),
    name,
    items: clean,
    total: clean.reduce((s, o) => s + o.price * o.quantity, 0),
    createdAt: new Date().toISOString(),
  };
  const orders = await loadOrders();
  orders.push(saved);
  await fs.writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2));
  console.log(`[order] ${name} 下單 $${saved.total}`);
  sendJson(res, 201, saved);
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (urlPath !== "/" && urlPath !== "/index.html") {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  const html = await fs.readFile(path.join(here, "index.html"));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://x");
    if (req.method === "POST" && pathname === "/api/analyze-menu") return await handleAnalyze(req, res);
    if (req.method === "POST" && pathname === "/api/orders") return await handleCreateOrder(req, res);
    if (req.method === "GET" && pathname === "/api/orders") return sendJson(res, 200, await loadOrders());
    if (req.method === "GET") return await serveStatic(req, res);
    sendJson(res, 405, { error: "Method not allowed" });
  } catch (err) {
    if (err instanceof UserError) return sendJson(res, 400, { error: err.message });
    if (err instanceof Anthropic.AuthenticationError) {
      return sendJson(res, 500, { error: "Claude API 金鑰無效或未設定，請在 .env 設定 ANTHROPIC_API_KEY" });
    }
    if (err instanceof Anthropic.RateLimitError) return sendJson(res, 429, { error: "請求太頻繁，請稍後再試" });
    if (err instanceof Anthropic.APIError) {
      console.error("[claude]", err.status, err.message);
      return sendJson(res, 502, { error: `Claude API 錯誤（${err.status ?? "連線失敗"}）` });
    }
    if (err.name === "TimeoutError") return sendJson(res, 504, { error: "讀取菜單網址逾時" });
    if (err instanceof TypeError && err.message === "fetch failed") {
      return sendJson(res, 400, { error: "無法連線到菜單網址" });
    }
    if (err.message?.includes("Could not resolve authentication method")) {
      return sendJson(res, 500, { error: "尚未設定 Claude API 金鑰，請在 .env 設定 ANTHROPIC_API_KEY" });
    }
    console.error(err);
    sendJson(res, 500, { error: "伺服器錯誤" });
  }
});

server.listen(PORT, () => {
  console.log(`旗標訂餐系統已啟動：http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠ 尚未設定 ANTHROPIC_API_KEY，分析菜單會失敗");
});
