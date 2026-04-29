# Polymarket 地址批量分析

一个独立实现的 Polymarket 批量地址账户详情查询工具。项目使用 Next.js、TypeScript 和 Tailwind CSS，可直接部署到 Vercel。

数据源决策见 [docs/API_NOTES.md](docs/API_NOTES.md)。

## 功能

- 批量输入 Polymarket 地址，每行一个；系统按输入地址直接查询
- 前端最多接受 500 个地址，并按每批 25 个地址调用后端
- 后端 API：`POST /api/accounts/bulk`
- 查询当前持仓、历史已实现盈亏、交易记录、pUSD 可用余额
- 展示净资产、盈亏、可用、持仓、交易额、池子数、最后活跃、活跃天数、活跃月数
- 支持 CSV / JSON 导出
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

## 环境变量

推荐配置：

```bash
POLYGON_RPC_URLS=https://polygon-bor-rpc.publicnode.com,https://rpc.ankr.com/polygon,https://rpc-mainnet.matic.quiknode.pro
```

兼容旧配置：

```bash
POLYGON_RPC_URL=https://your-polygon-rpc.example
```

读取优先级：

1. 如果 `POLYGON_RPC_URLS` 存在，按逗号分割后从左到右依次尝试：第 1 个失败就尝试第 2 个，第 2 个失败就尝试第 3 个。
2. 否则如果 `POLYGON_RPC_URL` 存在，使用单个 RPC。
3. 如果两个变量都没有，pUSD 可用余额显示为 0，并在 debug 中记录 `POLYGON_RPC_URLS not configured`。

配置位置：

- 本地开发放在 `.env.local`。
- Vercel 线上放在 Project Settings 的 Environment Variables。
- 不要把带 API key 的私有 RPC 提交到 GitHub。
- 公共 RPC 可能限流，生产环境建议使用稳定 RPC 服务。

代理配置默认不启用。推荐使用端口范围配置：

```bash
USE_PROXY=true
PROXY_HOST=dc.decodo.com
PROXY_PORT_START=10001
PROXY_PORT_END=10050
PROXY_USER=your_proxy_user
PROXY_PASS=your_proxy_password
```

仍兼容旧变量 `HTTPS_PROXY_LIST` 和 `HTTPS_PROXY`。优先级为端口范围配置、`HTTPS_PROXY_LIST`、`HTTPS_PROXY`。

不要把代理账号、密码、IP 或私有 RPC key 写进代码、README、前端或 GitHub。

## Vercel 部署

1. 把项目推送到 GitHub、GitLab 或 Bitbucket。
2. 在 Vercel 中选择 `Add New Project`，导入该仓库。
3. Framework Preset 选择 `Next.js`。
4. 如需稳定读取 pUSD 余额，在 Vercel Project Settings 里添加 `POLYGON_RPC_URLS`，也兼容旧变量 `POLYGON_RPC_URL`。
5. 使用默认命令：
   - Install Command: `npm install`
   - Build Command: `npm run build`
   - Output Directory: 留空
6. 点击 `Deploy`。

也可以用 CLI：

```bash
npx vercel deploy --prod
```

## API

请求：

```http
POST /api/accounts/bulk
Content-Type: application/json

{
  "addresses": [
    "0x56687bf447db6ffa42ffe2204a05edaa20f55839"
  ]
}
```

单次 API 最多 25 个地址。前端会自动把最多 500 个地址拆成多个批次。

返回：

```json
{
  "summary": {
    "totalPnl": 0,
    "totalAvailable": 0,
    "totalPositionValue": 0,
    "totalNetAsset": 0
  },
  "accounts": [
    {
      "inputAddress": "0x56687bf447db6ffa42ffe2204a05edaa20f55839",
      "proxyWallet": "0x56687bf447db6ffa42ffe2204a05edaa20f55839",
      "netAsset": 100,
      "pnl": 12.5,
      "available": 40,
      "positionValue": 60,
      "volumeUsd": 1200,
      "volumeShares": 900,
      "marketCount": 8,
      "lastActiveAt": "2026-04-29T00:00:00.000Z",
      "lastActiveDaysAgo": 0,
      "lastActiveText": "今天",
      "activeDays": 4,
      "activeMonths": 2,
      "positionCount": 3,
      "tradeCount": 20,
      "error": null
    }
  ]
}
```

## 计算规则

- `proxyWallet`：使用输入地址作为默认查询地址，不再通过 Gamma public-profile 自动解析。
- `available`：读取 Polygon 上 pUSD 合约 `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` 的 `balanceOf(proxyWallet)`，decimals = 6。RPC 按 `POLYGON_RPC_URLS` 列表顺序 fallback，兼容旧变量 `POLYGON_RPC_URL`。
- `positionValue`：当前持仓 `currentValue` 求和。
- `pnl`：当前持仓 `cashPnl` 求和 + closed positions 的 `realizedPnl` 求和。
- `volumeUsd`：交易记录 `sum(price * size)`。
- `volumeShares`：交易记录 `sum(size)`。
- `marketCount`：交易记录唯一 `conditionId` 数量。
- `lastActiveText`：基于交易记录最大 `timestamp`，显示 `今天` / `1天前` / `X天前` / `-`。
- `activeDays`：交易记录唯一 `YYYY-MM-DD` 数量。
- `activeMonths`：交易记录唯一 `YYYY-MM` 数量。
- `netAsset`：`available + positionValue`。

## 数据来源

本项目只读取公开数据：

- Data API：`https://data-api.polymarket.com/positions`
- Data API：`https://data-api.polymarket.com/closed-positions`
- Data API：`https://data-api.polymarket.com/trades`
- Polygon RPC：ERC20 `balanceOf` 读取 pUSD 余额
