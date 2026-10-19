// Variables used by Scriptable.
// icon-color: deep-gray; icon-glyph: tachometer-alt;

// AI 額度小工具：同時顯示 Claude 與 Codex 的用量與重置時間。
// 在 Scriptable app 裡執行，選「登入 Claude」「登入 ChatGPT」在 App 內登入一次即可（不用電腦）。
// 加到主畫面當「中」尺寸 widget 使用。
// 點 widget 會打開 Scriptable 重新抓資料（等於「更新剩餘額度」）。

const KC = {
  claudeSession: "aiusage.claude.sessionKey",
  claudePlan: "aiusage.claude.plan",
  codexToken: "aiusage.codex.token",
  codexAccount: "aiusage.codex.accountId",
};

const COLORS = {
  bg: new Color("#161C27"),
  divider: new Color("#2A3242"),
  title: Color.white(),
  badgeBg: new Color("#2A3242"),
  badgeText: new Color("#C9D1DC"),
  label: new Color("#AEB7C4"),
  sub: new Color("#7D8796"),
  track: new Color("#2E3646"),
  claude: new Color("#F08A4B"),
  codex: new Color("#3FD0B5"),
  buttonBg: new Color("#20393A"),
  buttonText: new Color("#3FD0B5"),
  error: new Color("#FF7A7A"),
};

const CACHE_FILE = (() => {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), "ai-usage-cache.json");
})();

// ---------- 工具 ----------

function kcGet(key) {
  return Keychain.contains(key) ? Keychain.get(key) : "";
}

function kcSet(key, value) {
  if (value) Keychain.set(key, value);
  else if (Keychain.contains(key)) Keychain.remove(key);
}

function formatReset(seconds) {
  if (seconds == null || isNaN(seconds)) return "—";
  let s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return `${d}天${h}小時`;
  if (h > 0) return `${h}小時${m}分鐘`;
  return `${m}分鐘${s}秒`;
}

function windowLabel(seconds) {
  if (!seconds) return "用量";
  if (seconds >= 6 * 86400) return "每週";
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} 天`;
  return `${Math.round(seconds / 3600)} 小時`;
}

function secondsUntil(isoOrEpoch) {
  if (isoOrEpoch == null) return null;
  const t =
    typeof isoOrEpoch === "number"
      ? isoOrEpoch * (isoOrEpoch < 1e12 ? 1000 : 1)
      : Date.parse(isoOrEpoch);
  if (isNaN(t)) return null;
  return (t - Date.now()) / 1000;
}

function clampPct(v) {
  const n = Number(v);
  if (isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

async function getJSON(url, headers) {
  const req = new Request(url);
  req.headers = Object.assign(
    {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    },
    headers
  );
  req.timeoutInterval = 20;
  let body;
  try {
    body = await req.loadJSON();
  } catch (e) {
    const code = req.response && req.response.statusCode;
    throw new Error(code ? `HTTP ${code}` : "連線失敗");
  }
  const code = req.response && req.response.statusCode;
  if (code && code >= 400) throw new Error(code === 401 || code === 403 ? "金鑰失效" : `HTTP ${code}`);
  return body;
}

// ---------- App 內登入（WebView） ----------
// Scriptable 的 WebView 會記住登入狀態，之後在該網站裡用 fetch 讀資料，
// cookie 由瀏覽器自己帶，所以不用手動複製 sessionKey。

async function webLogin(url) {
  const wv = new WebView();
  await wv.loadURL(url);
  await wv.present(true); // 使用者登入完按「完成」關掉
}

// 在指定網站裡執行一段 async 程式，回傳 JSON。程式裡用 done(值) 回傳。
async function webRun(origin, body) {
  const wv = new WebView();
  await wv.loadURL(origin + "/robots.txt");
  const js = `
    const done = (v) => completion(JSON.stringify(v));
    (async () => { ${body} })().catch((e) => done({ error: String(e && e.message || e) }));
  `;
  const raw = await wv.evaluateJavaScript(js, true);
  const out = JSON.parse(raw);
  if (out && out.error) throw new Error(out.error);
  return out;
}

// ---------- Claude ----------

function claudePlanName(org) {
  const caps = (org && org.capabilities) || [];
  const joined = caps.join(",");
  if (org && org.raven_type) return org.raven_type === "enterprise" ? "Enterprise" : "Team";
  if (/raven|team/.test(joined)) return "Team";
  if (/enterprise/.test(joined)) return "Enterprise";
  if (/claude_max/.test(joined)) return "Max";
  if (/claude_pro/.test(joined)) return "Pro";
  return "Free";
}

async function claudeViaKey(session) {
  const headers = { Cookie: `sessionKey=${session}` };
  const orgs = await getJSON("https://claude.ai/api/organizations", headers);
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error("找不到組織");
  const org = orgs.find((o) => (o.capabilities || []).includes("chat")) || orgs[0];
  const usage = await getJSON(
    `https://claude.ai/api/organizations/${org.uuid}/usage`,
    headers
  );
  return { org, usage };
}

function claudeViaWeb() {
  return webRun(
    "https://claude.ai",
    `
    const r = await fetch("/api/organizations", { credentials: "include" });
    if (r.status === 401 || r.status === 403) return done({ error: "尚未設定" });
    if (!r.ok) return done({ error: "HTTP " + r.status });
    const orgs = await r.json();
    if (!Array.isArray(orgs) || !orgs.length) return done({ error: "找不到組織" });
    const org = orgs.find((o) => (o.capabilities || []).includes("chat")) || orgs[0];
    const u = await fetch("/api/organizations/" + org.uuid + "/usage", { credentials: "include" });
    if (!u.ok) return done({ error: "HTTP " + u.status });
    done({ org: { uuid: org.uuid, capabilities: org.capabilities, raven_type: org.raven_type }, usage: await u.json() });
  `
  );
}

async function fetchClaude() {
  const session = kcGet(KC.claudeSession);
  const { org, usage } = session ? await claudeViaKey(session) : await claudeViaWeb();

  const rows = [];
  const add = (label, w) => {
    if (!w || w.utilization == null) return;
    rows.push({
      label,
      pct: clampPct(w.utilization),
      resetIn: secondsUntil(w.resets_at),
    });
  };
  add("5 小時", usage.five_hour);
  add("每週", usage.seven_day);
  if (rows.length === 0) throw new Error("沒有用量資料");

  return {
    plan: kcGet(KC.claudePlan) || claudePlanName(org),
    rows,
  };
}

// ---------- Codex (ChatGPT) ----------

function codexPlanName(raw) {
  if (!raw) return "";
  const map = {
    free: "Free",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    pro_lite: "Pro Lite",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
  };
  return map[String(raw).toLowerCase()] || String(raw);
}

async function codexViaToken(token) {
  token = token.replace(/^Bearer\s+/i, "");
  const headers = { Authorization: `Bearer ${token}` };
  const account = kcGet(KC.codexAccount);
  if (account) headers["ChatGPT-Account-Id"] = account;
  return getJSON("https://chatgpt.com/backend-api/wham/usage", headers);
}

function codexViaWeb() {
  const account = kcGet(KC.codexAccount);
  return webRun(
    "https://chatgpt.com",
    `
    const s = await fetch("/api/auth/session", { credentials: "include" });
    const session = s.ok ? await s.json() : {};
    if (!session.accessToken) return done({ error: "尚未設定" });
    const headers = { Authorization: "Bearer " + session.accessToken };
    const account = ${JSON.stringify(account)};
    if (account) headers["ChatGPT-Account-Id"] = account;
    const r = await fetch("/backend-api/wham/usage", { headers, credentials: "include" });
    if (r.status === 401 || r.status === 403) return done({ error: "尚未設定" });
    if (!r.ok) return done({ error: "HTTP " + r.status });
    done(await r.json());
  `
  );
}

async function fetchCodex() {
  const token = kcGet(KC.codexToken);
  const data = token ? await codexViaToken(token) : await codexViaWeb();
  const rl = data.rate_limit || {};
  const rows = [];
  for (const w of [rl.primary_window, rl.secondary_window]) {
    if (!w) continue;
    const resetIn =
      w.reset_after_seconds != null ? w.reset_after_seconds : secondsUntil(w.reset_at);
    rows.push({
      label: windowLabel(w.limit_window_seconds),
      pct: clampPct(w.used_percent),
      resetIn,
    });
  }
  if (rows.length === 0) throw new Error("沒有用量資料");
  return { plan: codexPlanName(data.plan_type), rows };
}

// ---------- 快取 ----------

function loadCache() {
  const fm = FileManager.local();
  if (!fm.fileExists(CACHE_FILE)) return {};
  try {
    return JSON.parse(fm.readString(CACHE_FILE));
  } catch (e) {
    return {};
  }
}

function saveCache(cache) {
  FileManager.local().writeString(CACHE_FILE, JSON.stringify(cache));
}

// 抓不到就用上次的資料，並依經過時間扣掉倒數。
async function load(name, fetcher, cache) {
  try {
    const data = await fetcher();
    cache[name] = { at: Date.now(), data };
    return data;
  } catch (e) {
    const old = cache[name];
    if (old && e.message !== "尚未設定") {
      const elapsed = (Date.now() - old.at) / 1000;
      const data = JSON.parse(JSON.stringify(old.data));
      data.rows.forEach((r) => {
        if (r.resetIn != null) r.resetIn -= elapsed;
      });
      data.stale = e.message;
      return data;
    }
    return { error: e.message };
  }
}

// ---------- 畫面 ----------

function barImage(pct, color) {
  const w = 300;
  const h = 10;
  const ctx = new DrawContext();
  ctx.size = new Size(w, h);
  ctx.opaque = false;
  ctx.respectScreenScale = true;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, w, h), h / 2, h / 2);
  ctx.addPath(track);
  ctx.setFillColor(COLORS.track);
  ctx.fillPath();
  if (pct > 0) {
    const fw = Math.max(h, (w * pct) / 100);
    const fill = new Path();
    fill.addRoundedRect(new Rect(0, 0, fw, h), h / 2, h / 2);
    ctx.addPath(fill);
    ctx.setFillColor(color);
    ctx.fillPath();
  }
  return ctx.getImage();
}

function addHeader(stack, name, symbol, iconColor, plan) {
  const row = stack.addStack();
  row.centerAlignContent();
  const sym = SFSymbol.named(symbol);
  sym.applyFont(Font.boldSystemFont(14));
  const icon = row.addImage(sym.image);
  icon.imageSize = new Size(16, 16);
  icon.tintColor = iconColor;
  row.addSpacer(5);
  const t = row.addText(name);
  t.font = Font.boldSystemFont(15);
  t.textColor = COLORS.title;
  if (plan) {
    row.addSpacer(6);
    const badge = row.addStack();
    badge.backgroundColor = COLORS.badgeBg;
    badge.cornerRadius = 5;
    badge.setPadding(2, 6, 2, 6);
    const bt = badge.addText(plan);
    bt.font = Font.mediumSystemFont(10);
    bt.textColor = COLORS.badgeText;
  }
  row.addSpacer();
}

function addRow(stack, r, color, barWidth) {
  const top = stack.addStack();
  top.bottomAlignContent();
  const l = top.addText(r.label);
  l.font = Font.mediumSystemFont(11);
  l.textColor = COLORS.label;
  top.addSpacer();
  const p = top.addText(`${r.pct}%`);
  p.font = Font.boldRoundedSystemFont(15);
  p.textColor = COLORS.title;

  stack.addSpacer(3);
  const bar = stack.addImage(barImage(r.pct, color));
  bar.imageSize = new Size(barWidth, 4);
  stack.addSpacer(3);

  const s = stack.addText(`重置 ${formatReset(r.resetIn)}`);
  s.font = Font.systemFont(10);
  s.textColor = COLORS.sub;
}

function addColumn(parent, name, symbol, color, data, barWidth) {
  const col = parent.addStack();
  col.layoutVertically();
  col.size = new Size(barWidth, 0);
  addHeader(col, name, symbol, color, data.plan);
  col.addSpacer(8);

  if (data.error) {
    const e = col.addText(data.error === "尚未設定" ? "尚未登入，請打開 Scriptable 執行此腳本登入" : data.error);
    e.font = Font.systemFont(11);
    e.textColor = COLORS.error;
    e.minimumScaleFactor = 0.7;
    col.addSpacer();
    return;
  }

  data.rows.forEach((r, i) => {
    if (i > 0) col.addSpacer(8);
    addRow(col, r, color, barWidth);
  });
  if (data.stale) {
    col.addSpacer(4);
    const st = col.addText(`⚠︎ 舊資料（${data.stale}）`);
    st.font = Font.systemFont(9);
    st.textColor = COLORS.sub;
  }
  col.addSpacer();
}

function buildWidget(claude, codex) {
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.setPadding(12, 14, 12, 14);
  w.url = `scriptable:///run?scriptName=${encodeURIComponent(Script.name())}&refresh=1`;

  const barWidth = 138;
  const cols = w.addStack();
  cols.topAlignContent();
  addColumn(cols, "Claude", "asterisk", COLORS.claude, claude, barWidth);
  cols.addSpacer(10);
  const div = cols.addStack();
  div.backgroundColor = COLORS.divider;
  div.size = new Size(1, 96);
  cols.addSpacer(10);
  addColumn(cols, "Codex", "circle.hexagongrid", COLORS.title, codex, barWidth);

  w.addSpacer();

  const btn = w.addStack();
  btn.backgroundColor = COLORS.buttonBg;
  btn.cornerRadius = 10;
  btn.setPadding(6, 0, 6, 0);
  btn.centerAlignContent();
  btn.addSpacer();
  const sym = SFSymbol.named("arrow.clockwise");
  sym.applyFont(Font.boldSystemFont(12));
  const ic = btn.addImage(sym.image);
  ic.imageSize = new Size(12, 12);
  ic.tintColor = COLORS.buttonText;
  btn.addSpacer(5);
  const bt = btn.addText("更新剩餘額度");
  bt.font = Font.boldSystemFont(12);
  bt.textColor = COLORS.buttonText;
  btn.addSpacer();

  // 系統不保證準時，只是提示 iOS 15 分鐘後可以再更新。
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  return w;
}

// ---------- 設定 ----------

async function askText(title, message, current, placeholder) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addSecureTextField(placeholder, current);
  a.addAction("儲存");
  a.addCancelAction("取消");
  const i = await a.presentAlert();
  if (i === -1) return null;
  return a.textFieldValue(0).trim();
}

async function settings() {
  const a = new Alert();
  a.title = "AI 額度小工具";
  a.message = "第一次使用請先登入 Claude 和 ChatGPT（建議用 email 驗證碼登入，Google 登入可能被擋）。登入完按左上角「完成」。";
  a.addAction("預覽小工具");
  a.addAction("登入 Claude");
  a.addAction("登入 ChatGPT（Codex）");
  a.addAction("進階：手動貼金鑰");
  a.addDestructiveAction("清除全部設定");
  a.addCancelAction("取消");
  const choice = await a.presentSheet();

  if (choice === 1) {
    await webLogin("https://claude.ai/login");
  } else if (choice === 2) {
    await webLogin("https://chatgpt.com/auth/login");
  } else if (choice === 3) {
    return await advanced();
  } else if (choice === 4) {
    Object.values(KC).forEach((k) => kcSet(k, ""));
    saveCache({});
  } else if (choice === -1) {
    return false;
  }
  return true;
}

async function advanced() {
  const a = new Alert();
  a.title = "進階設定";
  a.message = "有填金鑰就優先用金鑰，沒填就用 App 內登入。";
  a.addAction(`Claude sessionKey${kcGet(KC.claudeSession) ? " ✓" : ""}`);
  a.addAction(`Codex token${kcGet(KC.codexToken) ? " ✓" : ""}`);
  a.addAction("Codex 帳號 ID（多個工作區才需要）");
  a.addAction("自訂 Claude 方案名稱");
  a.addCancelAction("取消");
  const choice = await a.presentSheet();

  if (choice === 0) {
    const v = await askText("Claude sessionKey", "claude.ai 的 sessionKey cookie（sk-ant-sid01-…），留空改回 App 內登入", kcGet(KC.claudeSession), "sk-ant-sid01-...");
    if (v != null) kcSet(KC.claudeSession, v);
  } else if (choice === 1) {
    const v = await askText("Codex token", "chatgpt.com/api/auth/session 的 accessToken，或 ~/.codex/auth.json 的 access_token，留空改回 App 內登入", kcGet(KC.codexToken), "eyJ...");
    if (v != null) kcSet(KC.codexToken, v);
  } else if (choice === 2) {
    const v = await askText("Codex 帳號 ID", "~/.codex/auth.json 裡的 account_id", kcGet(KC.codexAccount), "account_id");
    if (v != null) kcSet(KC.codexAccount, v);
  } else if (choice === 3) {
    const v = await askText("Claude 方案名稱", "留空就自動判斷（例如 Team、Max、Pro）", kcGet(KC.claudePlan), "Team");
    if (v != null) kcSet(KC.claudePlan, v);
  } else {
    return false;
  }
  return true;
}

// ---------- 主程式 ----------

async function render() {
  const cache = loadCache();
  const [claude, codex] = await Promise.all([
    load("claude", fetchClaude, cache),
    load("codex", fetchCodex, cache),
  ]);
  saveCache(cache);
  return buildWidget(claude, codex);
}

const fromWidgetTap = args.queryParameters && args.queryParameters.refresh === "1";

if (config.runsInWidget) {
  Script.setWidget(await render());
} else if (fromWidgetTap) {
  // 從 widget 點進來：重抓並顯示
  await (await render()).presentMedium();
} else if (await settings()) {
  await (await render()).presentMedium();
}

Script.complete();
