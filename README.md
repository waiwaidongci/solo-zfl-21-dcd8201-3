# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录和复测记录。

## 启动

```bash
PORT=3021 node server.js
```

## 测试

```bash
node --test test/
```

零依赖（使用 Node 内置 test runner），测试会在临时 `db.json` 上启动独立服务实例，不影响正式数据。

## 主要接口

- `GET /health`
- `GET /clocks`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /dashboard?qualified=true|false` — 调校质量看板（每表目标/最近日差、摆幅、合格、累计次数 + 全局汇总）；无钟表数据时返回 `400`，`qualified` 非 `true/false` 返回 `400`
- `GET /clocks/:id/dashboard` — 单只钟表看板
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

## 闭环示例

```bash
curl http://127.0.0.1:3021/clocks/not-qualified
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'
```
