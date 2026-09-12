"use strict";

// 写接口数值字段校验回归测试：node --test
// 覆盖：空值、非数字、负数、越界值、边界与合法值，以及非法请求不写入任何记录。
// 零依赖：子进程启动真实 HTTP 服务 + 临时 db.json 隔离。

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { writeFile, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const PORT = 31325;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `clock-validation-test-${process.pid}.json`);

let server;
let clockId;

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json();
  return { status: res.status, json };
}

async function counts() {
  const [clocks, adjustments, retests] = await Promise.all([
    api("GET", "/clocks"),
    api("GET", "/adjustments"),
    api("GET", "/retests")
  ]);
  return {
    clocks: clocks.json.data.length,
    adjustments: adjustments.json.data.length,
    retests: retests.json.data.length
  };
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
  clockId = (await api("POST", "/clocks", {
    code: "CLK-VALID",
    escapementType: "瑞士杠杆式",
    balanceFrequency: "18000vph",
    targetDailyRateSeconds: 20
  })).json.data.id;
});

after(async () => {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.on("exit", resolve));
  await rm(DB_FILE, { force: true });
});

// 各类非法值在三个数值字段上都应返回 400，且错误信息明确
async function assertRejected(label, endpoint, body) {
  const before = await counts();
  const { status, json } = await api("POST", endpoint, body);
  assert.equal(status, 400, `${label} 应返回400`);
  assert.ok(typeof json.error === "string" && json.error.length > 0, `${label} 应返回明确错误信息`);
  const after = await counts();
  assert.deepEqual(after, before, `${label} 不应写入任何记录`);
}

describe("数值字段输入校验", () => {
  test("POST /clocks 目标日差：空值、非数字、负数、越界均 400", async () => {
    const base = { code: "CLK-X", escapementType: "杠杆式", balanceFrequency: "18000vph" };
    for (const bad of ["", "  ", null]) {
      await assertRejected(`目标日差空值 ${JSON.stringify(bad)}`, "/clocks", { ...base, targetDailyRateSeconds: bad });
    }
    for (const bad of ["abc", "1/2", {}, [], true]) {
      await assertRejected(`目标日差非数字 ${JSON.stringify(bad)}`, "/clocks", { ...base, targetDailyRateSeconds: bad });
    }
    await assertRejected("目标日差负数", "/clocks", { ...base, targetDailyRateSeconds: -1 });
    await assertRejected("目标日差越界601", "/clocks", { ...base, targetDailyRateSeconds: 601 });
    await assertRejected("目标日差越界10000", "/clocks", { ...base, targetDailyRateSeconds: 10000 });
  });

  test("POST /clocks 目标日差：合法值与边界值 201", async () => {
    const cases = [
      [{ code: "CLK-OK1", escapementType: "x", balanceFrequency: "x", targetDailyRateSeconds: 0 }, 0],
      [{ code: "CLK-OK2", escapementType: "x", balanceFrequency: "x", targetDailyRateSeconds: 600 }, 600],
      [{ code: "CLK-OK3", escapementType: "x", balanceFrequency: "x", targetDailyRateSeconds: 25 }, 25],
      // 数字字符串沿用旧行为，解析为数字
      [{ code: "CLK-OK4", escapementType: "x", balanceFrequency: "x", targetDailyRateSeconds: "20" }, 20],
      // 缺省沿用旧默认值 30
      [{ code: "CLK-OK5", escapementType: "x", balanceFrequency: "x" }, 30]
    ];
    for (const [body, expected] of cases) {
      const { status, json } = await api("POST", "/clocks", body);
      assert.equal(status, 201, `合法目标日差 ${JSON.stringify(body.targetDailyRateSeconds)} 应201`);
      assert.equal(json.data.targetDailyRateSeconds, expected);
    }
  });

  test("POST 调校 当前日差：空值、非数字、负数越界、越界均 400", async () => {
    const endpoint = `/clocks/${clockId}/adjustments`;
    const base = { direction: "慢针方向", amount: "微调0.1格" };
    for (const bad of ["", "  ", null, undefined]) {
      await assertRejected(`当前日差空值 ${JSON.stringify(bad)}`, endpoint, { ...base, currentDailyRateSeconds: bad });
    }
    for (const bad of ["abc", "很快", {}, [], true]) {
      await assertRejected(`当前日差非数字 ${JSON.stringify(bad)}`, endpoint, { ...base, currentDailyRateSeconds: bad });
    }
    await assertRejected("当前日差负越界-4000", endpoint, { ...base, currentDailyRateSeconds: -4000 });
    await assertRejected("当前日差正越界4000", endpoint, { ...base, currentDailyRateSeconds: 4000 });
    await assertRejected("当前日差越界3601", endpoint, { ...base, currentDailyRateSeconds: 3601 });
  });

  test("POST 调校 当前日差：合法值（含负数与数字字符串、边界值）201", async () => {
    const endpoint = `/clocks/${clockId}/adjustments`;
    const cases = [
      [68, 68],
      [-12, -12],
      [3600, 3600],
      [-3600, -3600],
      ["25.5", 25.5]
    ];
    for (const [value, expected] of cases) {
      const { status, json } = await api("POST", endpoint, {
        currentDailyRateSeconds: value, direction: "慢针方向", amount: `调校${value}`
      });
      assert.equal(status, 201, `合法当前日差 ${value} 应201`);
      assert.equal(json.data.currentDailyRateSeconds, expected);
    }
  });

  test("POST 复测 日差与摆幅：空值、非数字、负数、越界均 400", async () => {
    const endpoint = `/clocks/${clockId}/retests`;
    // 日差非法
    for (const bad of ["", null, undefined]) {
      await assertRejected(`复测日差空值 ${JSON.stringify(bad)}`, endpoint, { dailyRateSeconds: bad, amplitude: 250 });
    }
    for (const bad of ["abc", {}, true]) {
      await assertRejected(`复测日差非数字 ${JSON.stringify(bad)}`, endpoint, { dailyRateSeconds: bad, amplitude: 250 });
    }
    await assertRejected("复测日差负越界-4000", endpoint, { dailyRateSeconds: -4000, amplitude: 250 });
    await assertRejected("复测日差正越界3601", endpoint, { dailyRateSeconds: 3601, amplitude: 250 });

    // 摆幅非法
    for (const bad of ["", null, undefined]) {
      await assertRejected(`摆幅空值 ${JSON.stringify(bad)}`, endpoint, { dailyRateSeconds: 10, amplitude: bad });
    }
    for (const bad of ["abc", {}, true]) {
      await assertRejected(`摆幅非数字 ${JSON.stringify(bad)}`, endpoint, { dailyRateSeconds: 10, amplitude: bad });
    }
    await assertRejected("摆幅负数-1", endpoint, { dailyRateSeconds: 10, amplitude: -1 });
    await assertRejected("摆幅越界361", endpoint, { dailyRateSeconds: 10, amplitude: 361 });
    await assertRejected("摆幅越界500", endpoint, { dailyRateSeconds: 10, amplitude: 500 });
  });

  test("POST 复测：合法值（负日差、摆幅边界、数字字符串）201 且合格判定不变", async () => {
    const endpoint = `/clocks/${clockId}/retests`;
    const cases = [
      [{ dailyRateSeconds: 12, amplitude: 270 }, { dailyRateSeconds: 12, amplitude: 270, qualified: true }],
      [{ dailyRateSeconds: -18, amplitude: 0 }, { dailyRateSeconds: -18, amplitude: 0, qualified: true }],
      [{ dailyRateSeconds: -20, amplitude: 360 }, { dailyRateSeconds: -20, amplitude: 360, qualified: true }],
      [{ dailyRateSeconds: "15", amplitude: "300" }, { dailyRateSeconds: 15, amplitude: 300, qualified: true }],
      [{ dailyRateSeconds: 31, amplitude: 248 }, { dailyRateSeconds: 31, amplitude: 248, qualified: false }]
    ];
    for (const [body, expected] of cases) {
      const { status, json } = await api("POST", endpoint, body);
      assert.equal(status, 201, `合法复测 ${JSON.stringify(body)} 应201`);
      assert.equal(json.data.dailyRateSeconds, expected.dailyRateSeconds);
      assert.equal(json.data.amplitude, expected.amplitude);
      assert.equal(json.data.qualified, expected.qualified);
    }
  });

  test("非法请求均未落盘：最终集合数量只包含合法写入", async () => {
    const finalCounts = await counts();
    // 初始1只钟表 + 目标日差合法用例5只
    assert.equal(finalCounts.clocks, 6);
    // 当前日差合法用例5条
    assert.equal(finalCounts.adjustments, 5);
    // 复测合法用例5条
    assert.equal(finalCounts.retests, 5);
  });
});
