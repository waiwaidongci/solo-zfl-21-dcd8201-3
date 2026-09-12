const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = process.env.CLOCK_DB_FILE || path.join(__dirname, "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ]
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /dashboard",
  "GET /clocks/:id/dashboard",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

// 数值字段合法区间（日差：秒/天，摆幅：度）
const RANGE = {
  targetDailyRateSeconds: { min: 0, max: 600, label: "目标日差" },
  currentDailyRateSeconds: { min: -3600, max: 3600, label: "当前日差" },
  dailyRateSeconds: { min: -3600, max: 3600, label: "复测日差" },
  amplitude: { min: 0, max: 360, label: "摆幅" }
};

// 解析并校验数值字段：空值、非数字、布尔、NaN、越界均返回 400。
// required=false 且字段缺省时返回 defaultValue；显式传 null/空串仍按空值报错。
function parseNumberField(body, field, { required = false, defaultValue } = {}) {
  const rule = RANGE[field];
  const raw = body[field];
  const isEmpty = raw === undefined || raw === null
    || (typeof raw === "string" && raw.trim() === "");

  if (isEmpty) {
    if (!required && raw === undefined) return defaultValue;
    const error = new Error(`${rule.label}不能为空`);
    error.status = 400;
    throw error;
  }

  if (typeof raw === "boolean" || (typeof raw === "object")) {
    const error = new Error(`${rule.label}必须是数字`);
    error.status = 400;
    throw error;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    const error = new Error(`${rule.label}必须是可解析的数字，收到：${String(raw)}`);
    error.status = 400;
    throw error;
  }

  if (value < rule.min || value > rule.max) {
    const error = new Error(`${rule.label}超出允许范围（${rule.min} 到 ${rule.max}），收到：${value}`);
    error.status = 400;
    throw error;
  }

  return value;
}

// 解析复测时间：字段缺失时使用当前时间；空值、非字符串或不可解析的时间一律 400。
// 合法字符串原样保留（沿用旧接口返回内容），仅用于排序时再解析。
function parseTestedAt(body) {
  const raw = body.testedAt;
  if (raw === undefined) return new Date().toISOString();

  if (typeof raw !== "string" || raw.trim() === "") {
    const error = new Error("测试时间必须是可解析的时间字符串");
    error.status = 400;
    throw error;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`测试时间格式无法解析：${raw}`);
    error.status = 400;
    throw error;
  }

  return raw;
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function average(values) {
  if (!values.length) return null;
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// 单只钟表的看板数据
function dashboardRow(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustmentCount = db.adjustments.filter((item) => item.clockId === clock.id).length;
  const retestCount = db.retests.filter((item) => item.clockId === clock.id).length;
  return {
    clockId: clock.id,
    code: clock.code,
    targetDailyRateSeconds: clock.targetDailyRateSeconds,
    latestDailyRateSeconds: retest ? retest.dailyRateSeconds : null,
    amplitude: retest ? retest.amplitude : null,
    qualified: retest ? retest.qualified : false,
    adjustmentCount,
    retestCount
  };
}

// 全局汇总（始终基于全部钟表，不受筛选参数影响）
function dashboardSummary(rows) {
  const qualifiedCount = rows.filter((row) => row.qualified).length;
  const retested = rows.filter((row) => row.latestDailyRateSeconds !== null);
  return {
    totalClockCount: rows.length,
    pendingCount: rows.length - qualifiedCount,
    qualifiedCount,
    averageLatestDailyRateSeconds: average(retested.map((row) => row.latestDailyRateSeconds)),
    averageAmplitude: average(retested.map((row) => row.amplitude))
  };
}

// 看板的合格筛选参数仅接受 true / false，非法值返回 400
function parseQualifiedParam(value) {
  if (value === null) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  const error = new Error("非法筛选参数：qualified 只能是 true 或 false");
  error.status = 400;
  throw error;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const targetDailyRateSeconds = parseNumberField(body, "targetDailyRateSeconds", { defaultValue: 30 });
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.clocks.push(clock);
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/dashboard") {
    const expected = parseQualifiedParam(url.searchParams.get("qualified"));
    if (db.clocks.length === 0) {
      const error = new Error("暂无钟表数据，无法生成看板");
      error.status = 400;
      throw error;
    }
    const allRows = db.clocks.map((clock) => dashboardRow(db, clock));
    const data = expected === null ? allRows : allRows.filter((row) => row.qualified === expected);
    // 汇总始终基于全部钟表，不受 qualified 筛选影响
    return send(res, 200, { data, summary: dashboardSummary(allRows) });
  }

  const clockDashboardMatch = pathname.match(/^\/clocks\/([^/]+)\/dashboard$/);
  if (clockDashboardMatch && req.method === "GET") {
    const clock = findClock(db, clockDashboardMatch[1]);
    return send(res, 200, { data: dashboardRow(db, clock) });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    return send(res, 200, { data: { clock, adjustments, retests, latestRetest: latestRetest(db, clock.id) } });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const currentDailyRateSeconds = parseNumberField(body, "currentDailyRateSeconds", { required: true });
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds,
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    await writeDb(db);
    return send(res, 201, { data: adjustment });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const dailyRateSeconds = parseNumberField(body, "dailyRateSeconds", { required: true });
    const amplitude = parseNumberField(body, "amplitude", { required: true });
    const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
    const qualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(dailyRateSeconds) <= Number(clock.targetDailyRateSeconds);
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId,
      testedAt: parseTestedAt(body),
      dailyRateSeconds,
      amplitude,
      qualified,
      note: body.note || ""
    };
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: retest, clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  if (!process.env.CLOCK_TEST) {
    console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
  }
});

module.exports = { server, routes };
