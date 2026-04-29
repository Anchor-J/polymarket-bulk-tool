import { NextResponse } from "next/server";

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const MAX_INPUTS = 50;

type RawMarket = Record<string, unknown>;
type RawEvent = Record<string, unknown>;

type InputTarget =
  | { kind: "slug"; value: string }
  | { kind: "token"; value: string }
  | { kind: "condition"; value: string }
  | { kind: "marketId"; value: string };

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

type InputResult = {
  input: string;
  rows: MarketRow[];
  error?: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const inputs = readInputs(body);

    if (inputs.length === 0) {
      return NextResponse.json(
        { error: "请至少输入一个 Polymarket market URL、slug 或 token id。" },
        { status: 400 }
      );
    }

    if (inputs.length > MAX_INPUTS) {
      return NextResponse.json(
        { error: `一次最多查询 ${MAX_INPUTS} 行。` },
        { status: 400 }
      );
    }

    const uniqueInputs = Array.from(new Set(inputs));
    const results = await Promise.all(uniqueInputs.map(resolveInput));
    const data = results.flatMap((result) => result.rows);
    const errors = results
      .filter((result) => result.error)
      .map((result) => ({
        input: result.input,
        message: result.error as string
      }));

    return NextResponse.json({
      data,
      errors,
      count: data.length
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "批量查询失败，请稍后重试。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function readInputs(body: unknown): string[] {
  if (!body || typeof body !== "object") {
    return [];
  }

  const payload = body as { inputs?: unknown; query?: unknown };
  const rawItems = Array.isArray(payload.inputs)
    ? payload.inputs
    : typeof payload.query === "string"
      ? payload.query.split(/\r?\n/)
      : [];

  return rawItems
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

async function resolveInput(input: string): Promise<InputResult> {
  const unsupportedAddressMessage = readUnsupportedAddressMessage(input);

  if (unsupportedAddressMessage) {
    return {
      input,
      rows: [],
      error: unsupportedAddressMessage
    };
  }

  const target = parseInput(input);

  if (!target) {
    return {
      input,
      rows: [],
      error: "无法识别输入，请使用 market URL、slug 或 token id。"
    };
  }

  try {
    if (target.kind === "slug") {
      const market = await fetchMarketBySlug(target.value);

      if (market) {
        return { input, rows: [toMarketRow(input, market)] };
      }

      const event = await fetchEventBySlug(target.value);
      const markets = readEventMarkets(event);

      if (markets.length > 0) {
        return {
          input,
          rows: markets.map((eventMarket) => toMarketRow(input, eventMarket))
        };
      }

      return {
        input,
        rows: [],
        error: "没有找到匹配的 market 或 event。"
      };
    }

    const market =
      target.kind === "token"
        ? await fetchMarketByFilter("clob_token_ids", target.value)
        : target.kind === "condition"
          ? await fetchMarketByFilter("condition_ids", target.value)
          : await fetchMarketByFilter("id", target.value);

    if (!market) {
      return {
        input,
        rows: [],
        error: "没有找到匹配的 market。"
      };
    }

    return { input, rows: [toMarketRow(input, market)] };
  } catch (error) {
    return {
      input,
      rows: [],
      error: error instanceof Error ? error.message : "查询失败。"
    };
  }
}

function parseInput(input: string): InputTarget | null {
  const value = input.trim().replace(/^["']|["']$/g, "");
  const tokenFromUrl = readTokenFromUrl(value);

  if (tokenFromUrl) {
    return { kind: "token", value: tokenFromUrl };
  }

  const slugFromUrl = readSlugFromUrl(value);

  if (slugFromUrl) {
    return { kind: "slug", value: slugFromUrl };
  }

  const pathSlug = value.match(/^(?:\/)?(?:event|market|markets)\/([^/?#]+)/i);

  if (pathSlug?.[1]) {
    return { kind: "slug", value: cleanSlug(pathSlug[1]) };
  }

  if (/^0x[a-f0-9]{64}$/i.test(value)) {
    return { kind: "condition", value };
  }

  if (/^\d{20,}$/.test(value)) {
    return { kind: "token", value };
  }

  if (/^\d+$/.test(value)) {
    return { kind: "marketId", value };
  }

  const slug = cleanSlug(value);
  return slug ? { kind: "slug", value: slug } : null;
}

function readSlugFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const marketSegmentIndex = segments.findIndex((segment) =>
      ["event", "market", "markets"].includes(segment.toLowerCase())
    );

    if (marketSegmentIndex >= 0 && segments[marketSegmentIndex + 1]) {
      return cleanSlug(segments[marketSegmentIndex + 1]);
    }

    const lastSegment = segments.at(-1);
    return lastSegment ? cleanSlug(lastSegment) : null;
  } catch {
    return null;
  }
}

function readTokenFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const token =
      url.searchParams.get("token_id") ||
      url.searchParams.get("tokenId") ||
      url.searchParams.get("token") ||
      url.searchParams.get("asset_id") ||
      url.searchParams.get("assetId") ||
      url.searchParams.get("tid");

    return token && /^\d{20,}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

function cleanSlug(value: string): string {
  return safeDecode(value)
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split(/[?#]/)[0]
    .trim();
}

function readUnsupportedAddressMessage(input: string): string | null {
  const value = input.trim().replace(/^["']|["']$/g, "");

  if (/^00x[a-f0-9]{40}$/i.test(value)) {
    return "这个地址前缀像是多了一个 0；当前版本只支持 market URL、slug 或 token id，不支持个人地址查询。";
  }

  if (/^0x[a-f0-9]{40}$/i.test(value)) {
    return "当前版本只支持 market URL、slug 或 token id，不支持个人地址查询。";
  }

  return null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function fetchMarketBySlug(slug: string): Promise<RawMarket | null> {
  return fetchMarketByFilter("slug", slug);
}

async function fetchEventBySlug(slug: string): Promise<RawEvent | null> {
  const params = new URLSearchParams({ limit: "1", slug });
  const events = await fetchPolymarket<RawEvent[]>(
    `${GAMMA_BASE_URL}/events?${params.toString()}`
  );

  return Array.isArray(events) ? (events[0] ?? null) : null;
}

async function fetchMarketByFilter(
  key: "id" | "slug" | "clob_token_ids" | "condition_ids",
  value: string
): Promise<RawMarket | null> {
  const params = new URLSearchParams({ limit: "1" });
  params.append(key, value);

  const markets = await fetchPolymarket<RawMarket[]>(
    `${GAMMA_BASE_URL}/markets?${params.toString()}`
  );

  return Array.isArray(markets) ? (markets[0] ?? null) : null;
}

async function fetchPolymarket<T>(url: string): Promise<T | null> {
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    },
    cache: "no-store"
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Polymarket API 返回 ${response.status}。`);
  }

  return (await response.json()) as T;
}

function readEventMarkets(event: RawEvent | null): RawMarket[] {
  if (!event) {
    return [];
  }

  return Array.isArray(event.markets)
    ? event.markets.filter(isRecord)
    : [];
}

function toMarketRow(input: string, market: RawMarket): MarketRow {
  const endTime =
    getString(market.endDateIso) ??
    getString(market.endDate) ??
    getString(market.umaEndDateIso) ??
    getString(market.closedTime);

  return {
    input,
    title: getString(market.question) ?? getString(market.title) ?? "Untitled market",
    link: buildMarketLink(market),
    yesPrice: readOutcomePrice(market, "yes"),
    noPrice: readOutcomePrice(market, "no"),
    volumeUsd: getNumber(market.volumeNum, market.volume),
    volumeShares: getNumber(
      market.volumeSharesNum,
      market.volumeShares,
      market.sharesVolume,
      market.volumeClob
    ),
    liquidity: getNumber(market.liquidityNum, market.liquidityClob, market.liquidity),
    ended: readEnded(market, endTime),
    endTime
  };
}

function buildMarketLink(market: RawMarket): string {
  const slug = getString(market.slug);
  return slug ? `https://polymarket.com/event/${encodeURIComponent(slug)}` : "";
}

function readOutcomePrice(market: RawMarket, outcomeName: "yes" | "no") {
  const outcomes = parseArray(market.outcomes).map((item) =>
    String(item).trim().toLowerCase()
  );
  const prices = parseArray(market.outcomePrices);
  let index = outcomes.findIndex((outcome) => outcome === outcomeName);

  if (index < 0) {
    index = outcomeName === "yes" ? 0 : 1;
  }

  return getNumber(prices[index]);
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function readEnded(market: RawMarket, endTime: string | null): boolean {
  const closed = typeof market.closed === "boolean" ? market.closed : false;
  const archived = typeof market.archived === "boolean" ? market.archived : false;
  const endTimestamp = endTime ? Date.parse(endTime) : Number.NaN;
  const endDatePassed = Number.isFinite(endTimestamp)
    ? endTimestamp < Date.now()
    : false;

  return closed || archived || endDatePassed;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string") {
      const parsed = Number(value.replace(/[$,%\s,]/g, ""));

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function isRecord(value: unknown): value is RawMarket {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
