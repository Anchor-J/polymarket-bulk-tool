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
  "状态/错误"
];

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
  "warnings",
  "fatalError",
  "error"
];

const numberFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export default function Home() {
  const [query, setQuery] = useState("");
  const [accounts, setAccounts] = useState<AccountDetail[]>([]);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [search, setSearch] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [retryingAddress, setRetryingAddress] = useState("");

  const inputCount = useMemo(() => parseAddressLines(query).length, [query]);
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

    const csv = [exportFields, ...accounts.map((account) => exportFields.map((field) => account[field]))]
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
    <main className="min-h-screen bg-[#f6f8fc] text-gray-950">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <h1 className="text-lg font-semibold tracking-normal">Polymarket 地址批量分析</h1>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">Version: v3-activity-days</span>
            <span className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">Public Data</span>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="border-b border-gray-200 pb-2">
              <span className="inline-flex border-b-2 border-indigo-600 px-2 pb-2 text-sm font-medium text-indigo-700">粘贴地址</span>
            </div>

            <textarea
              id="addresses"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="每行输入一个 Polymarket 地址"
              className="h-44 w-full resize-none rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-sm leading-6 text-gray-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />

            <div className="rounded-md border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
              查询公开数据，不连接钱包，不下单。单次最多 500 个地址，系统会自动分批处理。
            </div>

            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="text-sm text-gray-500">
                {inputCount} / {MAX_FRONTEND_ADDRESSES} 地址
                {progress.total > 0 && <span className="ml-3 font-medium text-indigo-700">已查询 {progress.done} / {progress.total}</span>}
                {copyStatus && <span className="ml-3 text-emerald-700">{copyStatus}</span>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={isLoading} className="inline-flex h-10 items-center justify-center rounded-md bg-indigo-600 px-4 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-gray-400">
                  {isLoading ? "查询中..." : "开始查询"}
                </button>
                <button type="button" onClick={copyAllAddressInfo} disabled={accounts.length === 0 || isLoading} className="inline-flex h-10 items-center justify-center rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-900 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400">
                  复制全部地址信息
                </button>
                <button type="button" onClick={exportCsv} disabled={accounts.length === 0 || isLoading} className="inline-flex h-10 items-center justify-center rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-900 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400">
                  导出 CSV
                </button>
                <button type="button" onClick={exportJson} disabled={accounts.length === 0 || isLoading} className="inline-flex h-10 items-center justify-center rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-900 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400">
                  导出 JSON
                </button>
              </div>
            </div>
          </form>
        </section>

        {progress.total > 0 && (
          <div className="rounded-lg border-l-4 border-indigo-500 bg-indigo-50 px-4 py-3 text-sm font-medium text-indigo-800">
            已查询 {progress.done} 个地址，成功 {successfulCount} 个
          </div>
        )}

        {error && <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{error}</div>}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryBlock label="总盈亏" value={formatSignedMoney(summary.totalPnl)} tone={summary.totalPnl} note="历史累计 + 当前浮盈亏" />
          <SummaryBlock label="可用余额" value={formatMoney(summary.totalAvailable)} note="pUSD" />
          <SummaryBlock label="持仓预估" value={formatMoney(summary.totalPositionValue)} note="currentValue 合计" />
          <SummaryBlock label="净资产总计" value={formatMoney(summary.totalNetAsset)} note="可用 + 持仓" />
        </section>

        <section className="min-w-0 rounded-lg border border-gray-200 bg-white shadow-sm">
          <div className="space-y-3 border-b border-gray-200 p-4">
            <div>
              <h2 className="text-base font-semibold text-gray-950">查询详单</h2>
              <p className="mt-1 text-sm text-gray-500">{successfulCount} 成功 / {accounts.length} 总计</p>
            </div>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索地址或错误信息..."
              className="h-10 w-full rounded-md border border-gray-300 px-3 text-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1320px] divide-y divide-gray-200 text-sm">
              <thead className="bg-indigo-600 text-white">
                <tr>
                  {tableHeaders.map((header) => <th key={header} scope="col" className="whitespace-nowrap px-3 py-3 text-left font-medium">{header}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {filteredAccounts.length === 0 ? (
                  <tr>
                    <td colSpan={tableHeaders.length} className="px-4 py-12 text-center text-gray-500">{isLoading ? "正在读取公开数据..." : "暂无数据"}</td>
                  </tr>
                ) : (
                  filteredAccounts.map((account, index) => (
                    <tr key={account.inputAddress + "-" + index}>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-500">{index + 1}</td>
                      <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-gray-700">
                        <span title={account.inputAddress}>{shortAddress(account.inputAddress)}</span>
                        <button type="button" onClick={() => copyText(readAccountAddress(account), "地址")} className="ml-2 rounded border border-gray-200 px-1.5 py-0.5 text-xs font-sans text-indigo-700 hover:bg-indigo-50">复制</button>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-800">{formatMoney(account.netAsset)}</td>
                      <td className={pnlClass(account.pnl)}>{formatSignedMoney(account.pnl)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-800">{formatMoney(account.available)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-800">{formatMoney(account.positionValue)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-800">{formatMoney(account.volumeUsd)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-800">{formatNumber(account.volumeShares)}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-800">{account.marketCount}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-800">{account.lastActiveText}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-800">{account.activeDays}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-800">{account.activeMonths}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-800">{account.positionCount}</td>
                      <td className="whitespace-nowrap px-3 py-3 text-gray-800">{account.tradeCount}</td>
                      <td className="min-w-64 px-3 py-3 text-gray-700">
                        {account.fatalError ? (
                          <div className="space-y-2">
                            <span className="block text-red-700">{account.fatalError}</span>
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
                          <span className="text-amber-700">{account.warnings.join("; ")}</span>
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
    warnings: [],
    fatalError: error,
    error
  };
}

function SummaryBlock({ label, value, tone = 0, note }: { label: string; value: string; tone?: number; note: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 text-center shadow-sm">
      <p className="text-sm text-gray-500">{label}</p>
      <p className={"mt-3 text-2xl font-semibold " + amountToneClass(tone)}>{value}</p>
      <p className="mt-2 text-xs text-gray-500">{note}</p>
    </div>
  );
}

function amountToneClass(value: number) {
  if (value > 0) return "text-emerald-700";
  if (value < 0) return "text-red-700";
  return "text-gray-950";
}

function pnlClass(value: number) {
  return "whitespace-nowrap px-3 py-3 font-medium " + amountToneClass(value);
}

function formatMoney(value: number) {
  return numberFormatter.format(value);
}

function formatNumber(value: number) {
  return numberFormatter.format(value);
}

function formatSignedMoney(value: number) {
  const formatted = formatMoney(Math.abs(value));
  if (value > 0) return "+" + formatted;
  if (value < 0) return "-" + formatted;
  return formatted;
}

function shortAddress(address: string) {
  return /^0x[a-f0-9]{40}$/i.test(address) ? address.slice(0, 6) + "..." + address.slice(-4) : address;
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
