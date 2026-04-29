# API Notes

本文档记录当前项目的数据源决策。当前项目是 Polymarket 批量地址账户详情查询工具，不是 market/topic 查询工具，也不是交易工具。

## 当前项目使用的数据源

### 1. Data API

用途：

- current positions：当前持仓
- closed positions：历史已实现盈亏
- trades：交易历史、交易额、活跃天数、活跃月数、最后活跃

Base URL:

```text
https://data-api.polymarket.com
```

### 2. Polygon RPC

用途：

- 读取 proxyWallet 的 pUSD ERC20 balanceOf
- pUSD 合约地址：`0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`
- decimals = 6
- 使用 POLYGON_RPC_URLS 多 RPC fallback

## 当前项目不使用的数据源

### 1. Gamma API

暂不使用。

原因：

- 当前项目只支持一种默认地址类型
- 输入地址直接作为查询地址使用
- 不再通过 public-profile 自动解析 proxyWallet

### 2. CLOB API

暂不使用。

原因：

- 当前项目不查订单簿
- 不查实时买卖盘口
- 不下单
- 不撤单
- 不接钱包

### 3. SDK

暂不使用。

原因：

- 当前项目只做公开数据查询
- 不涉及认证交易
- 手写 fetch 更容易控制代理、timeout、retry、错误展示

### 4. Subgraph / Bitquery / Goldsky

暂不使用。

原因：

- 当前第一版优先使用官方 Data API
- 链上底层数据后续再评估

## 字段来源说明

- 净资产 = pUSD 可用余额 + 当前持仓价值
- 盈亏 = 当前持仓浮盈亏 + 已关闭持仓 realizedPnl
- 可用 = pUSD balanceOf(proxyWallet)
- 持仓 = current positions 的 currentValue 求和
- 交易额/u = trades 中 price * size 求和
- 交易额/s = trades 中 size 求和
- 池子数 = trades 中唯一 conditionId 数量
- 最后活跃 = trades 最大 timestamp 到今天的天数
- 活跃天数 = trades 中唯一 YYYY-MM-DD 数量
- 活跃月数 = trades 中唯一 YYYY-MM 数量

## 后续可扩展但暂不做

- 市场详情查询
- 订单簿查询
- 实时价格
- CLOB token_id 查询
- GraphQL / Subgraph
- Bitquery
- Goldsky
- 钱包连接
- 下单交易
