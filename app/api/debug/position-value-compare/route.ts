import { NextResponse } from "next/server";
import { formatFetchError, serverFetch } from "../../../lib/serverFetch";

const DATA_API_BASE_URL = "https://data-api.polymarket.com";
const POSITIONS_LIMIT = 500;
const FETCH_TIMEOUT_MS = 12_000;

type RawRecord = Record<string, unknown>;

type CompareResult = {
  address: string;
  positionsCurrentValueSum: number;
  valueApiValue: number | null;
  diff: number | null;
  positionCount: number;
  positionsFetched: number;
  matched: boolean;
  warnings: string[];
  error: string | null;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const addresses = readAddresses(requestUrl.searchParams.get("addresses"));

  if (addresses.length === 0) {
    return NextResponse.json(
      {
        error:
          "请提供 addresses 查询参数，例如 /api/debug/position-value-compare?addresses=0x...,0x..."
      },
      { status: 400 }
    );
  }

  const results = await Promise.all(addresses.map(comparePositionValue));

  return NextResponse.json({ results });
}

function readAddresses(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .split(",")
        .map((item) => normalizeAddress(item))
        .filter((item): item is string => Boolean(item))
    )
  );
}

function normalizeAddress(input: string): string | null {
  const value = input.trim().replace(/^["']|["']$/g, "");
  return /^0x[a-f0-9]{40}$/i.test(value) ? value : null;
}

async function comparePositionValue(address: string): Promise<CompareResult> {
  const warnings: string[] = [];
  let positions: RawRecord[] = [];

  try {
    positions = await getPositions(address);
  } catch (error) {
    return {
      address,
      positionsCurrentValueSum: 0,
      valueApiValue: null,
      diff: null,
      positionCount: 0,
      positionsFetched: 0,
      matched: false,
      warnings,
      error: `positions fetch failed: ${getErrorMessage(error)}`
    };
  }

  const positionsCurrentValueSum = sumBy(positions, (position) =>
    getNumber(position.currentValue)
  );
  let valueApiValue: number | null = null;

  try {
    valueApiValue = await getValueApiValue(address);

    if (valueApiValue === null) {
      warnings.push("value API returned no value");
    }
  } catch (error) {
    warnings.push(`value API fetch failed: ${getErrorMessage(error)}`);
  }

  const diff =
    valueApiValue === null ? null : positionsCurrentValueSum - valueApiValue;
  const matched = diff === null ? false : Math.abs(diff) < 0.01;

  if (diff !== null && !matched) {
    warnings.push("positions currentValue sum differs from value API");
  }

  return {
    address,
    positionsCurrentValueSum,
    valueApiValue,
    diff,
    positionCount: positions.length,
    positionsFetched: positions.length,
    matched,
    warnings,
    error: null
  };
}

async function getPositions(address: string): Promise<RawRecord[]> {
  const all: RawRecord[] = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      user: address,
      limit: String(POSITIONS_LIMIT),
      offset: String(offset),
      sizeThreshold: "0"
    });
    const data = await fetchJson(
      `${DATA_API_BASE_URL}/positions?${params.toString()}`
    );
    const page = Array.isArray(data) ? data.filter(isRecord) : [];

    all.push(...page);

    if (page.length < POSITIONS_LIMIT) {
      return all;
    }

    offset += POSITIONS_LIMIT;
  }
}

async function getValueApiValue(address: string): Promise<number | null> {
  const params = new URLSearchParams({ user: address });
  const data = await fetchJson(`${DATA_API_BASE_URL}/value?${params.toString()}`);

  if (!Array.isArray(data) || data.length === 0 || !isRecord(data[0])) {
    return null;
  }

  return getNumber(data[0].value);
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await serverFetch(
    url,
    {
      headers: {
        accept: "application/json"
      },
      cache: "no-store"
    },
    {
      timeoutMs: FETCH_TIMEOUT_MS
    }
  );
  const body = await response.text().catch(() => "");

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(`JSON parse failed: ${getErrorMessage(error)}`);
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

function sumBy<T>(items: T[], readValue: (item: T) => number | null): number {
  return items.reduce((sum, item) => sum + (readValue(item) ?? 0), 0);
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
