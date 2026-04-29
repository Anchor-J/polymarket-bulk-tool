type FetchInitWithDispatcher = RequestInit & {
  dispatcher?: unknown;
};

type UndiciModule = {
  fetch: (url: string, init?: FetchInitWithDispatcher) => Promise<Response>;
  ProxyAgent: new (proxyUrl: string) => unknown;
};

type ProxyMode = "range" | "list" | "single" | "none";

type ProxyConfig = {
  enabled: boolean;
  mode: ProxyMode;
  count: number;
  urls: string[];
};

type ServerFetchOptions = {
  retries?: number;
  timeoutMs?: number;
};

type ServerFetchResult = {
  response: Response;
  attempts: number;
  usedProxy: boolean;
};

const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 12_000;
const RETRY_BACKOFF_MS = [500, 1000, 2000];
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED"
]);

const proxyAgents = new Map<string, unknown>();
let cachedUndici: Promise<UndiciModule> | null = null;

class ServerFetchError extends Error {
  attempts: number;
  status: number | null;

  constructor(message: string, attempts: number, status: number | null, cause: unknown) {
    super(message);
    this.name = "ServerFetchError";
    this.attempts = attempts;
    this.status = status;
    this.cause = cause;
  }
}

export function isProxyEnabled(): boolean {
  return getProxyConfig().enabled;
}

export function getProxyMode(): ProxyMode {
  return getProxyConfig().mode;
}

export function getProxyCount(): number {
  return getProxyConfig().count;
}

export function isRpcConfigured(): boolean {
  return Boolean(process.env.POLYGON_RPC_URLS || process.env.POLYGON_RPC_URL);
}

export async function serverFetch(
  url: string,
  init: RequestInit = {},
  options: ServerFetchOptions = {}
): Promise<Response> {
  const result = await serverFetchWithMeta(url, init, options);
  return result.response;
}

export async function serverFetchWithMeta(
  url: string,
  init: RequestInit = {},
  options: ServerFetchOptions = {}
): Promise<ServerFetchResult> {
  const retries = options.retries ?? DEFAULT_RETRIES;
  const maxAttempts = retries + 1;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proxyConfig = getProxyConfig();
  let lastError: unknown = null;

  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    const attempts = attemptIndex + 1;
    const proxyUrl = selectProxyUrl(proxyConfig, attemptIndex);

    try {
      const response = await doFetch(url, init, timeoutMs, proxyUrl);

      if (
        RETRYABLE_STATUS_CODES.has(response.status) &&
        attemptIndex < maxAttempts - 1
      ) {
        lastError = new ServerFetchError(
          `HTTP ${response.status}`,
          attempts,
          response.status,
          null
        );
        await response.body?.cancel().catch(() => undefined);
        await wait(backoffMs(attemptIndex));
        continue;
      }

      return {
        response,
        attempts,
        usedProxy: Boolean(proxyUrl)
      };
    } catch (error) {
      lastError = error;

      if (attemptIndex < maxAttempts - 1 && isRetryableError(error)) {
        await wait(backoffMs(attemptIndex));
        continue;
      }

      throw new ServerFetchError(
        "server fetch failed",
        attempts,
        readErrorStatus(error),
        error
      );
    }
  }

  throw new ServerFetchError(
    "server fetch failed",
    maxAttempts,
    readErrorStatus(lastError),
    lastError
  );
}

export function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error === "string" ? error : "unknown error";
  }

  const cause = readErrorCause(error);
  const parts = [
    `attempts=${readErrorAttempts(error)}`,
    `name=${error.name}`,
    `message=${error.message}`,
    `cause.message=${cause.message ?? "n/a"}`,
    `cause.code=${cause.code ?? "n/a"}`,
    `cause.errno=${cause.errno ?? "n/a"}`,
    `cause.address=${cause.address ?? "n/a"}`,
    `cause.port=${cause.port ?? "n/a"}`
  ];

  return parts.join(" | ");
}

export function readErrorAttempts(error: unknown): number {
  return typeof error === "object" &&
    error !== null &&
    "attempts" in error &&
    typeof (error as { attempts?: unknown }).attempts === "number"
    ? (error as { attempts: number }).attempts
    : 1;
}

export function readErrorStatus(error: unknown): number | null {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
    ? (error as { status: number }).status
    : null;
}

async function doFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  proxyUrl: string | null
): Promise<Response> {
  const signalController = createTimeoutSignal(init.signal, timeoutMs);
  const requestInit = {
    ...init,
    signal: signalController.signal
  };

  try {
    if (!proxyUrl) {
      return await fetch(url, requestInit);
    }

    const undici = await getUndici();
    const agent = getProxyAgent(proxyUrl, undici);

    return await undici.fetch(url, {
      ...requestInit,
      dispatcher: agent
    });
  } finally {
    signalController.cleanup();
  }
}

function getProxyConfig(): ProxyConfig {
  if (process.env.USE_PROXY !== "true") {
    return { enabled: false, mode: "none", count: 0, urls: [] };
  }

  const rangeConfig = getRangeProxyUrls();

  if (rangeConfig.length > 0) {
    return {
      enabled: true,
      mode: "range",
      count: rangeConfig.length,
      urls: rangeConfig
    };
  }

  const listConfig = getProxyListUrls();

  if (listConfig.length > 0) {
    return {
      enabled: true,
      mode: "list",
      count: listConfig.length,
      urls: listConfig
    };
  }

  const singleProxy = process.env.HTTPS_PROXY?.trim();

  if (singleProxy) {
    return {
      enabled: true,
      mode: "single",
      count: 1,
      urls: [singleProxy]
    };
  }

  return { enabled: false, mode: "none", count: 0, urls: [] };
}

function getRangeProxyUrls(): string[] {
  const host = process.env.PROXY_HOST?.trim();
  const start = Number(process.env.PROXY_PORT_START);
  const end = Number(process.env.PROXY_PORT_END);
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;

  if (
    !host ||
    !process.env.PROXY_PORT_START ||
    !process.env.PROXY_PORT_END ||
    !user ||
    !pass ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start
  ) {
    return [];
  }

  const encodedUser = encodeURIComponent(user);
  const encodedPass = encodeURIComponent(pass);
  const urls: string[] = [];

  for (let port = start; port <= end; port += 1) {
    urls.push(`http://${encodedUser}:${encodedPass}@${host}:${port}`);
  }

  return urls;
}

function getProxyListUrls(): string[] {
  return process.env.HTTPS_PROXY_LIST
    ? process.env.HTTPS_PROXY_LIST.split(",")
        .map((url) => url.trim())
        .filter(Boolean)
    : [];
}

function selectProxyUrl(proxyConfig: ProxyConfig, attemptIndex: number): string | null {
  if (!proxyConfig.enabled || proxyConfig.urls.length === 0) {
    return null;
  }

  return proxyConfig.urls[attemptIndex % proxyConfig.urls.length];
}

function getProxyAgent(proxyUrl: string, undici: UndiciModule): unknown {
  const cachedAgent = proxyAgents.get(proxyUrl);

  if (cachedAgent) {
    return cachedAgent;
  }

  const agent = new undici.ProxyAgent(proxyUrl);
  proxyAgents.set(proxyUrl, agent);
  return agent;
}

async function getUndici(): Promise<UndiciModule> {
  if (!cachedUndici) {
    const importPackage = new Function("return import('undici')") as () => Promise<unknown>;

    cachedUndici = importPackage()
      .then((module) => module as unknown as UndiciModule)
      .catch((error) => {
        const wrapped = new Error(
          "undici dependency is required when USE_PROXY=true; run npm install undici"
        ) as Error & { cause?: unknown };
        wrapped.cause = error;
        throw wrapped;
      });
  }

  return cachedUndici;
}

function createTimeoutSignal(inputSignal: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (inputSignal?.aborted) {
    controller.abort();
  }

  const abort = () => {
    controller.abort();
  };

  inputSignal?.addEventListener("abort", abort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      inputSignal?.removeEventListener("abort", abort);
    }
  };
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const cause = readErrorCause(error);
  const message = `${error.message} ${cause.message ?? ""}`.toLowerCase();

  return (
    error.name === "AbortError" ||
    message.includes("fetch failed") ||
    RETRYABLE_ERROR_CODES.has(cause.code ?? "")
  );
}

function readErrorCause(error: Error): {
  message?: string;
  code?: string;
  errno?: string | number;
  address?: string;
  port?: string | number;
} {
  const nestedCause = (error as Error & { cause?: unknown }).cause;
  const cause =
    nestedCause instanceof Error &&
    "cause" in nestedCause &&
    typeof nestedCause.cause === "object" &&
    nestedCause.cause !== null
      ? nestedCause.cause
      : nestedCause;

  if (!cause || typeof cause !== "object") {
    return {};
  }

  const record = cause as Record<string, unknown>;

  return {
    message: typeof record.message === "string" ? record.message : undefined,
    code: typeof record.code === "string" ? record.code : undefined,
    errno:
      typeof record.errno === "string" || typeof record.errno === "number"
        ? record.errno
        : undefined,
    address: typeof record.address === "string" ? record.address : undefined,
    port:
      typeof record.port === "string" || typeof record.port === "number"
        ? record.port
        : undefined
  };
}

function backoffMs(attemptIndex: number): number {
  return RETRY_BACKOFF_MS[Math.min(attemptIndex, RETRY_BACKOFF_MS.length - 1)];
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
