import { NextResponse } from "next/server";
import {
  formatFetchError,
  getProxyCount,
  getProxyMode,
  isProxyEnabled,
  isRpcConfigured,
  readErrorAttempts,
  readErrorStatus,
  serverFetchWithMeta
} from "../../../lib/serverFetch";

const TEST_ADDRESS = "0xAFA86E35F54B3BcD0911a9a658cCE20030077C36";
const DATA_TEST_URL = `https://data-api.polymarket.com/positions?user=${TEST_ADDRESS}&limit=2`;
const FETCH_TIMEOUT_MS = 12_000;

type NetworkCheck = {
  ok: boolean;
  status: number | null;
  error: string | null;
  durationMs: number;
  attempts: number;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const dataApi = await checkEndpoint(DATA_TEST_URL);

  return NextResponse.json({
    proxyEnabled: isProxyEnabled(),
    proxyMode: getProxyMode(),
    proxyCount: getProxyCount(),
    rpcConfigured: isRpcConfigured(),
    dataApi
  });
}

async function checkEndpoint(url: string): Promise<NetworkCheck> {
  const startedAt = Date.now();

  try {
    const result = await serverFetchWithMeta(url, {
      cache: "no-store",
      headers: {
        accept: "application/json"
      }
    }, {
      timeoutMs: FETCH_TIMEOUT_MS
    });
    const response = result.response;

    return {
      ok: response.ok,
      status: response.status,
      error: response.ok
        ? null
        : `HTTP ${response.status}: ${response.statusText || "HTTP request failed"}`,
      durationMs: Date.now() - startedAt,
      attempts: result.attempts
    };
  } catch (error) {
    return {
      ok: false,
      status: readErrorStatus(error),
      error: getErrorMessage(error),
      durationMs: Date.now() - startedAt,
      attempts: readErrorAttempts(error)
    };
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return formatFetchError(error);
  }

  return typeof error === "string" ? error : "unknown error";
}
