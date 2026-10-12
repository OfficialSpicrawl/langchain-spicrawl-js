import { getEnvironmentVariable } from "@langchain/core/utils/env";

export const DEFAULT_BASE_URL = "https://api.spicrawl.com";
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_RETRIES = 2;
/** Never wait longer than this for a `Retry-After`; a longer wait is thrown instead. */
const MAX_RETRY_WAIT_S = 30;

/** Extra `POST /v1/scrape` fields, e.g. `{ js_render: true, wait_for: ".plans" }`. */
export type ScrapeOptions = Record<string, unknown>;

export interface SpicrawlClientParams {
  /** Spicrawl API key. Defaults to the `SPICRAWL_API_KEY` environment variable. */
  apiKey?: string;
  /** API base URL. Defaults to `SPICRAWL_BASE_URL` or `https://api.spicrawl.com`. */
  baseUrl?: string;
  /** Milliseconds to wait for each response. Defaults to 120000. */
  timeout?: number;
  /** Retries of errors the API marks retryable (rate limits, timeouts). Defaults to 2. */
  maxRetries?: number;
}

export interface ScrapeResult {
  url: string;
  content: string;
  finalUrl?: string;
  targetStatus?: number;
  creditsCharged?: number;
  engine?: string;
  cacheState?: string;
  requestId?: string;
}

/**
 * A failed scrape. `code` is the API's stable error code (`ERR::FAMILY::NAME`) or one of
 * `TARGET_STATUS` (the site answered 4xx/5xx) and `CONNECTION` (no response).
 */
export class SpicrawlError extends Error {
  override name = "SpicrawlError";
  readonly code?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfter?: number;
  readonly requestId?: string;

  constructor(
    message: string,
    init: {
      code?: string;
      status?: number;
      retryable?: boolean;
      retryAfter?: number;
      requestId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(
      message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    this.retryAfter = init.retryAfter;
    this.requestId = init.requestId;
  }
}

function toInt(value: string | null | undefined): number | undefined {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isNaN(n) ? undefined : n;
}

function problem(
  status: number,
  headers: Headers,
  text: string,
): SpicrawlError {
  const requestId = headers.get("x-request-id") ?? undefined;
  let body: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "code" in parsed) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON: fall through to the generic error
  }
  if (!body) {
    return new SpicrawlError(`Spicrawl API returned HTTP ${status}.`, {
      status,
      requestId,
    });
  }
  const hint = (body.diagnostics as { hint?: string } | undefined)?.hint;
  const detail = (body.detail ?? body.title ?? "request failed") as string;
  const retryAfter =
    typeof body.retry_after_seconds === "number"
      ? body.retry_after_seconds
      : toInt(headers.get("retry-after"));
  return new SpicrawlError(
    `${body.code as string}: ${detail}${hint ? ` Hint: ${hint}` : ""}`,
    {
      code: body.code as string,
      status,
      retryable: body.retryable === true,
      retryAfter,
      requestId: (body.request_id as string | undefined) ?? requestId,
    },
  );
}

function parse(url: string, status: number, headers: Headers, text: string) {
  if (status < 200 || status >= 300) throw problem(status, headers, text);
  let content = text;
  let targetStatus = toInt(headers.get("x-target-status"));
  if (
    (headers.get("content-type") ?? "").split(";")[0].trim().endsWith("json")
  ) {
    // extract / links / autoparse / ... force the JSON envelope; the page is `content`.
    const envelope = JSON.parse(text) as { content?: string; status?: number };
    content = envelope.content ?? "";
    targetStatus ??= envelope.status;
  }
  const requestId = headers.get("x-request-id") ?? undefined;
  if (targetStatus !== undefined && targetStatus >= 400) {
    // HTTP 200 + X-Target-Status 403/500 is a block or error page, billed 0: not content.
    throw new SpicrawlError(
      `${url} answered HTTP ${targetStatus}; no usable content was returned.`,
      { code: "TARGET_STATUS", status, requestId },
    );
  }
  const result: ScrapeResult = {
    url,
    content,
    finalUrl: headers.get("x-final-url") ?? undefined,
    targetStatus,
    creditsCharged: toInt(headers.get("x-credits-charged")),
    engine: headers.get("x-engine") ?? undefined,
    cacheState: headers.get("cache-state") ?? undefined,
    requestId,
  };
  return result;
}

/** Seconds to wait before retrying, or `undefined` to throw. */
function waitSeconds(
  err: SpicrawlError,
  attempt: number,
  maxRetries: number,
): number | undefined {
  // Only errors the server marks retryable are retried. They are refusals, billed 0, so a
  // retry cannot bill twice. A dropped connection is never retried: the scrape may have run.
  if (attempt >= maxRetries || !err.retryable) return undefined;
  if (err.retryAfter === undefined) {
    return Math.min(0.5 * 2 ** attempt, 8) * (0.5 + Math.random() / 2);
  }
  return err.retryAfter <= MAX_RETRY_WAIT_S ? err.retryAfter : undefined;
}

/** Internal client for `POST /v1/scrape`. Use {@link SpicrawlLoader} or {@link SpicrawlScrapeTool}. */
export class SpicrawlClient {
  // true private field: the key never shows up in console.log, JSON.stringify or traces
  readonly #apiKey: string;
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;

  constructor(params: SpicrawlClientParams = {}) {
    const key = params.apiKey ?? getEnvironmentVariable("SPICRAWL_API_KEY");
    if (!key) {
      throw new Error(
        "No API key: pass apiKey or set the SPICRAWL_API_KEY environment variable.",
      );
    }
    this.#apiKey = key;
    this.baseUrl = (
      params.baseUrl ||
      getEnvironmentVariable("SPICRAWL_BASE_URL") ||
      DEFAULT_BASE_URL
    ).replace(/\/+$/, "");
    this.timeout = params.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, params.maxRetries ?? DEFAULT_MAX_RETRIES);
  }

  /** Scrape `url` and return it as markdown. Throws {@link SpicrawlError}. */
  async scrape(
    url: string,
    options: ScrapeOptions = {},
  ): Promise<ScrapeResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#post(url, options);
      } catch (err) {
        const wait =
          err instanceof SpicrawlError
            ? waitSeconds(err, attempt, this.maxRetries)
            : undefined;
        if (wait === undefined) throw err;
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      }
    }
  }

  async #post(url: string, options: ScrapeOptions): Promise<ScrapeResult> {
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/v1/scrape`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/markdown, application/json",
        },
        // the loader and tool promise markdown, so it overrides any `response_format` option
        body: JSON.stringify({ ...options, url, response_format: "markdown" }),
        signal: AbortSignal.timeout(this.timeout),
      });
    } catch (cause) {
      throw new SpicrawlError(
        `Could not reach Spicrawl: ${cause instanceof Error ? cause.message : String(cause)}`,
        { code: "CONNECTION", cause },
      );
    }
    return parse(url, resp.status, resp.headers, await resp.text());
  }
}
