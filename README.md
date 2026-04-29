# Polymarket Bulk Query

一个独立实现的 Polymarket 批量数据查询工具。项目使用 Next.js、TypeScript 和 Tailwind CSS，可直接部署到 Vercel。

## 功能

- 批量输入 Polymarket market URL、slug 或 token id，每行一个
- 批量输入 0x 钱包地址，查询公开持仓
- 后端 API：`POST /api/markets/bulk`
- 后端 API：`POST /api/positions/bulk`
- 表格展示市场标题、链接、Yes/No 价格、成交量、流动性、结束状态和结束时间
- 表格展示地址持仓、方向、数量、价格、当前价值和 PnL
- loading 状态、错误提示、CSV 导出
- 不需要数据库、登录、钱包连接、私钥或交易能力

## 本地运行

```bash
npm install
npm run dev
```

打开 `http://localhost:3000`。

构建检查：

```bash
npm run typecheck
npm run build
```

## Vercel 部署

1. 把项目推送到 GitHub、GitLab 或 Bitbucket。
2. 在 Vercel 中选择 `Add New Project`，导入该仓库。
3. Framework Preset 选择 `Next.js`。
4. 使用默认命令：
   - Install Command: `npm install`
   - Build Command: `npm run build`
   - Output Directory: 留空
5. 点击 `Deploy`。

## API

请求：

```http
POST /api/markets/bulk
Content-Type: application/json

{
  "inputs": [
    "https://polymarket.com/event/example-market-slug",
    "example-market-slug",
    "71321045679252212594626385532706912750332728571942532289631379312455583992563"
  ]
}
```

返回：

```json
{
  "data": [
    {
      "input": "example-market-slug",
      "title": "Market title",
      "link": "https://polymarket.com/event/example-market-slug",
      "yesPrice": 0.52,
      "noPrice": 0.48,
      "volumeUsd": 12000,
      "volumeShares": 9000,
      "liquidity": 4500,
      "ended": false,
      "endTime": "2026-12-31T00:00:00Z"
    }
  ],
  "errors": [],
  "count": 1
}
```

地址持仓请求：

```http
POST /api/positions/bulk
Content-Type: application/json

{
  "addresses": [
    "0x56687bf447db6ffa42ffe2204a05edaa20f55839"
  ]
}
```

返回：

```json
{
  "data": [
    {
      "address": "0x56687bf447db6ffa42ffe2204a05edaa20f55839",
      "title": "Market title",
      "link": "https://polymarket.com/event/example-market-slug",
      "outcome": "Yes",
      "size": 100,
      "avgPrice": 0.45,
      "currentPrice": 0.52,
      "currentValue": 52,
      "cashPnl": 7,
      "percentPnl": 15.56,
      "endTime": "2026-12-31T00:00:00Z"
    }
  ],
  "errors": [],
  "count": 1
}
```

## 数据来源

本项目只读取 Polymarket 公开数据：

- Gamma API：`https://gamma-api.polymarket.com`
- Data API：`https://data-api.polymarket.com`
- 使用到的接口：`/markets?slug=...`、`/events?slug=...`、`/markets?clob_token_ids=...`
- 使用到的接口：`/positions?user=...`

官方文档：

- https://docs.polymarket.com/api-reference
- https://docs.polymarket.com/api-reference/markets/list-markets
- https://docs.polymarket.com/api-reference/markets/get-market-by-slug
