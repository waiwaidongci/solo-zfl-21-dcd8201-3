"use strict";

// 复测时间 testedAt 校验回归测试：node --test
// 覆盖：空值、非字符串、非法时间、合法时间、字段缺失（用当前时间），以及非法请求不写入、
// 最近复测按时间排序不失真。零依赖：子进程 + 临时 db.json。

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { writeFile, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const PORT = 31327;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `clock-testedat-test-${process.pid}.json`);

let server;
let clockId;

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json() };
}

async function retestCount() {
  return (await api("GET", `/retests?clockId=${clockId}`)).json.data.length;
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
    code: "CLK-TIME",
    escapementType: "瑞士杠杆式",
    balanceFrequency: "18000vph",
    targetDailyRateSeconds: 60
  })).json.data.id;
});

after(async () => {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.on("exit", resolve));
  await rm(DB_FILE, { force: true });
});

describe("复测时间 testedAt 校验", () => {
  test("空值返回 400 且不写入", async () => {
    const endpoint = `/clocks/${clockId}/retests`;
    for (const bad of ["", "   ", null]) {
      const before = await retestCount();
      const { status, json } = await api("POST", endpoint, {
        dailyRateSeconds: 5, amplitude: 260, testedAt: bad
      });
      assert.equal(status, 400, `testedAt=${JSON.stringify(bad)} 应返回400`);
      assert.match(json.error, /测试时间/);
      assert.equal(await retestCount(), before, "空值时间不应写入复测");
    }
  });

  test("非字符串（数字、布尔、对象、数组）返回 400 且不写入", async () => {
    const endpoint = `/clocks/${clockId}/retests`;
    for (const bad of [20260912, 1757000000000, true, false, {}, { date: "2026-09-01" }, []]) {
      const before = await retestCount();
      const { status, json } = await api("POST", endpoint, {
        dailyRateSeconds: 5, amplitude: 260, testedAt: bad
      });
      assert.equal(status, 400, `testedAt=${JSON.stringify(bad)} 应返回400`);
      assert.match(json.error, /测试时间/);
      assert.equal(await retestCount(), before, "非字符串时间不应写入复测");
    }
  });

  test("不可解析的时间字符串返回 400 且不写入", async () => {
    const endpoint = `/clocks/${clockId}/retests`;
    // 注：JS 会把 2026-02-30 这类日期自动滚动成 3 月 2 日，故选用确定无法解析的值
    for (const bad of ["not-a-date", "2026-13-01", "1999-99-99", "2026-02-30 25:00:00", "昨天下午"]) {
      const before = await retestCount();
      const { status, json } = await api("POST", endpoint, {
        dailyRateSeconds: 5, amplitude: 260, testedAt: bad
      });
      assert.equal(status, 400, `testedAt=${bad} 应返回400`);
      assert.match(json.error, /测试时间/);
      assert.equal(await retestCount(), before, "非法时间字符串不应写入复测");
    }
  });

  test("合法时间字符串原样接受并写入", async () => {
    const endpoint = `/clocks/${clockId}/retests`;
    for (const valid of [
      "2026-09-01T00:00:00.000Z",
      "2026-09-05 10:30:00",
      "2026-09-10",
      "2026-09-11T08:00:00+08:00"
    ]) {
      const { status, json } = await api("POST", endpoint, {
        dailyRateSeconds: 8, amplitude: 265, testedAt: valid
      });
      assert.equal(status, 201, `testedAt=${valid} 应返回201`);
      assert.equal(json.data.testedAt, valid, "合法时间字符串应原样保存");
    }
  });

  test("字段缺失时使用当前时间（ISO 字符串），写入成功", async () => {
    const beforeMs = Date.now();
    const { status, json } = await api("POST", `/clocks/${clockId}/retests`, {
      dailyRateSeconds: 6, amplitude: 270
    });
    const afterMs = Date.now();
    assert.equal(status, 201);
    const stored = new Date(json.data.testedAt);
    assert.ok(!Number.isNaN(stored.getTime()), "缺失时间应补为可解析的当前时间");
    assert.ok(stored.getTime() >= beforeMs && stored.getTime() <= afterMs, "缺失时间应为当前时间");
  });

  test("最近复测按合法时间排序不失真，非法时间不影响排序", async () => {
    // 写入一条更早的合法复测；最新复测应仍是字段缺失用例（当前时间），而非更早的这条
    const { status } = await api("POST", `/clocks/${clockId}/retests`, {
      dailyRateSeconds: 99,
      amplitude: 100,
      testedAt: "2020-01-01T00:00:00.000Z"
    });
    assert.equal(status, 201);

    const latest = await api("GET", `/clocks/${clockId}/latest-retest`);
    assert.equal(latest.json.data.amplitude, 270, "最近复测应按时间取到当前时间那条");
    assert.equal(latest.json.data.dailyRateSeconds, 6);

    const dashboard = await api("GET", `/clocks/${clockId}/dashboard`);
    assert.equal(dashboard.json.data.amplitude, 270, "看板摆幅应取时间最新的复测");
  });
});
