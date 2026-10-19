// Variables used by Scriptable.
// icon-color: deep-gray; icon-glyph: tachometer-alt;

// Claude 額度小工具：顯示 5 小時與每週的已用額度和重置時間。
// 在 Scriptable app 裡執行，選「登入 Claude」在 App 內登入一次即可（不用電腦）。
// 加到主畫面當「中」尺寸 widget 使用。
// 點 widget 會打開 Scriptable 重新抓資料（等於「更新剩餘額度」）。

const KC = {
  claudeSession: "aiusage.claude.sessionKey",
  claudePlan: "aiusage.claude.plan",
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
    0; // 最後一行要回傳簡單的值，回傳 Promise 會讓 Scriptable 報錯
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
    const m = document.cookie.match(/(?:^|; )sessionKey=([^;]+)/);
    done({
      org: { uuid: org.uuid, capabilities: org.capabilities, raven_type: org.raven_type },
      usage: await u.json(),
      sessionKey: m ? decodeURIComponent(m[1]) : null,
    });
  `
  );
}

async function fetchClaude() {
  // 小工具和 App 是分開執行的，App 內的登入狀態小工具不一定讀得到。
  // 所以 App 內登入成功時順便把 sessionKey 存進鑰匙圈，小工具就能用。
  const session = kcGet(KC.claudeSession);
  let res = null;
  let keyError = null;
  if (session) {
    try {
      res = await claudeViaKey(session);
    } catch (e) {
      keyError = e;
    }
  }
  if (!res) {
    try {
      res = await claudeViaWeb();
    } catch (e) {
      throw keyError && e.message === "尚未設定" ? keyError : e;
    }
    if (res.sessionKey && res.sessionKey !== session) kcSet(KC.claudeSession, res.sessionKey);
  }
  const { org, usage } = res;

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
    // App 內沒登入就提示登入；小工具抓不到時先顯示上次在 App 裡抓到的資料
    if (old && (config.runsInWidget || e.message !== "尚未設定")) {
      const elapsed = (Date.now() - old.at) / 1000;
      const data = JSON.parse(JSON.stringify(old.data));
      data.rows.forEach((r) => {
        if (r.resetIn != null) r.resetIn -= elapsed;
      });
      data.stale = e.message;
      data.staleMinutes = Math.max(0, Math.round(elapsed / 60));
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

function addColumn(parent, r, width) {
  const col = parent.addStack();
  col.layoutVertically();
  col.size = new Size(width, 0);
  addRow(col, r, COLORS.claude, width);
}

function buildWidget(claude) {
  const w = new ListWidget();
  w.backgroundColor = COLORS.bg;
  w.setPadding(14, 16, 12, 16);
  w.url = `scriptable:///run?scriptName=${encodeURIComponent(Script.name())}&refresh=1`;

  addHeader(w, "Claude", "asterisk", COLORS.claude, claude.plan);
  w.addSpacer(10);

  if (claude.error) {
    const e = w.addText(claude.error === "尚未設定" ? "尚未登入，請打開 Scriptable 執行此腳本登入" : claude.error);
    e.font = Font.systemFont(12);
    e.textColor = COLORS.error;
    e.minimumScaleFactor = 0.7;
  } else {
    const colWidth = 136;
    const cols = w.addStack();
    cols.topAlignContent();
    claude.rows.forEach((r, i) => {
      if (i > 0) {
        cols.addSpacer(10);
        const div = cols.addStack();
        div.backgroundColor = COLORS.divider;
        div.size = new Size(1, 44);
        cols.addSpacer(10);
      }
      addColumn(cols, r, colWidth);
    });
    if (claude.stale) {
      w.addSpacer(4);
      const m = claude.staleMinutes;
      const ago = m < 60 ? `${m} 分鐘` : m < 1440 ? `${Math.round(m / 60)} 小時` : `${Math.round(m / 1440)} 天`;
      const st = w.addText(`上次更新 ${ago}前 · 點一下更新`);
      st.font = Font.systemFont(9);
      st.textColor = COLORS.sub;
    }
  }

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
  a.title = "Claude 額度小工具";
  a.message = "第一次使用請先登入 Claude（建議用 email 驗證碼登入，Google 登入可能被擋）。登入完按左上角「完成」。";
  a.addAction("預覽小工具");
  a.addAction("登入 Claude");
  a.addAction("進階：手動貼金鑰");
  a.addDestructiveAction("清除全部設定");
  a.addCancelAction("取消");
  const choice = await a.presentSheet();

  if (choice === 1) {
    await webLogin("https://claude.ai/login");
  } else if (choice === 2) {
    return await advanced();
  } else if (choice === 3) {
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
  a.addAction("自訂 Claude 方案名稱");
  a.addCancelAction("取消");
  const choice = await a.presentSheet();

  if (choice === 0) {
    const v = await askText("Claude sessionKey", "claude.ai 的 sessionKey cookie（sk-ant-sid01-…），留空改回 App 內登入", kcGet(KC.claudeSession), "sk-ant-sid01-...");
    if (v != null) kcSet(KC.claudeSession, v);
  } else if (choice === 1) {
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
  const claude = await load("claude", fetchClaude, cache);
  saveCache(cache);
  return buildWidget(claude);
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
