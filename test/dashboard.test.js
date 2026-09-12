"use strict";

// 调校质量看板接口测试：node --test
// 覆盖：正常统计、空数据、合格筛选、非法筛选参数、未知钟表、旧接口兼容。
// 通过子进程启动真实 HTTP 服务，使用临时 db.json 隔离，不依赖任何第三方包。

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { writeFile, rm } = require("fs/promises");
const path = require("node:path");
const os = require("node:os");

const PORT = 31321;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `clock-dashboard-test-${process.pid}.json`);

let server;

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function waitForServer() {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // 服务尚未启动，继续重试
    }
    if (Date.now() > deadline) throw new Error("测试服务启动超时");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

before(async () => {
  await writeFile(DB_FILE, JSON.stringify({ clocks: [], adjustments: [], retests: [] }));
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), CLOCK_DB_FILE: DB_FILE, CLOCK_TEST: "1" },
    stdio: "ignore"
  });
  await waitForServer();
});

after(async () => {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.on("exit", resolve));
  await rm(DB_FILE, { force: true });
});

describe("调校质量看板", () => {
  test("空数据：看板返回空列表和零值/空均值汇总", async () => {
    const { status, json } = await api("GET", "/dashboard");
    assert.equal(status, 200);
    assert.deepEqual(json.data, []);
    assert.deepEqual(json.summary, {
      totalClockCount: 0,
      pendingCount: 0,
      qualifiedCount: 0,
      averageLatestDailyRateSeconds: null,
      averageAmplitude: null
    });
  });

  test("正常统计：目标日差、最近复测、摆幅、合格状态与累计次数正确", async () => {
    // 钟表A：2次调校、3次复测，最近一次合格（日差10、摆幅270）
    const clockA = (await api("POST", "/clocks", {
      code: "CLK-A",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 15
    })).json.data;
    await api("POST", `/clocks/${clockA.id}/adjustments`, {
      currentDailyRateSeconds: 68, direction: "慢针方向", amount: "微调0.4格"
    });
    await api("POST", `/clocks/${clockA.id}/retests`, {
      dailyRateSeconds: 60, amplitude: 200, qualified: false, testedAt: "2026-09-01T00:00:00.000Z"
    });
    await api("POST", `/clocks/${clockA.id}/retests`, {
      dailyRateSeconds: 40, amplitude: 220, qualified: false, testedAt: "2026-09-02T00:00:00.000Z"
    });
    await api("POST", `/clocks/${clockA.id}/adjustments`, {
      currentDailyRateSeconds: 40, direction: "慢针方向", amount: "再微调0.2格"
    });
    await api("POST", `/clocks/${clockA.id}/retests`, {
      dailyRateSeconds: 10, amplitude: 270, qualified: true, testedAt: "2026-09-03T00:00:00.000Z"
    });

    // 钟表B：1次调校、1次复测，日差31超出目标20，不合格
    const clockB = (await api("POST", "/clocks", {
      code: "CLK-B",
      escapementType: "圆柱式",
      balanceFrequency: "21600vph",
      targetDailyRateSeconds: 20
    })).json.data;
    await api("POST", `/clocks/${clockB.id}/adjustments`, {
      currentDailyRateSeconds: 55, direction: "慢针方向", amount: "微调0.3格"
    });
    await api("POST", `/clocks/${clockB.id}/retests`, {
      dailyRateSeconds: 31, amplitude: 248, qualified: false, testedAt: "2026-09-04T00:00:00.000Z"
    });

    // 钟表C：从未调校、从未复测，属于待调
    const clockC = (await api("POST", "/clocks", {
      code: "CLK-C",
      escapementType: "同轴式",
      balanceFrequency: "28800vph",
      targetDailyRateSeconds: 30
    })).json.data;

    const { status, json } = await api("GET", "/dashboard");
    assert.equal(status, 200);
    assert.equal(json.data.length, 3);

    const rowA = json.data.find((row) => row.clockId === clockA.id);
    assert.deepEqual(rowA, {
      clockId: clockA.id,
      code: "CLK-A",
      targetDailyRateSeconds: 15,
      latestDailyRateSeconds: 10,
      amplitude: 270,
      qualified: true,
      adjustmentCount: 2,
      retestCount: 3
    });

    const rowB = json.data.find((row) => row.clockId === clockB.id);
    assert.equal(rowB.latestDailyRateSeconds, 31);
    assert.equal(rowB.amplitude, 248);
    assert.equal(rowB.qualified, false);
    assert.equal(rowB.adjustmentCount, 1);
    assert.equal(rowB.retestCount, 1);

    const rowC = json.data.find((row) => row.clockId === clockC.id);
    assert.equal(rowC.latestDailyRateSeconds, null);
    assert.equal(rowC.amplitude, null);
    assert.equal(rowC.qualified, false);
    assert.equal(rowC.adjustmentCount, 0);
    assert.equal(rowC.retestCount, 0);

    // 全局汇总：1只合格、2只待调；均值仅统计有复测的A、B
    assert.deepEqual(json.summary, {
      totalClockCount: 3,
      pendingCount: 2,
      qualifiedCount: 1,
      averageLatestDailyRateSeconds: 20.5, // (10 + 31) / 2
      averageAmplitude: 259 // (270 + 248) / 2
    });
  });

  test("筛选 qualified=true 只返回合格钟表，汇总仍基于全部钟表", async () => {
    const { status, json } = await api("GET", "/dashboard?qualified=true");
    assert.equal(status, 200);
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].code, "CLK-A");
    assert.equal(json.data[0].qualified, true);
    assert.equal(json.summary.totalClockCount, 3);
    assert.equal(json.summary.qualifiedCount, 1);
    assert.equal(json.summary.pendingCount, 2);
  });

  test("筛选 qualified=false 返回不合格与待调钟表", async () => {
    const { status, json } = await api("GET", "/dashboard?qualified=false");
    assert.equal(status, 200);
    assert.deepEqual(json.data.map((row) => row.code).sort(), ["CLK-B", "CLK-C"]);
    assert.ok(json.data.every((row) => row.qualified === false));
    assert.equal(json.summary.totalClockCount, 3);
  });

  test("非法筛选参数返回 400 明确错误", async () => {
    for (const bad of ["yes", "1", "", "TRUE"]) {
      const { status, json } = await api("GET", `/dashboard?qualified=${encodeURIComponent(bad)}`);
      assert.equal(status, 400, `qualified=${bad} 应返回400`);
      assert.match(json.error, /qualified/);
    }
  });

  test("未知钟表的单表看板返回 404 明确错误", async () => {
    const { status, json } = await api("GET", "/clocks/clock_not_exist/dashboard");
    assert.equal(status, 404);
    assert.equal(json.error, "钟表不存在");
  });

  test("单表看板返回该钟表的统计", async () => {
    const list = await api("GET", "/dashboard");
    const clockAId = list.json.data[0].clockId;
    const { status, json } = await api("GET", `/clocks/${clockAId}/dashboard`);
    assert.equal(status, 200);
    assert.equal(json.data.clockId, clockAId);
    assert.equal(json.data.latestDailyRateSeconds, 10);
    assert.equal(json.data.adjustmentCount, 2);
    assert.equal(json.data.retestCount, 3);
    assert.equal(json.data.qualified, true);
  });

  test("旧接口保持不变", async () => {
    // /clocks 仍是旧结构（含 latestAdjustment / latestRetest / qualified 展开字段）
    const clocks = await api("GET", "/clocks");
    assert.equal(clocks.status, 200);
    assert.equal(clocks.json.data.length, 3);
    const clockA = clocks.json.data.find((item) => item.code === "CLK-A");
    assert.ok(clockA.latestAdjustment);
    assert.equal(clockA.latestAdjustment.amount, "再微调0.2格");
    assert.equal(clockA.latestRetest.dailyRateSeconds, 10);
    assert.equal(clockA.qualified, true);

    // 旧的合格筛选（任何非 true 值都视为 false 的旧行为）与 not-qualified 接口不变
    const onlyQualified = await api("GET", "/clocks?qualified=true");
    assert.equal(onlyQualified.json.data.length, 1);
    const notQualified = await api("GET", "/clocks/not-qualified");
    assert.equal(notQualified.json.data.length, 2);

    // 旧路由仍登记在 /health
    const health = await api("GET", "/health");
    for (const route of [
      "GET /clocks",
      "POST /clocks",
      "GET /clocks/not-qualified",
      "GET /clocks/:id/history",
      "POST /clocks/:id/adjustments",
      "POST /clocks/:id/retests",
      "GET /clocks/:id/latest-retest",
      "GET /adjustments",
      "GET /retests"
    ]) {
      assert.ok(health.json.routes.includes(route), `旧路由缺失：${route}`);
    }

    // 复测写入链路仍可用
    const clockC = clocks.json.data.find((item) => item.code === "CLK-C");
    const retest = await api("POST", `/clocks/${clockC.id}/retests`, {
      dailyRateSeconds: 12, amplitude: 300
    });
    assert.equal(retest.status, 201);
    assert.equal(retest.json.data.qualified, true); // |12| <= 目标30，自动判定合格
  });
});
