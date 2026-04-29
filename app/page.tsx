"use client";

import { FormEvent, useMemo, useState } from "react";

type QueryMode = "markets" | "positions";

type MarketRow = {
  input: string;
  title: string;
  link: string;
  yesPrice: number | null;
  noPrice: number | null;
  volumeUsd: number | null;
  volumeShares: number | null;
  liquidity: number | null;
  ended: boolean;
  endTime: string | null;
};

type PositionRow = {
  address: string;
  title: string;
  link: string;
  outcome: string;
  size: number | null;
  avgPrice: number | null;
  currentPrice: number | null;
  currentValue: number | null;
  cashPnl: number | null;
  percentPnl: number | null;
  endTime: string | null;
};

type QueryError = {
  input: string;
  message: string;
};

type BulkResponse<T> = {
  data?: T[];
  errors?: QueryError[];
  error?: string;
};

const marketHeaders = [
  "市场标题",
  "市场链接",
  "Yes 价格",
  "No 价格",
  "成交量/u",
  "成交量/shares",
  "流动性",
  "是否结束",
  "结束时间"
];

const positionHeaders = [
  "地址",
  "市场标题",
  "市场链接",
  "方向",
  "数量",
  "平均价",
  "当前价",
  "当前价值",
  "PnL/u",
  "PnL %",
  "结束时间"
];

const placeholders: Record<QueryMode, string> = {
  markets: [
    "https://polymarket.com/event/example-market-slug",
    "example-market-slug",
    "71321045679252212594626385532706912750332728571942532289631379312455583992563"
  ].join("\n"),
  positions: [
    "0x56687bf447db6ffa42ffe2204a05edaa20f55839",
    "0x0000000000000000000000000000000000000000"
  ].join("\n")
};

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2
});

const priceFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4
});

export default function Home() {
  const [mode, setMode] = useState<QueryMode>("markets");
  const [query, setQuery] = useState("");
  const [marketRows, setMarketRows] = useState<MarketRow[]>([]);
  const [positionRows, setPositionRows] = useState<PositionRow[]>([]);
  const [itemErrors, setItemErrors] = useState<QueryError[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const inputCount = useMemo(
    () => query.split(/\r?\n/).filter((line) => line.trim()).length,
    [query]
  );
  const isMarketMode = mode === "markets";
  const currentHeaders = isMarketMode ? marketHeaders : positionHeaders;
  const currentRowsCount = isMarketMode ? marketRows.length : positionRows.length;
  const totalCurrentValue = positionRows.reduce(
    (sum, row) => sum + (row.currentValue ?? 0),
    0
  );
  const totalCashPnl = positionRows.reduce(
    (sum, row) => sum + (row.cashPnl ?? 0),
    0
  );

  function switchMode(nextMode: QueryMode) {
    setMode(nextMode);
    setQuery("");
    setMarketRows([]);
    setPositionRows([]);
    setItemErrors([]);
    setError("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const inputs = query
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (inputs.length === 0) {
      setError("请先输入至少一行。");
      setMarketRows([]);
      setPositionRows([]);
      setItemErrors([]);
      return;
    }

    setIsLoading(true);
    setError("");
    setItemErrors([]);

    try {
      if (isMarketMode) {
        const payload = await requestBulk<MarketRow>("/api/markets/bulk", {
          inputs
        });
        const nextRows = payload.data ?? [];
        const nextErrors = payload.errors ?? [];
        setMarketRows(nextRows);
        setPositionRows([]);
        setItemErrors(nextErrors);

        if (nextRows.length === 0 && nextErrors.length === 0) {
          setError("没有查到市场数据。");
        }
      } else {
        const payload = await requestBulk<PositionRow>("/api/positions/bulk", {
          addresses: inputs
        });
        const nextRows = payload.data ?? [];
        const nextErrors = payload.errors ?? [];
        setPositionRows(nextRows);
        setMarketRows([]);
        setItemErrors(nextErrors);

        if (nextRows.length === 0 && nextErrors.length === 0) {
          setError("没有查到持仓数据。");
        }
      }
    } catch (requestError) {
      setMarketRows([]);
      setPositionRows([]);
      setItemErrors([]);
      setError(
        requestError instanceof Error ? requestError.message : "查询失败。"
      );
    } finally {
      setIsLoading(false);
    }
  }

  function exportCsv() {
    const rows = isMarketMode
      ? marketRows.map((row) => [
          row.title,
          row.link,
          row.yesPrice,
          row.noPrice,
          row.volumeUsd,
          row.volumeShares,
          row.liquidity,
          row.ended ? "是" : "否",
          formatDate(row.endTime)
        ])
      : positionRows.map((row) => [
          row.address,
          row.title,
          row.link,
          row.outcome,
          row.size,
          row.avgPrice,
          row.currentPrice,
          row.currentValue,
          row.cashPnl,
          formatPercent(row.percentPnl),
          formatDate(row.endTime)
        ]);

    if (rows.length === 0) {
      return;
    }

    const csv = [currentHeaders, ...rows]
      .map((line) => line.map(formatCsvCell).join(","))
      .join("\n");
    const blob = new Blob(["\ufeff", csv], {
      type: "text/csv;charset=utf-8;"
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = isMarketMode
      ? "polymarket-markets.csv"
      : "polymarket-positions.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="min-h-screen bg-[#f7f8fb]">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <h1 className="text-lg font-semibold tracking-normal text-gray-950">
            Polymarket Bulk Query
          </h1>
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
            Public API
          </span>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[400px_1fr] lg:px-8">
        <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div className="mb-4 grid grid-cols-2 rounded-md border border-gray-200 bg-gray-50 p-1">
            <button
              type="button"
              onClick={() => switchMode("markets")}
              className={modeButtonClass(isMarketMode)}
            >
              市场查询
            </button>
            <button
              type="button"
              onClick={() => switchMode("positions")}
              className={modeButtonClass(!isMarketMode)}
            >
              地址持仓
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="bulk-input"
                className="block text-sm font-medium text-gray-900"
              >
                批量输入
              </label>
              <textarea
                id="bulk-input"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={placeholders[mode]}
                className="mt-2 h-64 w-full resize-none rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm leading-6 text-gray-900 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-gray-500">{inputCount} 行</span>
              <button
                type="submit"
                disabled={isLoading}
                className="inline-flex h-10 items-center justify-center rounded-md bg-gray-950 px-4 text-sm font-medium text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-400"
              >
                {isLoading ? "查询中..." : isMarketMode ? "查询市场" : "查询持仓"}
              </button>
            </div>
          </form>
        </section>

        <section className="min-w-0 rounded-lg border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-gray-200 p-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h2 className="text-base font-semibold text-gray-950">查询结果</h2>
              <p className="mt-1 text-sm text-gray-500">
                {currentRowsCount} {isMarketMode ? "条市场" : "条持仓"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {isMarketMode ? (
                <>
                  <Stat label="未结束" value={marketRows.filter((row) => !row.ended).length} />
                  <Stat label="已结束" value={marketRows.filter((row) => row.ended).length} />
                  <Stat label="错误" value={itemErrors.length} />
                </>
              ) : (
                <>
                  <Stat label="当前价值" value={formatNumber(totalCurrentValue)} />
                  <Stat label="PnL" value={formatNumber(totalCashPnl)} />
                  <Stat label="错误" value={itemErrors.length} />
                </>
              )}
              <button
                type="button"
                onClick={exportCsv}
                disabled={currentRowsCount === 0}
                className="inline-flex h-10 items-center justify-center rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-900 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400"
              >
                导出 CSV
              </button>
            </div>
          </div>

          {(error || itemErrors.length > 0) && (
            <div className="space-y-2 border-b border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              {error && <p>{error}</p>}
              {itemErrors.map((item) => (
                <p key={`${item.input}-${item.message}`}>
                  {item.input}: {item.message}
                </p>
              ))}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  {currentHeaders.map((header) => (
                    <th
                      key={header}
                      scope="col"
                      className="whitespace-nowrap px-4 py-3 text-left font-medium text-gray-600"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              {isMarketMode ? renderMarketBody(marketRows, isLoading) : renderPositionBody(positionRows, isLoading)}
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

async function requestBulk<T>(
  url: string,
  body: Record<string, string[]>
): Promise<BulkResponse<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => ({}))) as BulkResponse<T>;

  if (!response.ok) {
    throw new Error(payload.error || "查询失败。");
  }

  return payload;
}

function renderMarketBody(rows: MarketRow[], isLoading: boolean) {
  return (
    <tbody className="divide-y divide-gray-100 bg-white">
      {rows.length === 0 ? (
        <EmptyRow colSpan={marketHeaders.length} isLoading={isLoading} />
      ) : (
        rows.map((row, index) => (
          <tr key={`${row.link || row.title}-${index}`}>
            <td className="min-w-72 px-4 py-3 font-medium text-gray-950">
              {row.title}
            </td>
            <td className="min-w-52 px-4 py-3">
              <MarketLink href={row.link} />
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-gray-700">
              {formatPrice(row.yesPrice)}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-gray-700">
              {formatPrice(row.noPrice)}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-gray-700">
              {formatNumber(row.volumeUsd)}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-gray-700">
              {formatNumber(row.volumeShares)}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-gray-700">
              {formatNumber(row.liquidity)}
            </td>
            <td className="whitespace-nowrap px-4 py-3">
              <StatusPill active={!row.ended} label={row.ended ? "是" : "否"} />
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-gray-700">
              {formatDate(row.endTime)}
            </td>
          </tr>
        ))
      )}
    </tbody>
  );
}

function renderPositionBody(rows: PositionRow[], isLoading: boolean) {
  return (
    <tbody className="divide-y divide-gray-100 bg-white">
      {rows.length === 0 ? (
        <EmptyRow colSpan={positionHeaders.length} isLoading={isLoading} />
      ) : (
        rows.map((row, index) => (
          <tr key={`${row.address}-${row.link || row.title}-${row.outcome}-${index}`}>
            <td className="max-w-52 truncate px-4 py-3 font-mono text-xs text-gray-700">
              {row.address}
            </td>
            <td className="min-w-72 px-4 py-3 font-medium text-gray-950">
              {row.title}
            </td>
            <td className="min-w-52 px-4 py-3">
              <MarketLink href={row.link} />
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-gray-700">
              {row.outcome}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-gray-700">
              {formatNumber(row.size)}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-gray-700">
              {formatPrice(row.avgPrice)}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-gray-700">
              {formatPrice(row.currentPrice)}
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-gray-700">
              {formatNumber(row.currentValue)}
            </td>
            <td className={pnlClass(row.cashPnl)}>{formatNumber(row.cashPnl)}</td>
            <td className={pnlClass(row.percentPnl)}>{formatPercent(row.percentPnl)}</td>
            <td className="whitespace-nowrap px-4 py-3 text-gray-700">
              {formatDate(row.endTime)}
            </td>
          </tr>
        ))
      )}
    </tbody>
  );
}

function EmptyRow({
  colSpan,
  isLoading
}: {
  colSpan: number;
  isLoading: boolean;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-12 text-center text-gray-500">
        {isLoading ? "正在读取公开数据..." : "暂无数据"}
      </td>
    </tr>
  );
}

function MarketLink({ href }: { href: string }) {
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-emerald-700 underline-offset-4 hover:underline"
    >
      打开
    </a>
  ) : (
    <span className="text-gray-500">-</span>
  );
}

function StatusPill({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={
        active
          ? "rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700"
          : "rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700"
      }
    >
      {label}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="inline-flex h-10 items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-3 text-sm text-gray-600">
      {label}
      <strong className="font-semibold text-gray-950">{value}</strong>
    </span>
  );
}

function modeButtonClass(active: boolean) {
  return active
    ? "h-9 rounded bg-white text-sm font-medium text-gray-950 shadow-sm"
    : "h-9 rounded text-sm font-medium text-gray-500 hover:text-gray-900";
}

function pnlClass(value: number | null) {
  const color =
    typeof value === "number" && value > 0
      ? "text-emerald-700"
      : typeof value === "number" && value < 0
        ? "text-red-700"
        : "text-gray-700";

  return `whitespace-nowrap px-4 py-3 ${color}`;
}

function formatPrice(value: number | null) {
  return typeof value === "number" ? priceFormatter.format(value) : "-";
}

function formatNumber(value: number | null) {
  return typeof value === "number" ? numberFormatter.format(value) : "-";
}

function formatPercent(value: number | null) {
  return typeof value === "number" ? `${numberFormatter.format(value)}%` : "-";
}

function formatDate(value: string | null) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatCsvCell(value: string | number | null) {
  if (value === null || value === undefined) {
    return "";
  }

  const stringValue = String(value);
  return /[",\n]/.test(stringValue)
    ? `"${stringValue.replace(/"/g, '""')}"`
    : stringValue;
}
