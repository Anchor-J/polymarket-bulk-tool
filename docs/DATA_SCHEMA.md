# Data Schema

本文档记录 Polymarket 地址批量分析工具当前字段口径。

## 结算 / 奖励 / 待赎回

### 结算数

来源：`/activity`

计算：`activity.type === "REDEEM"` 的记录，按唯一仓位去重后的数量。

唯一 key 优先级：

1. `conditionId + asset + outcomeIndex`
2. `conditionId + asset`
3. `transactionHash + conditionId`

### 奖励数

来源：`/activity`

计算：`activity.type === "REWARD"` 的记录数量。

### 奖励金额

来源：`/activity`

计算：`activity.type === "REWARD"` 时，对 `usdcSize` 求和；如果 `usdcSize` 缺失，则 fallback 到 `size`。

### 卖出数

来源：`/trades?takerOnly=false`

计算：`trade.side === "SELL"` 的记录，按唯一仓位去重后的数量。该字段只用于计算待赎回数，不在主表展示。

唯一 key 优先级：

1. `conditionId + asset + outcomeIndex`
2. `conditionId + asset`
3. `transactionHash + conditionId`

### 待赎回数

来源：`/closed-positions`、`/activity`、`/trades?takerOnly=false`

计算：

```text
max(/closed-positions 去重数量 - /activity REDEEM 去重数量 - /trades SELL 去重数量, 0)
```

其中 `/closed-positions` 去重唯一 key：

1. `conditionId + asset + outcomeIndex`
2. `conditionId + asset`
