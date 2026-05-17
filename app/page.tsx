"use client";

import { FormEvent, useMemo, useState } from "react";

type AccountSummary = {
  totalPnl: number;
  totalAvailable: number;
  totalPositionValue: number;
  totalNetAsset: number;
};

type AccountDetail = {
  inputAddress: string;
  proxyWallet: string | null;
  netAsset: number;
  pnl: number;
  available: number;
  positionValue: number;
  volumeUsd: number;
  volumeShares: number;
  marketCount: number;
  lastActiveAt: string | null;
  lastActiveDaysAgo: number | null;
  lastActiveText: string;
  activeDays: number;
  activeMonths: number;
  positionCount: number;
  tradeCount: number;
  redeemCount: number;
  rewardCount: number;
  rewardAmount: number;
  warnings: string[];
  fatalError: string | null;
  error: string | null;
};

type BulkAccountsResponse = {
  summary: AccountSummary;
  accounts: AccountDetail[];
  error?: string;
};

const MAX_FRONTEND_ADDRESSES = 500;
const BATCH_SIZE = 25;
const BATCH_REQUEST_TIMEOUT_MS = 45_000;
const BATCH_RETRY_ATTEMPTS = 2;
const ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/i;

const tableHeaders = [
  "#",
  "地址",
  "净资产",
  "盈亏",
  "可用",
  "持仓",
  "交易额/u",
  "交易额/s",
  "池子数",
  "最后活跃",
  "活跃天数",
  "活跃月数",
  "持仓数",
  "交易数",
  "结算数",
  "奖励数",
  "奖励金额",
  "状态/错误"
];

const headerDescriptions: Record<string, string> = {
  "交易额/u": "sum(price * size)",
  "交易额/s": "sum(size)",
  "活跃天数": "/activity 日期去重",
  "结算数": "REDEEM 去重数量",
  "奖励数": "REWARD 记录数量",
  "奖励金额": "REWARD usdcSize 求和"
};

const exportFields: Array<keyof AccountDetail> = [
  "inputAddress",
  "proxyWallet",
  "netAsset",
  "pnl",
  "available",
  "positionValue",
  "volumeUsd",
  "volumeShares",
  "marketCount",
  "lastActiveText",
  "lastActiveDaysAgo",
  "activeDays",
  "activeMonths",
  "positionCount",
  "tradeCount",
  "redeemCount",
  "rewardCount",
  "rewardAmount",
  "warnings",
  "fatalError",
  "error"
];

const exportLabels: Record<keyof AccountDetail, string> = {
  inputAddress: "输入地址",
  proxyWallet: "查询地址",
  netAsset: "净资产",
  pnl: "盈亏",
  available: "可用",
  positionValue: "持仓",
  volumeUsd: "交易额/u",
  volumeShares: "交易额/s",
  marketCount: "池子数",
  lastActiveAt: "最后活跃时间",
  lastActiveDaysAgo: "最后活跃天数",
  lastActiveText: "最后活跃",
  activeDays: "活跃天数",
  activeMonths: "活跃月数",
  positionCount: "持仓数",
  tradeCount: "交易数",
  redeemCount: "结算数",
  rewardCount: "奖励数",
  rewardAmount: "奖励金额",
  warnings: "警告",
  fatalError: "致命错误",
  error: "错误"
};

const numberFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const rightAlignedColumnIndexes = new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

export default function Home() {
  const [query, setQuery] = useState("");
  const [accounts, setAccounts] = useState<AccountDetail[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [search, setSearch] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [retryingAddress, setRetryingAddress] = useState("");

  const inputStats = useMemo(() => getInputStats(query), [query]);
  const inputCount = inputStats.total;
  const summary = useMemo(() => buildSummary(accounts), [accounts]);
  const successfulCount = accounts.filter((account) => !account.fatalError).length;
  const filteredAccounts = useMemo(() => {
    const keyword = search.trim().toLowerCase();

    if (!keyword) {
      return accounts;
    }

    return accounts.filter((account) =>
      [
        account.inputAddress,
        account.proxyWallet,
        account.fatalError,
        account.error,
        ...account.warnings
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(keyword))
    );
  }, [accounts, search]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const addresses = parseAddressLines(query);

    if (addresses.length === 0) {
      resetResults("请先输入至少一个地址。");
      return;
    }

    if (addresses.length > MAX_FRONTEND_ADDRESSES) {
      resetResults("每批最多查询 500 个地址");
      return;
    }

    setIsLoading(true);
    setError("");
    setAccounts([]);
    setSearch("");
    setCopyStatus("");
    setProgress({ done: 0, total: addresses.length });

    const nextAccounts: AccountDetail[] = [];

    for (let start = 0; start < addresses.length; start += BATCH_SIZE) {
      const batch = addresses.slice(start, start + BATCH_SIZE);

      try {
        const payload = await requestAccountBatch(batch);
        nextAccounts.push(...payload.accounts);
      } catch (batchError) {
        const message = batchError instanceof Error ? batchError.message : "批次查询失败";
        nextAccounts.push(...batch.map((address) => emptyAccount(address, message)));
      }

      setAccounts([...nextAccounts]);
      setProgress({ done: Math.min(start + batch.length, addresses.length), total: addresses.length });
    }

    setIsLoading(false);
  }

  function resetResults(message: string) {
    setAccounts([]);
    setProgress({ done: 0, total: 0 });
    setError(message);
    setCopyStatus("");
  }

  function clearAll() {
    setQuery("");
    setAccounts([]);
    setProgress({ done: 0, total: 0 });
    setError("");
    setSearch("");
    setCopyStatus("");
  }

  async function copyText(text: string, label: string) {
    if (!text) {
      return;
    }

    await navigator.clipboard.writeText(text);
    setCopyStatus(label + "已复制");
    window.setTimeout(() => setCopyStatus(""), 1800);
  }

  function copyAllAddressInfo() {
    if (accounts.length === 0) {
      return;
    }

    void copyText(buildTsv(accounts), "全部地址信息");
  }

  async function retryAccount(address: string) {
    setRetryingAddress(address);
    setCopyStatus("");

    try {
      const payload = await requestAccountBatch([address]);
      const nextAccount = payload.accounts[0] ?? emptyAccount(address, "单行重新查询无返回结果");

      setAccounts((current) =>
        current.map((account) =>
          account.inputAddress === address ? nextAccount : account
        )
      );
    } catch (retryError) {
      const message =
        retryError instanceof Error ? retryError.message : "单行重新查询失败";

      setAccounts((current) =>
        current.map((account) =>
          account.inputAddress === address ? emptyAccount(address, message) : account
        )
      );
    } finally {
      setRetryingAddress("");
    }
  }

  function exportCsv() {
    if (accounts.length === 0) {
      return;
    }

    const csv = [
      exportFields.map((field) => exportLabels[field]),
      ...accounts.map((account) => exportFields.map((field) => account[field]))
    ]
      .map((line) => line.map(formatCsvCell).join(","))
      .join("\n");
    downloadBlob("polymarket-accounts.csv", csv, "text/csv;charset=utf-8;");
  }

  function exportJson() {
    if (accounts.length === 0) {
      return;
    }

    const json = JSON.stringify({ summary, accounts }, null, 2);
    downloadBlob("polymarket-accounts.json", json, "application/json");
  }

  return (
    <main className="min-h-screen bg-[linear-gradient(135deg,#f8fbff_0%,#eef2ff_42%,#f7f3ff_100%)] text-slate-950">
      <header className="border-b border-indigo-100/70 bg-white/85 shadow-sm shadow-indigo-100/40 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1800px] flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-500 shadow-lg shadow-indigo-200">
              <div className="h-4 w-4 rounded-md border-2 border-white/90" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-normal text-slate-950">Polymarket 地址批量分析</h1>
              <p className="mt-1 text-sm text-slate-500">批量查询地址资产、盈亏、交易、活跃、结算与奖励数据</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-500 shadow-sm">Version: v3-visual-polish</span>
            <span className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">Public Data</span>
            <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">No Wallet</span>
            <span className="rounded-full border border-violet-200 bg-violet-50 px-3 py-1 text-xs font-medium text-violet-700">No Login</span>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1800px] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        <section className="rounded-2xl border border-white/80 bg-white/90 p-5 shadow-xl shadow-indigo-100/60 backdrop-blur">
          <form onSubmit={handleSubmit} className="grid gap-5 xl:grid-cols-[1.45fr_1fr_0.9fr]">
            <div className="space-y-4 xl:border-r xl:border-slate-200 xl:pr-5">
              <div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700">⌁</span>
                  <div>
                    <h2 className="text-base font-semibold text-slate-950">批量地址输入</h2>
                    <p className="mt-1 text-sm text-slate-500">每行一个地址，支持批量粘贴。</p>
                  </div>
                </div>
              </div>

              <textarea
                id="addresses"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="每行一个 Polymarket 地址"
                className="h-36 w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2 font-mono text-sm leading-6 text-slate-900 shadow-inner shadow-slate-100 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
              />

              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={isLoading} className="inline-flex h-10 items-center justify-center rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 px-5 text-sm font-semibold text-white shadow-md shadow-indigo-200 transition hover:shadow-lg hover:shadow-indigo-200 disabled:cursor-not-allowed disabled:from-slate-400 disabled:to-slate-400">
                  {isLoading ? "查询中..." : "开始查询"}
                </button>
                <button type="button" onClick={clearAll} disabled={isLoading || (query.length === 0 && accounts.length === 0 && !error)} className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-500 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300">
                  清空
                </button>
              </div>

              <div className="rounded-lg border border-indigo-100 bg-indigo-50/80 px-4 py-3 text-sm text-indigo-900">
                查询公开数据，不连接钱包，不下单。系统自动分批处理，单次最多 {MAX_FRONTEND_ADDRESSES} 个地址。
              </div>
            </div>

            <div className="space-y-4 xl:border-r xl:border-slate-200 xl:px-5">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-violet-50 text-violet-700">#</span>
                <h2 className="text-base font-semibold text-slate-950">地址统计</h2>
              </div>

              <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
                <InputStat label="有效地址" value={inputStats.validCount} tone="emerald" />
                <InputStat label="重复地址" value={inputStats.duplicateCount} tone="amber" />
                <InputStat label="非法地址" value={inputStats.invalidCount} tone="red" />
                <InputStat label="上限" value={MAX_FRONTEND_ADDRESSES} tone="slate" />
              </div>

              <div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                  <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: Math.min(100, (inputCount / MAX_FRONTEND_ADDRESSES) * 100) + "%" }} />
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500">
                  <span>已输入 {inputCount} / {MAX_FRONTEND_ADDRESSES}</span>
                  <span>{formatPercent(inputCount / MAX_FRONTEND_ADDRESSES)}</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-sm">
                {progress.total > 0 && <span className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 font-medium text-indigo-700">已查询 {progress.done} / {progress.total}</span>}
                {copyStatus && <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 font-medium text-emerald-700">{copyStatus}</span>}
              </div>
            </div>

            <div className="space-y-4 xl:pl-1">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-sky-50 text-sky-700">⇩</span>
                <h2 className="text-base font-semibold text-slate-950">导出结果</h2>
              </div>

              <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-1">
                <button type="button" onClick={copyAllAddressInfo} disabled={accounts.length === 0 || isLoading} className="inline-flex h-11 items-center justify-center rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-900 shadow-sm transition hover:border-indigo-200 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:text-slate-400">
                  复制全部地址信息
                </button>
                <button type="button" onClick={exportCsv} disabled={accounts.length === 0 || isLoading} className="inline-flex h-11 items-center justify-center rounded-lg border border-emerald-200 bg-emerald-50 px-4 text-sm font-semibold text-emerald-700 shadow-sm transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-white disabled:text-slate-400">
                  导出 CSV
                </button>
                <button type="button" onClick={exportJson} disabled={accounts.length === 0 || isLoading} className="inline-flex h-11 items-center justify-center rounded-lg border border-indigo-200 bg-indigo-50 px-4 text-sm font-semibold text-indigo-700 shadow-sm transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-white disabled:text-slate-400">
                  导出 JSON
                </button>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4 text-sm text-slate-500">
                <p className="font-medium text-slate-700">查询结果</p>
                <p className="mt-2">{successfulCount} 成功 / {accounts.length} 总计</p>
              </div>
            </div>
          </form>
        </section>

        {progress.total > 0 && (
          <div className="rounded-xl border border-indigo-100 border-l-4 border-l-indigo-500 bg-indigo-50/90 px-4 py-3 text-sm font-medium text-indigo-800 shadow-sm">
            已查询 {progress.done} 个地址，成功 {successfulCount} 个
          </div>
        )}

        {error && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 shadow-sm">{error}</div>}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryBlock label="总盈亏" value={formatSignedMoney(summary.totalPnl)} tone={summary.totalPnl} note="历史累计 + 当前浮盈亏" accent="from-rose-500 to-red-500" icon="pnl" />
          <SummaryBlock label="可用余额" value={formatMoney(summary.totalAvailable)} note="pUSD 可用余额" accent="from-sky-500 to-indigo-500" icon="wallet" />
          <SummaryBlock label="持仓预估" value={formatMoney(summary.totalPositionValue)} note="currentValue 预估" accent="from-violet-500 to-fuchsia-500" icon="layers" />
          <SummaryBlock label="净资产总计" value={formatMoney(summary.totalNetAsset)} note="可用 + 持仓预估" accent="from-indigo-600 to-violet-600" icon="cube" emphasis />
        </section>

        <section className="min-w-0 overflow-hidden rounded-xl border border-white/80 bg-white/95 shadow-xl shadow-indigo-100/50 backdrop-blur">
          <div className="space-y-3 border-b border-slate-200 p-4">
            <div>
              <h2 className="text-base font-semibold text-slate-950">查询详单</h2>
              <p className="mt-1 text-sm text-slate-500">{successfulCount} 成功 / {accounts.length} 总计</p>
            </div>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索地址或错误信息..."
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm shadow-inner shadow-slate-100 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1700px] divide-y divide-slate-200 text-sm">
              <thead className="bg-gradient-to-r from-indigo-700 via-violet-700 to-indigo-700 text-white">
                <tr>
                  {tableHeaders.map((header, headerIndex) => (
                    <th key={header} scope="col" title={headerDescriptions[header]} className={headerClass(headerIndex)}>
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {filteredAccounts.length === 0 ? (
                  <tr>
                    <td colSpan={tableHeaders.length} className="px-4 py-12 text-center text-slate-500">{isLoading ? "正在读取公开数据..." : "暂无数据"}</td>
                  </tr>
                ) : (
                  filteredAccounts.map((account, index) => (
                    <tr key={account.inputAddress + "-" + index} className="group hover:bg-indigo-50/50">
                      <td className="sticky left-0 z-30 w-12 whitespace-nowrap bg-white px-3 py-3 text-slate-500 shadow-[1px_0_0_0_#e5e7eb] group-hover:bg-indigo-50">{index + 1}</td>
                      <td className="sticky left-12 z-20 whitespace-nowrap bg-white px-3 py-3 font-mono text-xs text-slate-700 shadow-[1px_0_0_0_#e5e7eb] group-hover:bg-indigo-50">
                        <span title={account.inputAddress}>{shortAddress(account.inputAddress)}</span>
                        <button type="button" onClick={() => copyText(readAccountAddress(account), "地址")} className="ml-2 rounded-md border border-indigo-100 bg-white px-1.5 py-0.5 text-xs font-sans text-indigo-700 shadow-sm hover:bg-indigo-50">复制</button>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{formatMoney(account.netAsset)}</td>
                      <td className={pnlClass(account.pnl)}>{formatSignedMoney(account.pnl)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{formatMoney(account.available)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{formatMoney(account.positionValue)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{formatMoney(account.volumeUsd)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{formatNumber(account.volumeShares)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{account.marketCount}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{account.lastActiveText}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{account.activeDays}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{account.activeMonths}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{account.positionCount}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{account.tradeCount}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{account.redeemCount}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{account.rewardCount}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-right text-slate-800">{formatMoney(account.rewardAmount)}</td>
                      <td className="sticky right-0 z-20 min-w-56 bg-white px-3 py-3 text-slate-700 shadow-[-1px_0_0_0_#e5e7eb] group-hover:bg-indigo-50">
                        {account.fatalError ? (
                          <div className="flex items-center gap-2">
                            <span title={account.fatalError} className="rounded-full bg-red-50 px-2 py-1 text-xs font-medium text-red-700">Error</span>
                            <button
                              type="button"
                              onClick={() => retryAccount(account.inputAddress)}
                              disabled={retryingAddress === account.inputAddress || isLoading}
                              className="rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-gray-400"
                            >
                              {retryingAddress === account.inputAddress ? "重查中..." : "重新查询"}
                            </button>
                          </div>
                        ) : account.warnings.length > 0 ? (
                          <span title={account.warnings.join("; ")} className="rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">Warning</span>
                        ) : (
                          <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">OK</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

async function requestAccountBatch(addresses: string[]): Promise<BulkAccountsResponse> {
  let lastError: unknown;

  for (let attempt = 0; attempt < BATCH_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout("/api/accounts/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addresses })
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<BulkAccountsResponse>;

      if (!response.ok) {
        throw new Error(payload.error || "批次查询失败：" + response.status);
      }

      return {
        summary: payload.summary ?? emptySummary(),
        accounts: (payload.accounts ?? []).map(normalizeAccount)
      };
    } catch (error) {
      lastError = error;
      if (attempt < BATCH_RETRY_ATTEMPTS - 1) {
        await wait(500 * 2 ** attempt);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("批次查询失败");
}

function normalizeAccount(account: AccountDetail): AccountDetail {
  const fatalError = account.fatalError ?? account.error ?? null;

  return {
    ...account,
    warnings: Array.isArray(account.warnings) ? account.warnings : [],
    fatalError,
    error: account.error ?? fatalError
  };
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), BATCH_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function parseAddressLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function getInputStats(value: string) {
  const lines = parseAddressLines(value);
  const seen = new Set<string>();
  let duplicateCount = 0;
  let invalidCount = 0;

  for (const line of lines) {
    const normalized = line.toLowerCase();

    if (!ADDRESS_PATTERN.test(line)) {
      invalidCount += 1;
    }

    if (seen.has(normalized)) {
      duplicateCount += 1;
    } else {
      seen.add(normalized);
    }
  }

  return {
    total: lines.length,
    validCount: lines.length - invalidCount,
    duplicateCount,
    invalidCount
  };
}

function buildSummary(accounts: AccountDetail[]): AccountSummary {
  const successfulAccounts = accounts.filter((account) => !account.fatalError);
  return {
    totalPnl: sumBy(successfulAccounts, (account) => account.pnl),
    totalAvailable: sumBy(successfulAccounts, (account) => account.available),
    totalPositionValue: sumBy(successfulAccounts, (account) => account.positionValue),
    totalNetAsset: sumBy(successfulAccounts, (account) => account.netAsset)
  };
}

function emptySummary(): AccountSummary {
  return { totalPnl: 0, totalAvailable: 0, totalPositionValue: 0, totalNetAsset: 0 };
}

function emptyAccount(inputAddress: string, error: string): AccountDetail {
  return {
    inputAddress,
    proxyWallet: null,
    netAsset: 0,
    pnl: 0,
    available: 0,
    positionValue: 0,
    volumeUsd: 0,
    volumeShares: 0,
    marketCount: 0,
    lastActiveAt: null,
    lastActiveDaysAgo: null,
    lastActiveText: "-",
    activeDays: 0,
    activeMonths: 0,
    positionCount: 0,
    tradeCount: 0,
    redeemCount: 0,
    rewardCount: 0,
    rewardAmount: 0,
    warnings: [],
    fatalError: error,
    error
  };
}

function InputStat({ label, value, tone }: { label: string; value: number; tone: "emerald" | "amber" | "red" | "slate" }) {
  const toneClass = {
    emerald: "text-emerald-600",
    amber: "text-amber-600",
    red: "text-red-600",
    slate: "text-slate-700"
  }[tone];

  return (
    <div className="border-b border-r border-slate-200 px-4 py-3 text-center last:border-r-0 sm:border-b-0 xl:border-b 2xl:border-b-0">
      <p className={"text-lg font-semibold " + toneClass}>{value}</p>
      <p className="mt-1 text-xs text-slate-500">{label}</p>
    </div>
  );
}

function SummaryBlock({
  label,
  value,
  tone = 0,
  note,
  accent,
  icon,
  emphasis = false
}: {
  label: string;
  value: string;
  tone?: number;
  note: string;
  accent: string;
  icon: SummaryIconName;
  emphasis?: boolean;
}) {
  return (
    <div className={"relative overflow-hidden rounded-2xl border bg-white/95 p-5 shadow-xl shadow-indigo-100/50 transition hover:-translate-y-0.5 hover:shadow-2xl hover:shadow-indigo-100/70 " + (emphasis ? "border-indigo-300 ring-1 ring-indigo-200" : "border-white/80")}>
      <div className={"absolute left-0 top-0 h-full w-1 bg-gradient-to-b " + accent} />
      <div className="flex items-center gap-4">
        <span className={"flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br shadow-lg shadow-indigo-100 " + accent}>
          <SummaryIcon name={icon} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-500">{label}</p>
          <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
            <span className={amountToneClass(tone)}>{value}</span>
          </p>
          <p className="mt-3 text-xs text-slate-500">{note}</p>
        </div>
      </div>
    </div>
  );
}

type SummaryIconName = "pnl" | "wallet" | "layers" | "cube";

function SummaryIcon({ name }: { name: SummaryIconName }) {
  if (name === "pnl") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-7 w-7 text-white">
        <path d="M12 3v18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M16.5 7.5H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }

  if (name === "wallet") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-7 w-7 text-white">
        <path d="M4 7.5h13.5A2.5 2.5 0 0 1 20 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-10Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
        <path d="M4 8.5 15.2 4.4A2 2 0 0 1 18 6.25V8" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        <path d="M16 13.5h4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        <circle cx="16" cy="13.5" r="1" fill="currentColor" />
      </svg>
    );
  }

  if (name === "layers") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-7 w-7 text-white">
        <path d="m12 4 8 4-8 4-8-4 8-4Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
        <path d="m4 12 8 4 8-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        <path d="m4 16 8 4 8-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-7 w-7 text-white">
      <path d="m12 3 7.5 4.25v8.5L12 20l-7.5-4.25v-8.5L12 3Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      <path d="m4.8 7.4 7.2 4.1 7.2-4.1" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      <path d="M12 11.5V20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="m8.5 9.45 7-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.65" />
    </svg>
  );
}

function amountToneClass(value: number) {
  if (value > 0) return "text-emerald-700";
  if (value < 0) return "text-red-700";
  return "text-gray-950";
}

function headerClass(index: number) {
  const base = "whitespace-nowrap px-3 py-3 font-semibold";

  if (index === 0) {
    return base + " sticky left-0 z-40 w-12 bg-indigo-700 text-left shadow-[1px_0_0_0_rgba(255,255,255,0.25)]";
  }

  if (index === 1) {
    return base + " sticky left-12 z-30 bg-indigo-700 text-left shadow-[1px_0_0_0_rgba(255,255,255,0.25)]";
  }

  if (index === tableHeaders.length - 1) {
    return base + " sticky right-0 z-30 bg-indigo-700 text-left shadow-[-1px_0_0_0_rgba(255,255,255,0.25)]";
  }

  return base + (rightAlignedColumnIndexes.has(index) ? " text-right" : " text-left");
}

function pnlClass(value: number) {
  return "whitespace-nowrap px-3 py-3 text-right font-medium " + amountToneClass(value);
}

function formatMoney(value: number) {
  return numberFormatter.format(value);
}

function formatNumber(value: number) {
  return numberFormatter.format(value);
}

function formatPercent(value: number) {
  return Math.min(100, Math.max(0, value * 100)).toFixed(1) + "%";
}

function formatSignedMoney(value: number) {
  const formatted = formatMoney(Math.abs(value));
  if (value > 0) return "+" + formatted;
  if (value < 0) return "-" + formatted;
  return formatted;
}

function shortAddress(address: string) {
  return ADDRESS_PATTERN.test(address) ? address.slice(0, 6) + "..." + address.slice(-4) : address;
}

function readAccountAddress(account: AccountDetail) {
  return account.inputAddress || account.proxyWallet || "";
}

function buildAccountText(account: AccountDetail) {
  return exportFields
    .map((field) => field + ": " + formatExportValue(account[field]))
    .join("\n");
}

function buildTsv(rows: AccountDetail[]) {
  return [
    exportFields.join("\t"),
    ...rows.map((row) => exportFields.map((field) => formatExportValue(row[field])).join("\t"))
  ].join("\n");
}

function downloadBlob(fileName: string, content: string, type: string) {
  const blob = new Blob(["\ufeff", content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function formatCsvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  const stringValue = formatExportValue(value);
  return /[",\n]/.test(stringValue) ? "\"" + stringValue.replace(/"/g, "\"\"") + "\"" : stringValue;
}

function formatExportValue(value: unknown) {
  if (Array.isArray(value)) return value.join("; ");
  if (value === null || value === undefined) return "";
  return String(value);
}

function sumBy<T>(items: T[], readValue: (item: T) => number): number {
  return items.reduce((sum, item) => sum + readValue(item), 0);
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
