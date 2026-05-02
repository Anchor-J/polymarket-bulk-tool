import { NextResponse } from "next/server";
import { formatFetchError, serverFetch } from "../../../lib/serverFetch";

const DATA_API_BASE_URL = "https://data-api.polymarket.com";
const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const PUSD_DECIMALS = 6;
const MAX_ADDRESSES_PER_REQUEST = 25;
const ACCOUNT_CONCURRENCY = 3;
const FETCH_TIMEOUT_MS = 6_000;
const RPC_FETCH_TIMEOUT_MS = 3_000;
const RETRY_ATTEMPTS = 2;
const POSITIONS_LIMIT = 500;
const CLOSED_POSITIONS_LIMIT = 50;
const TRADES_LIMIT = 10_000;
const ACTIVITY_LIMIT = 500;
const RESPONSE_BODY_SNIPPET_LENGTH = 300;

type RawRecord = Record<string, unknown>;

type RequestSource =
  | "positions"
  | "closed-positions"
  | "trades"
  | "activity"
  | "pusd-balance-rpc";

type AccountSummary = {
  totalPnl: number;
  totalAvailable: number;
  totalPositionValue: number;
  totalNetAsset: number;
};

type AccountDebug = {
  positionsStatus?: string;
  closedPositionsStatus?: string;
  tradesStatus?: string;
  activityStatus?: string;
  pusdStatus?: string;
  rpcConfigured?: boolean;
  rpcTriedCount?: number;
  rpcSuccessIndex?: number | null;
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
  debug?: AccountDebug;
};

type BulkAccountsResponse = {
  summary: AccountSummary;
  accounts: AccountDetail[];
};

type FetchDiagnostic = {
  source: RequestSource;
  url: string;
  status: number | null;
  bodySnippet: string;
  timeout: boolean;
  retry: number;
  message: string;
};

type PusdBalanceResult = {
  available: number;
  status: string;
  rpcConfigured: boolean;
  rpcTriedCount: number;
  rpcSuccessIndex: number | null;
  error: string | null;
};

class DiagnosticFetchError extends Error {
  diagnostic: FetchDiagnostic;

  constructor(diagnostic: FetchDiagnostic) {
    super(formatFetchDiagnostic(diagnostic));
    this.name = "DiagnosticFetchError";
    this.diagnostic = diagnostic;
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const addresses = readAddresses(body);

  if (addresses.length === 0) {
    return NextResponse.json(
      {
        summary: emptySummary(),
        accounts: [],
        error: "请至少输入一个 0x 开头的钱包地址。"
      },
      { status: 400 }
    );
  }

  if (addresses.length > MAX_ADDRESSES_PER_REQUEST) {
    return NextResponse.json(
      {
        summary: emptySummary(),
        accounts: addresses.map((address) =>
          emptyAccount(address, null, `单次 API 最多查询 ${MAX_ADDRESSES_PER_REQUEST} 个地址。`)
        )
      },
      { status: 200 }
    );
  }

  const uniqueAddresses = Array.from(new Set(addresses));
  const accounts = await mapWithConcurrency(
    uniqueAddresses,
    ACCOUNT_CONCURRENCY,
    buildAccountDetail
  );

  return NextResponse.json({
    summary: buildSummary(accounts),
    accounts
  } satisfies BulkAccountsResponse);
}

function readAddresses(body: unknown): string[] {
  if (!body || typeof body !== "object") {
    return [];
  }

  const payload = body as { addresses?: unknown; query?: unknown };
  const rawItems = Array.isArray(payload.addresses)
    ? payload.addresses
    : typeof payload.query === "string"
      ? payload.query.split(/\r?\n/)
      : [];

  return rawItems
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function normalizeAddress(input: string): string | null {
  const value = input.trim().replace(/^["']|["']$/g, "");
  return /^0x[a-f0-9]{40}$/i.test(value) ? value : null;
}

async function getPositions(proxyWallet: string): Promise<RawRecord[]> {
  const all: RawRecord[] = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      user: proxyWallet,
      limit: String(POSITIONS_LIMIT),
      offset: String(offset),
      sizeThreshold: "0",
      sortBy: "CURRENT",
      sortDirection: "DESC"
    });
    const page = await fetchArray(
      "positions",
      `${DATA_API_BASE_URL}/positions?${params.toString()}`
    );

    all.push(...page);

    if (page.length < POSITIONS_LIMIT) {
      return all;
    }

    offset += POSITIONS_LIMIT;
  }
}

async function getClosedPositions(proxyWallet: string): Promise<RawRecord[]> {
  const all: RawRecord[] = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      user: proxyWallet,
      limit: String(CLOSED_POSITIONS_LIMIT),
      offset: String(offset)
    });
    const page = await fetchArray(
      "closed-positions",
      `${DATA_API_BASE_URL}/closed-positions?${params.toString()}`
    );

    all.push(...page);

    if (page.length < CLOSED_POSITIONS_LIMIT) {
      return all;
    }

    offset += CLOSED_POSITIONS_LIMIT;
  }
}

async function getTrades(proxyWallet: string): Promise<RawRecord[]> {
  const all: RawRecord[] = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      user: proxyWallet,
      limit: String(TRADES_LIMIT),
      offset: String(offset),
      takerOnly: "false"
    });
    const page = await fetchArray(
      "trades",
      `${DATA_API_BASE_URL}/trades?${params.toString()}`
    );

    all.push(...page);

    if (page.length < TRADES_LIMIT) {
      return all;
    }

    offset += TRADES_LIMIT;
  }
}

async function getActivities(proxyWallet: string): Promise<RawRecord[]> {
  const all: RawRecord[] = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      user: proxyWallet,
      limit: String(ACTIVITY_LIMIT),
      offset: String(offset)
    });
    const page = await fetchArray(
      "activity",
      `${DATA_API_BASE_URL}/activity?${params.toString()}`
    );

    all.push(...page);

    if (page.length < ACTIVITY_LIMIT) {
      return all;
    }

    offset += ACTIVITY_LIMIT;
  }
}

async function getPusdBalance(proxyWallet: string): Promise<PusdBalanceResult> {
  const rpcUrls = getPolygonRpcUrls();

  if (rpcUrls.length === 0) {
    return {
      available: 0,
      status: "POLYGON_RPC_URLS not configured",
      rpcConfigured: false,
      rpcTriedCount: 0,
      rpcSuccessIndex: null,
      error: "pUSD balance unavailable"
    };
  }

  const errors: string[] = [];

  for (let index = 0; index < rpcUrls.length; index += 1) {
    try {
      const available = await fetchPusdBalanceFromRpc(proxyWallet, rpcUrls[index]);

      return {
        available,
        status: `ok rpcSuccessIndex=${index}`,
        rpcConfigured: true,
        rpcTriedCount: index + 1,
        rpcSuccessIndex: index,
        error: null
      };
    } catch (error) {
      errors.push(`rpc#${index}: ${getErrorMessage(error)}`);
    }
  }

  return {
    available: 0,
    status: `all RPC endpoints failed; rpcTriedCount=${rpcUrls.length}; lastError=${errors.at(-1) ?? "unknown"}`,
    rpcConfigured: true,
    rpcTriedCount: rpcUrls.length,
    rpcSuccessIndex: null,
    error: "pUSD balance fetch failed: all RPC endpoints failed"
  };
}

async function fetchPusdBalanceFromRpc(
  proxyWallet: string,
  rpcUrl: string
): Promise<number> {
  const data = `0x70a08231${proxyWallet.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
  const response = await fetchJsonWithRetry<{
    error?: { message?: string };
    result?: string;
  }>("pusd-balance-rpc", rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        {
          to: PUSD_ADDRESS,
          data
        },
        "latest"
      ]
    })
  }, {
    attempts: 1,
    timeoutMs: RPC_FETCH_TIMEOUT_MS
  });

  if (response.error || !response.result) {
    throw new DiagnosticFetchError({
      source: "pusd-balance-rpc",
      url: sanitizeUrl("pusd-balance-rpc", rpcUrl),
      status: 200,
      bodySnippet: createBodySnippet(JSON.stringify(response)),
      timeout: false,
      retry: 0,
      message: response.error?.message || "empty RPC balance result"
    });
  }

  try {
    return Number(BigInt(response.result)) / 10 ** PUSD_DECIMALS;
  } catch (error) {
    throw new DiagnosticFetchError({
      source: "pusd-balance-rpc",
      url: sanitizeUrl("pusd-balance-rpc", rpcUrl),
      status: 200,
      bodySnippet: createBodySnippet(JSON.stringify(response)),
      timeout: false,
      retry: 0,
      message: `invalid RPC balance result: ${getErrorMessage(error)}`
    });
  }
}

function getPolygonRpcUrls(): string[] {
  const listValue = process.env.POLYGON_RPC_URLS?.trim();

  if (listValue) {
    return listValue
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean);
  }

  const legacyValue = process.env.POLYGON_RPC_URL?.trim();
  return legacyValue ? [legacyValue] : [];
}

async function buildAccountDetail(inputAddress: string): Promise<AccountDetail> {
  const normalizedAddress = normalizeAddress(inputAddress);

  if (!normalizedAddress) {
    return emptyAccount(inputAddress, null, readAddressError(inputAddress));
  }

  const warnings: string[] = [];
  const dataFailures: string[] = [];
  const debug: AccountDebug = {};
  const proxyWallet = normalizedAddress;

  let positions: RawRecord[] = [];
  let closedPositions: RawRecord[] = [];
  let trades: RawRecord[] = [];
  let activities: RawRecord[] = [];
  let available = 0;
  let positionsOk = false;
  let closedPositionsOk = false;
  let tradesOk = false;
  let activityOk = false;

  await Promise.all([
    getPositions(proxyWallet)
      .then((value) => {
        positions = value;
        positionsOk = true;
        debug.positionsStatus = `ok rows=${value.length}`;
      })
      .catch((error) => {
        const message = getErrorMessage(error);
        debug.positionsStatus = message;
        dataFailures.push(`positions fetch failed: ${message}`);
      }),
    getClosedPositions(proxyWallet)
      .then((value) => {
        closedPositions = value;
        closedPositionsOk = true;
        debug.closedPositionsStatus = `ok rows=${value.length}`;
      })
      .catch((error) => {
        const message = getErrorMessage(error);
        debug.closedPositionsStatus = message;
        dataFailures.push(`closed positions fetch failed: ${message}`);
      }),
    getTrades(proxyWallet)
      .then((value) => {
        trades = value;
        tradesOk = true;
        debug.tradesStatus = `ok rows=${value.length}`;
      })
      .catch((error) => {
        const message = getErrorMessage(error);
        debug.tradesStatus = message;
        dataFailures.push(`trades fetch failed: ${message}`);
      }),
    getActivities(proxyWallet)
      .then((value) => {
        activities = value;
        activityOk = true;
        debug.activityStatus = `ok rows=${value.length}`;
      })
      .catch((error) => {
        const message = getErrorMessage(error);
        debug.activityStatus = message;
        warnings.push("activity fetch failed");
      }),
    getPusdBalance(proxyWallet)
      .then((result) => {
        available = result.available;
        debug.pusdStatus = result.status;
        debug.rpcConfigured = result.rpcConfigured;
        debug.rpcTriedCount = result.rpcTriedCount;
        debug.rpcSuccessIndex = result.rpcSuccessIndex;

        if (result.error) {
          warnings.push("pUSD balance unavailable");
        }
      })
      .catch((error) => {
        const message = getErrorMessage(error);
        debug.pusdStatus = message;
        debug.rpcConfigured = getPolygonRpcUrls().length > 0;
        debug.rpcTriedCount = getPolygonRpcUrls().length;
        debug.rpcSuccessIndex = null;
        warnings.push("pUSD balance unavailable");
      })
  ]);

  const dataSuccessCount = [positionsOk, closedPositionsOk, tradesOk].filter(Boolean).length;
  const fatalError =
    dataSuccessCount === 0
      ? dataFailures.join("; ") || "positions, closed positions and trades all failed"
      : null;

  if (!fatalError) {
    warnings.push(...dataFailures);
  }

  const positionValue = sumBy(positions, (position) =>
    getNumber(position.currentValue)
  );
  const openPnl = sumBy(positions, (position) => getNumber(position.cashPnl));
  const realizedPnl = sumBy(closedPositions, (position) =>
    getNumber(position.realizedPnl)
  );
  const tradeStats = buildTradeStats(trades);
  const activityStats = buildActivityStats(activities);
  const pnl = openPnl + realizedPnl;

  return {
    inputAddress: normalizedAddress,
    proxyWallet,
    netAsset: available + positionValue,
    pnl,
    available,
    positionValue,
    volumeUsd: tradeStats.volumeUsd,
    volumeShares: tradeStats.volumeShares,
    marketCount: tradeStats.marketCount,
    lastActiveAt: tradeStats.lastActiveAt,
    lastActiveDaysAgo: tradeStats.lastActiveDaysAgo,
    lastActiveText: tradeStats.lastActiveText,
    activeDays: activityOk ? activityStats.activeDays : tradeStats.activeDays,
    activeMonths: tradeStats.activeMonths,
    positionCount: positions.length,
    tradeCount: trades.length,
    warnings,
    fatalError,
    error: fatalError,
    debug
  };
}

function buildActivityStats(activities: RawRecord[]) {
  const activeDays = new Set<string>();

  for (const activity of activities) {
    const day = timestampToDateKey(activity.timestamp);

    if (day) {
      activeDays.add(day);
    }
  }

  return {
    activeDays: activeDays.size
  };
}

function buildTradeStats(trades: RawRecord[]) {
  const conditionIds = new Set<string>();
  const activeDays = new Set<string>();
  const activeMonths = new Set<string>();
  let volumeUsd = 0;
  let volumeShares = 0;
  let lastActiveMs: number | null = null;

  for (const trade of trades) {
    const price = getNumber(trade.price) ?? 0;
    const size = getNumber(trade.size) ?? 0;
    const conditionId = getString(trade.conditionId);
    const timestampMs = readTimestampMs(trade.timestamp);

    volumeUsd += price * size;
    volumeShares += size;

    if (conditionId) {
      conditionIds.add(conditionId);
    }

    if (timestampMs !== null) {
      const day = timestampToDateKey(trade.timestamp);
      const month = timestampToMonthKey(trade.timestamp);

      if (day) {
        activeDays.add(day);
      }

      if (month) {
        activeMonths.add(month);
      }

      lastActiveMs =
        lastActiveMs === null ? timestampMs : Math.max(lastActiveMs, timestampMs);
    }
  }

  const lastActiveDaysAgo =
    lastActiveMs === null ? null : diffUtcDays(lastActiveMs, Date.now());

  return {
    volumeUsd,
    volumeShares,
    marketCount: conditionIds.size,
    lastActiveAt: lastActiveMs === null ? null : new Date(lastActiveMs).toISOString(),
    lastActiveDaysAgo,
    lastActiveText: formatDaysAgo(lastActiveDaysAgo),
    activeDays: activeDays.size,
    activeMonths: activeMonths.size
  };
}

function buildSummary(accounts: AccountDetail[]): AccountSummary {
  const successfulAccounts = accounts.filter((account) => !account.fatalError);

  return {
    totalPnl: sumBy(successfulAccounts, (account) => account.pnl),
    totalAvailable: sumBy(successfulAccounts, (account) => account.available),
    totalPositionValue: sumBy(
      successfulAccounts,
      (account) => account.positionValue
    ),
    totalNetAsset: sumBy(successfulAccounts, (account) => account.netAsset)
  };
}

function emptySummary(): AccountSummary {
  return {
    totalPnl: 0,
    totalAvailable: 0,
    totalPositionValue: 0,
    totalNetAsset: 0
  };
}

function emptyAccount(
  inputAddress: string,
  proxyWallet: string | null,
  error: string
): AccountDetail {
  return {
    inputAddress,
    proxyWallet,
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
    error,
    debug: {}
  };
}

function readAddressError(input: string): string {
  const value = input.trim().replace(/^["']|["']$/g, "");

  if (/^00x[a-f0-9]{40}$/i.test(value)) {
    return "地址前缀像是多了一个 0。";
  }

  return "请输入 0x 开头、40 位 hex 的地址。";
}

async function fetchArray(
  source: RequestSource,
  url: string
): Promise<RawRecord[]> {
  const data = await fetchJsonWithRetry<unknown>(source, url);
  return Array.isArray(data) ? data.filter(isRecord) : [];
}

async function fetchJsonWithRetry<T>(
  source: RequestSource,
  url: string,
  init: RequestInit = {},
  options: { attempts?: number; timeoutMs?: number } = {}
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? RETRY_ATTEMPTS);
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs);
      const body = await response.text().catch(() => "");
      const bodySnippet = createBodySnippet(body);

      if (!response.ok) {
        throw new DiagnosticFetchError({
          source,
          url: sanitizeUrl(source, url),
          status: response.status,
          bodySnippet,
          timeout: false,
          retry: attempt,
          message: response.statusText || "HTTP request failed"
        });
      }

      try {
        return JSON.parse(body) as T;
      } catch (error) {
        throw new DiagnosticFetchError({
          source,
          url: sanitizeUrl(source, url),
          status: response.status,
          bodySnippet,
          timeout: false,
          retry: attempt,
          message: `JSON parse failed: ${getErrorMessage(error)}`
        });
      }
    } catch (error) {
      const diagnosticError = toDiagnosticFetchError(source, url, attempt, error);
      lastError = diagnosticError;

      if (attempt < attempts - 1 && shouldRetryFetchError(diagnosticError)) {
        await wait(backoffMs(attempt));
        continue;
      }

      throw diagnosticError;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("request failed");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);

  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  try {
    return await serverFetch(url, {
      ...init,
      headers,
      cache: "no-store",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function toDiagnosticFetchError(
  source: RequestSource,
  url: string,
  retry: number,
  error: unknown
): DiagnosticFetchError {
  if (error instanceof DiagnosticFetchError) {
    return error;
  }

  const timeout = isAbortError(error);
  const message = getErrorMessage(error);

  return new DiagnosticFetchError({
    source,
    url: sanitizeUrl(source, url),
    status: null,
    bodySnippet: "",
    timeout,
    retry,
    message: timeout ? `timeout after fetch timeout: ${message}` : message
  });
}

function shouldRetryFetchError(error: DiagnosticFetchError): boolean {
  const status = error.diagnostic.status;

  if (error.diagnostic.timeout || status === null) {
    return true;
  }

  return isRetryableStatus(status);
}

function formatFetchDiagnostic(diagnostic: FetchDiagnostic): string {
  return [
    `source=${diagnostic.source}`,
    `url=${diagnostic.url}`,
    `status=${diagnostic.status ?? "n/a"}`,
    `body=${diagnostic.bodySnippet || "(empty)"}`,
    `timeout=${diagnostic.timeout ? "true" : "false"}`,
    `retry=${diagnostic.retry}`,
    `error=${diagnostic.message || "(none)"}`
  ].join(" | ");
}

function createBodySnippet(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, RESPONSE_BODY_SNIPPET_LENGTH);
}

function sanitizeUrl(source: RequestSource, url: string): string {
  try {
    const parsed = new URL(url);

    if (source === "pusd-balance-rpc") {
      return `${parsed.origin}/[rpc-endpoint]`;
    }

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/api|key|token|secret|password/i.test(key)) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }

    return parsed.toString();
  } catch {
    return url;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message === "fetch failed" || error.name === "ServerFetchError"
      ? formatFetchError(error)
      : error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "unknown error";
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /abort|timeout/i.test(error.message))
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runWorker)
  );

  return results;
}

function readTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }

  if (typeof value === "string" && value.trim()) {
    const numberValue = Number(value);

    if (Number.isFinite(numberValue)) {
      return numberValue < 1_000_000_000_000 ? numberValue * 1000 : numberValue;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function timestampToDateKey(timestamp: unknown): string {
  const timestampMs = readTimestampMs(timestamp);
  return timestampMs === null ? "" : formatUtcDate(timestampMs);
}

function timestampToMonthKey(timestamp: unknown): string {
  const dateKey = timestampToDateKey(timestamp);
  return dateKey ? dateKey.slice(0, 7) : "";
}

function formatUtcDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function diffUtcDays(fromMs: number, toMs: number): number {
  const fromDate = new Date(formatUtcDate(fromMs));
  const toDate = new Date(formatUtcDate(toMs));
  return Math.max(
    0,
    Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000)
  );
}

function formatDaysAgo(daysAgo: number | null): string {
  if (daysAgo === null) {
    return "-";
  }

  if (daysAgo === 0) {
    return "今天";
  }

  return `${daysAgo}天前`;
}

function isRetryableStatus(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

function backoffMs(attempt: number): number {
  return 300 * 2 ** attempt;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sumBy<T>(items: T[], readValue: (item: T) => number | null): number {
  return items.reduce((sum, item) => sum + (readValue(item) ?? 0), 0);
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,%\s,]/g, ""));

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
