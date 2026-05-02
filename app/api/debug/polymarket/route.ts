import { NextResponse } from "next/server";
import { formatFetchError, serverFetch } from "../../../lib/serverFetch";

const DATA_API_BASE_URL = "https://data-api.polymarket.com";
const PUSD_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const DEBUG_TIMEOUT_MS = 12_000;
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

type DebugStep = {
  source: string;
  ok: boolean;
  status?: number;
  url?: string;
  sample?: unknown;
  error?: string;
  durationMs: number;
  rpcConfigured?: boolean;
  rpcTriedCount?: number;
  rpcSuccessIndex?: number | null;
};

type TradesSummary = {
  tradeCount: number;
  volumeShares: number;
  volumeUsd: number;
  marketCount: number;
  activeDays: number;
  activeMonths: number;
  firstTradeTimestamp: number | null;
  lastTradeTimestamp: number | null;
  sampleTrades: RawRecord[];
  error?: string;
};

type ActiveDaysCompare = {
  tradesActiveDays: number;
  activityActiveDays: number;
  tradesActiveMonths: number;
  activityActiveMonths: number;
  tradesLastActiveText: string;
  activityLastActiveText: string;
  activityCount: number;
  activityTypeCounts: Record<string, number>;
  activitySample: RawRecord[];
  error?: string;
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

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const address = normalizeAddress(requestUrl.searchParams.get("address") ?? "");

  if (!address) {
    return NextResponse.json(
      {
        error: "请提供合法的 address 查询参数，例如 /api/debug/polymarket?address=0x..."
      },
      { status: 400 }
    );
  }

  const steps: DebugStep[] = [];
  const proxyWallet = address;

  const positionsParams = new URLSearchParams({
    user: proxyWallet,
    limit: "2"
  });
  const positionsResult = await runJsonDiagnostic(
    "positions",
    `${DATA_API_BASE_URL}/positions?${positionsParams.toString()}`
  );
  steps.push(positionsResult.step);

  const closedPositionsParams = new URLSearchParams({
    user: proxyWallet,
    limit: "2",
    offset: "0"
  });
  const closedPositionsResult = await runJsonDiagnostic(
    "closed-positions",
    `${DATA_API_BASE_URL}/closed-positions?${closedPositionsParams.toString()}`
  );
  steps.push(closedPositionsResult.step);

  const tradesParams = new URLSearchParams({
    user: proxyWallet,
    limit: "2",
    offset: "0",
    takerOnly: "false"
  });
  const tradesResult = await runJsonDiagnostic(
    "trades",
    `${DATA_API_BASE_URL}/trades?${tradesParams.toString()}`
  );
  steps.push(tradesResult.step);

  const tradesSummary = await readTradesSummary(proxyWallet);
  const activeDaysCompare = await readActiveDaysCompare(
    proxyWallet,
    tradesSummary
  );

  steps.push(await runPusdRpcDiagnostics(proxyWallet));

  return NextResponse.json({
    inputAddress: address,
    proxyWallet,
    steps,
    tradesSummary,
    activeDaysCompare
  });
}

async function readTradesSummary(proxyWallet: string): Promise<TradesSummary> {
  try {
    const trades = await getAllTrades(proxyWallet);
    return buildTradesSummary(trades);
  } catch (error) {
    return {
      ...emptyTradesSummary(),
      error: getErrorMessage(error)
    };
  }
}

async function getAllTrades(proxyWallet: string): Promise<RawRecord[]> {
  const all: RawRecord[] = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      user: proxyWallet,
      limit: String(TRADES_LIMIT),
      offset: String(offset),
      takerOnly: "false"
    });
    const result = await fetchJsonOnce(
      "trades",
      `${DATA_API_BASE_URL}/trades?${params.toString()}`,
      {}
    );
    const page = Array.isArray(result.data) ? result.data.filter(isRecord) : [];

    all.push(...page);

    if (page.length < TRADES_LIMIT) {
      return all;
    }

    offset += TRADES_LIMIT;
  }
}

function buildTradesSummary(trades: RawRecord[]): TradesSummary {
  const conditionIds = new Set<string>();
  const activeDays = new Set<string>();
  const activeMonths = new Set<string>();
  let volumeShares = 0;
  let volumeUsd = 0;
  let firstTradeMs: number | null = null;
  let lastTradeMs: number | null = null;

  for (const trade of trades) {
    const price = getNumber(trade.price) ?? 0;
    const size = getNumber(trade.size) ?? 0;
    const conditionId = getString(trade.conditionId);
    const timestampMs = readTimestampMs(trade.timestamp);

    volumeShares += size;
    volumeUsd += price * size;

    if (conditionId) {
      conditionIds.add(conditionId);
    }

    const day = timestampToDateKey(trade.timestamp);
    const month = timestampToMonthKey(trade.timestamp);

    if (day) {
      activeDays.add(day);
    }

    if (month) {
      activeMonths.add(month);
    }

    if (timestampMs !== null) {
      firstTradeMs =
        firstTradeMs === null ? timestampMs : Math.min(firstTradeMs, timestampMs);
      lastTradeMs =
        lastTradeMs === null ? timestampMs : Math.max(lastTradeMs, timestampMs);
    }
  }

  return {
    tradeCount: trades.length,
    volumeShares,
    volumeUsd,
    marketCount: conditionIds.size,
    activeDays: activeDays.size,
    activeMonths: activeMonths.size,
    firstTradeTimestamp: firstTradeMs,
    lastTradeTimestamp: lastTradeMs,
    sampleTrades: trades.slice(0, 3)
  };
}

function emptyTradesSummary(): TradesSummary {
  return {
    tradeCount: 0,
    volumeShares: 0,
    volumeUsd: 0,
    marketCount: 0,
    activeDays: 0,
    activeMonths: 0,
    firstTradeTimestamp: null,
    lastTradeTimestamp: null,
    sampleTrades: []
  };
}

async function readActiveDaysCompare(
  proxyWallet: string,
  tradesSummary: TradesSummary
): Promise<ActiveDaysCompare> {
  try {
    const activities = await getAllActivities(proxyWallet);
    const activitySummary = buildActivitySummary(activities);

    return {
      tradesActiveDays: tradesSummary.activeDays,
      activityActiveDays: activitySummary.activeDays,
      tradesActiveMonths: tradesSummary.activeMonths,
      activityActiveMonths: activitySummary.activeMonths,
      tradesLastActiveText: formatLastActiveText(tradesSummary.lastTradeTimestamp),
      activityLastActiveText: formatLastActiveText(activitySummary.lastActivityTimestamp),
      activityCount: activities.length,
      activityTypeCounts: activitySummary.typeCounts,
      activitySample: activities.slice(0, 5),
      error: tradesSummary.error
    };
  } catch (error) {
    return {
      tradesActiveDays: tradesSummary.activeDays,
      activityActiveDays: 0,
      tradesActiveMonths: tradesSummary.activeMonths,
      activityActiveMonths: 0,
      tradesLastActiveText: formatLastActiveText(tradesSummary.lastTradeTimestamp),
      activityLastActiveText: "-",
      activityCount: 0,
      activityTypeCounts: {},
      activitySample: [],
      error: `activity fetch failed: ${getErrorMessage(error)}`
    };
  }
}

async function getAllActivities(proxyWallet: string): Promise<RawRecord[]> {
  const all: RawRecord[] = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      user: proxyWallet,
      limit: String(ACTIVITY_LIMIT),
      offset: String(offset)
    });
    const result = await fetchJsonOnce(
      "activity",
      `${DATA_API_BASE_URL}/activity?${params.toString()}`,
      {}
    );
    const page = Array.isArray(result.data) ? result.data.filter(isRecord) : [];

    all.push(...page);

    if (page.length < ACTIVITY_LIMIT) {
      return all;
    }

    offset += ACTIVITY_LIMIT;
  }
}

function buildActivitySummary(activities: RawRecord[]) {
  const activeDays = new Set<string>();
  const activeMonths = new Set<string>();
  const typeCounts: Record<string, number> = {};
  let lastActivityTimestamp: number | null = null;

  for (const activity of activities) {
    const day = timestampToDateKey(activity.timestamp);
    const month = timestampToMonthKey(activity.timestamp);
    const timestampMs = readTimestampMs(activity.timestamp);
    const type =
      getString(activity.type) ??
      getString(activity.activityType) ??
      getString(activity.eventType) ??
      "UNKNOWN";

    if (day) {
      activeDays.add(day);
    }

    if (month) {
      activeMonths.add(month);
    }

    if (timestampMs !== null) {
      lastActivityTimestamp =
        lastActivityTimestamp === null
          ? timestampMs
          : Math.max(lastActivityTimestamp, timestampMs);
    }

    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  }

  return {
    activeDays: activeDays.size,
    activeMonths: activeMonths.size,
    lastActivityTimestamp,
    typeCounts
  };
}

async function runPusdRpcDiagnostics(proxyWallet: string): Promise<DebugStep> {
  const startedAt = Date.now();
  const rpcUrls = getPolygonRpcUrls();

  if (rpcUrls.length === 0) {
    return {
      source: "pusd-balance-rpc",
      ok: false,
      error: "POLYGON_RPC_URLS not configured",
      durationMs: Date.now() - startedAt,
      rpcConfigured: false,
      rpcTriedCount: 0,
      rpcSuccessIndex: null
    };
  }

  const errors: string[] = [];

  for (let index = 0; index < rpcUrls.length; index += 1) {
    const result = await runJsonDiagnostic(
      "pusd-balance-rpc",
      rpcUrls[index],
      buildPusdRpcRequest(proxyWallet)
    );
    const rpcSemanticError = getPusdRpcSemanticError(result.step, result.data);

    if (result.step.ok && !rpcSemanticError) {
      return {
        ...result.step,
        durationMs: Date.now() - startedAt,
        rpcConfigured: true,
        rpcTriedCount: index + 1,
        rpcSuccessIndex: index
      };
    }

    errors.push(rpcSemanticError || result.step.error || "unknown RPC error");
  }

  return {
    source: "pusd-balance-rpc",
    ok: false,
    error: `pUSD balance fetch failed: all RPC endpoints failed; lastError=${errors.at(-1) ?? "unknown"}`,
    durationMs: Date.now() - startedAt,
    rpcConfigured: true,
    rpcTriedCount: rpcUrls.length,
    rpcSuccessIndex: null
  };
}

function buildPusdRpcRequest(proxyWallet: string): RequestInit {
  return {
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
          data: `0x70a08231${proxyWallet.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`
        },
        "latest"
      ]
    })
  };
}

function getPusdRpcSemanticError(step: DebugStep, data: unknown): string | null {
  if (!step.ok) {
    return step.error ?? "unknown RPC error";
  }

  if (!isRecord(data)) {
    return formatFetchDiagnostic({
      source: "pusd-balance-rpc",
      url: step.url ?? "[rpc-endpoint]",
      status: step.status ?? 200,
      bodySnippet: createBodySnippet(JSON.stringify(data)),
      timeout: false,
      retry: 0,
      message: "invalid RPC response"
    });
  }

  const rpcError = data.error;
  const result = data.result;

  if (!rpcError && typeof result === "string") {
    return null;
  }

  return formatFetchDiagnostic({
    source: "pusd-balance-rpc",
    url: step.url ?? "[rpc-endpoint]",
    status: step.status ?? 200,
    bodySnippet: createBodySnippet(JSON.stringify(data)),
    timeout: false,
    retry: 0,
    message: isRecord(rpcError) && typeof rpcError.message === "string"
      ? rpcError.message
      : "empty RPC balance result"
  });
}

async function runJsonDiagnostic(
  source: RequestSource,
  url: string,
  init: RequestInit = {}
): Promise<{ step: DebugStep; data: unknown | null }> {
  const startedAt = Date.now();

  try {
    const result = await fetchJsonOnce(source, url, init);

    return {
      data: result.data,
      step: {
        source,
        ok: true,
        status: result.status,
        url: sanitizeUrl(source, url),
        sample: sampleData(result.data),
        durationMs: Date.now() - startedAt
      }
    };
  } catch (error) {
    const diagnosticError = toDiagnosticFetchError(source, url, 0, error);

    return {
      data: null,
      step: {
        source,
        ok: false,
        status: diagnosticError.diagnostic.status ?? undefined,
        url: diagnosticError.diagnostic.url,
        error: diagnosticError.message,
        durationMs: Date.now() - startedAt
      }
    };
  }
}

async function fetchJsonOnce(
  source: RequestSource,
  url: string,
  init: RequestInit
): Promise<{ status: number; data: unknown }> {
  const response = await fetchWithTimeout(url, init);
  const body = await response.text().catch(() => "");
  const bodySnippet = createBodySnippet(body);

  if (!response.ok) {
    throw new DiagnosticFetchError({
      source,
      url: sanitizeUrl(source, url),
      status: response.status,
      bodySnippet,
      timeout: false,
      retry: 0,
      message: response.statusText || "HTTP request failed"
    });
  }

  try {
    return {
      status: response.status,
      data: JSON.parse(body) as unknown
    };
  } catch (error) {
    throw new DiagnosticFetchError({
      source,
      url: sanitizeUrl(source, url),
      status: response.status,
      bodySnippet,
      timeout: false,
      retry: 0,
      message: `JSON parse failed: ${getErrorMessage(error)}`
    });
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEBUG_TIMEOUT_MS);
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
    message: timeout ? `timeout after ${DEBUG_TIMEOUT_MS}ms: ${message}` : message
  });
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

function sampleData(data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.slice(0, 2);
  }

  if (!isRecord(data)) {
    return data;
  }

  const sampledEntries = Object.entries(data).slice(0, 12).map(([key, value]) => {
    if (Array.isArray(value)) {
      return [key, value.slice(0, 2)] as const;
    }

    if (isRecord(value)) {
      return [key, Object.fromEntries(Object.entries(value).slice(0, 8))] as const;
    }

    return [key, value] as const;
  });

  return Object.fromEntries(sampledEntries);
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

function normalizeAddress(input: string): string | null {
  const value = input.trim().replace(/^["']|["']$/g, "");
  return /^0x[a-f0-9]{40}$/i.test(value) ? value : null;
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
  return timestampMs === null ? "" : new Date(timestampMs).toISOString().slice(0, 10);
}

function timestampToMonthKey(timestamp: unknown): string {
  const dateKey = timestampToDateKey(timestamp);
  return dateKey ? dateKey.slice(0, 7) : "";
}

function formatLastActiveText(timestampMs: number | null): string {
  return timestampMs === null ? "-" : formatDaysAgo(diffUtcDays(timestampMs, Date.now()));
}

function diffUtcDays(fromMs: number, toMs: number): number {
  const fromDate = new Date(new Date(fromMs).toISOString().slice(0, 10));
  const toDate = new Date(new Date(toMs).toISOString().slice(0, 10));

  return Math.max(
    0,
    Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000)
  );
}

function formatDaysAgo(daysAgo: number): string {
  if (daysAgo === 0) {
    return "今天";
  }

  return `${daysAgo}天前`;
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
