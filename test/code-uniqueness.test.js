"use strict";

// 新增钟表编号唯一性回归测试：node --test
// 覆盖：重复编号、前后空白、大小写差异、纯空白编号、合法编号，以及失败请求不写入。
// 零依赖：子进程 + 临时 db.json。

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { writeFile, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const PORT = 31329;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `clock-code-test-${process.pid}.json`);

let server;

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json() };
}

function clockPayload(code) {
  return { code, escapementType: "瑞士杠杆式", balanceFrequency: "18000vph" };
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

describe("新增钟表编号唯一性", () => {
  test("合法编号首次创建成功", async () => {
    const { status, json } = await api("POST", "/clocks", clockPayload("CLK-1890-07"));
    assert.equal(status, 201);
    assert.equal(json.data.code, "CLK-1890-07");
  });

  test("完全相同的重复编号返回 409 且不写入", async () => {
    const before = (await api("GET", "/clocks")).json.data.length;
    const { status, json } = await api("POST", "/clocks", clockPayload("CLK-1890-07"));
    assert.equal(status, 409);
    assert.match(json.error, /编号已存在/);
    assert.match(json.error, /CLK-1890-07/);
    assert.equal((await api("GET", "/clocks")).json.data.length, before, "重复编号不应写入");
  });

  test("带前后空白的重复编号返回 409 且不写入", async () => {
    const before = (await api("GET", "/clocks")).json.data.length;
    for (const code of ["  CLK-1890-07", "CLK-1890-07  ", "\tCLK-1890-07\t", "  CLK-1890-07  "]) {
      const { status, json } = await api("POST", "/clocks", clockPayload(code));
      assert.equal(status, 409, `编号 ${JSON.stringify(code)} 应返回409`);
      assert.match(json.error, /编号已存在/);
    }
    assert.equal((await api("GET", "/clocks")).json.data.length, before, "空白重复编号不应写入");
  });

  test("大小写不同的重复编号返回 409 且不写入", async () => {
    const before = (await api("GET", "/clocks")).json.data.length;
    for (const code of ["clk-1890-07", "Clk-1890-07", "CLK-1890-07".toLowerCase(), "  clk-1890-07  "]) {
      const { status, json } = await api("POST", "/clocks", clockPayload(code));
      assert.equal(status, 409, `编号 ${code} 与已有编号仅大小写不同，应返回409`);
      assert.match(json.error, /编号已存在/);
    }
    assert.equal((await api("GET", "/clocks")).json.data.length, before, "大小写重复编号不应写入");
  });

  test("合法编号去除前后空白后保存，原大小写保留", async () => {
    const { status, json } = await api("POST", "/clocks", clockPayload("  ClK-Mixed-01 \t"));
    assert.equal(status, 201);
    assert.equal(json.data.code, "ClK-Mixed-01", "存储编号应去空白并保留原大小写");

    // 用去空白前的形式无法再创建
    const dup = await api("POST", "/clocks", clockPayload("ClK-Mixed-01"));
    assert.equal(dup.status, 409);

    // 大小写不敏感：另一大小写也无法创建
    const dupLower = await api("POST", "/clocks", clockPayload("clk-mixed-01"));
    assert.equal(dupLower.status, 409);
  });

  test("纯空白编号返回 400 明确错误且不写入", async () => {
    const before = (await api("GET", "/clocks")).json.data.length;
    for (const code of ["", "   ", "\t"]) {
      const { status, json } = await api("POST", "/clocks", clockPayload(code));
      assert.equal(status, 400, `编号 ${JSON.stringify(code)} 应返回400`);
      assert.match(json.error, /编号|code/);
    }
    assert.equal((await api("GET", "/clocks")).json.data.length, before, "空编号不应写入");
  });

  test("其他不同的合法编号仍可正常创建", async () => {
    for (const code of ["CLK-2026-01", "clk-2026-02", "ABC-999"]) {
      const { status } = await api("POST", "/clocks", clockPayload(code));
      assert.equal(status, 201, `合法新编号 ${code} 应创建成功`);
    }
  });

  test("重复编号失败不影响后续调校/复测接口", async () => {
    // 重复创建失败后，已存在的钟表仍可正常查询与写调校记录
    const failed = await api("POST", "/clocks", clockPayload("CLK-1890-07"));
    assert.equal(failed.status, 409);

    const list = await api("GET", "/clocks");
    const existing = list.json.data.find((item) => item.code === "CLK-1890-07");
    assert.ok(existing, "原编号钟表仍可查询到，且只有一条");
    assert.equal(list.json.data.filter((item) => item.code === "CLK-1890-07").length, 1);

    const adjustment = await api("POST", `/clocks/${existing.id}/adjustments`, {
      currentDailyRateSeconds: 40, direction: "慢针方向", amount: "微调0.2格"
    });
    assert.equal(adjustment.status, 201);
  });
});
