import { NextResponse } from "next/server";

const DATA_API_BASE_URL = "https://data-api.polymarket.com";
const MAX_ADDRESSES = 20;
const POSITIONS_PER_ADDRESS = 500;

type RawPosition = Record<string, unknown>;

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

type AddressResult = {
  input: string;
  rows: PositionRow[];
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
        { error: "请至少输入一个 0x 开头的钱包地址。" },
        { status: 400 }
      );
    }

    if (inputs.length > MAX_ADDRESSES) {
      return NextResponse.json(
        { error: `一次最多查询 ${MAX_ADDRESSES} 个地址。` },
        { status: 400 }
      );
    }

    const uniqueInputs = Array.from(new Set(inputs));
    const results = await Promise.all(uniqueInputs.map(resolveAddress));
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
      error instanceof Error ? error.message : "地址持仓查询失败，请稍后重试。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function readInputs(body: unknown): string[] {
  if (!body || typeof body !== "object") {
    return [];
  }

  const payload = body as { addresses?: unknown; inputs?: unknown; query?: unknown };
  const rawItems = Array.isArray(payload.addresses)
    ? payload.addresses
    : Array.isArray(payload.inputs)
      ? payload.inputs
      : typeof payload.query === "string"
        ? payload.query.split(/\r?\n/)
        : [];

  return rawItems
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

async function resolveAddress(input: string): Promise<AddressResult> {
  const address = normalizeAddress(input);

  if (!address) {
    return {
      input,
      rows: [],
      error: readAddressError(input)
    };
  }

  try {
    const positions = await fetchPositions(address);

    return {
      input,
      rows: positions.map((position) => toPositionRow(address, position))
    };
  } catch (error) {
    return {
      input,
      rows: [],
      error: error instanceof Error ? error.message : "查询失败。"
    };
  }
}

function normalizeAddress(input: string): string | null {
  const value = input.trim().replace(/^["']|["']$/g, "");
  return /^0x[a-f0-9]{40}$/i.test(value) ? value : null;
}

function readAddressError(input: string): string {
  const value = input.trim().replace(/^["']|["']$/g, "");

  if (/^00x[a-f0-9]{40}$/i.test(value)) {
    return "地址前缀像是多了一个 0。";
  }

  return "请输入 0x 开头、40 位 hex 的钱包地址。";
}

async function fetchPositions(address: string): Promise<RawPosition[]> {
  const params = new URLSearchParams({
    user: address,
    limit: String(POSITIONS_PER_ADDRESS),
    sizeThreshold: "0",
    sortBy: "CURRENT",
    sortDirection: "DESC"
  });
  const response = await fetch(
    `${DATA_API_BASE_URL}/positions?${params.toString()}`,
    {
      headers: {
        accept: "application/json"
      },
      cache: "no-store"
    }
  );

  if (!response.ok) {
    throw new Error(`Polymarket Data API 返回 ${response.status}。`);
  }

  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? data.filter(isRecord) : [];
}

function toPositionRow(address: string, position: RawPosition): PositionRow {
  return {
    address,
    title: getString(position.title) ?? "Untitled market",
    link: buildMarketLink(position),
    outcome: getString(position.outcome) ?? "-",
    size: getNumber(position.size),
    avgPrice: getNumber(position.avgPrice),
    currentPrice: getNumber(position.curPrice, position.currPrice),
    currentValue: getNumber(position.currentValue),
    cashPnl: getNumber(position.cashPnl),
    percentPnl: getNumber(position.percentPnl),
    endTime: getString(position.endDate)
  };
}

function buildMarketLink(position: RawPosition): string {
  const slug = getString(position.eventSlug) ?? getString(position.slug);
  return slug ? `https://polymarket.com/event/${encodeURIComponent(slug)}` : "";
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

function isRecord(value: unknown): value is RawPosition {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
