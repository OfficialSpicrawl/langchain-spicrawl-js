import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpicrawlError, SpicrawlLoader } from "../index.js";
import { PAGE, mockFetch, page, problem, sentBody } from "./helpers.js";

beforeEach(() => {
  vi.stubEnv("SPICRAWL_API_KEY", "spicrawl_test_unit");
  vi.stubEnv("SPICRAWL_BASE_URL", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("SpicrawlLoader", () => {
  it("returns markdown documents with metadata", async () => {
    const spy = mockFetch(page());
    const docs = await new SpicrawlLoader("https://example.com").load();

    expect(docs).toHaveLength(1);
    expect(docs[0].pageContent).toBe(PAGE);
    expect(docs[0].metadata).toEqual({
      source: "https://example.com",
      title: "Example Domain",
      final_url: "https://example.com/",
      target_status: 200,
      credits_charged: 1,
      engine: "fetch",
      cache_state: "miss",
      request_id: "01M0HF5WFWE7PRE8KZHDTNETWN",
    });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://api.spicrawl.com/v1/scrape");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer spicrawl_test_unit",
    );
    expect(sentBody(spy)).toEqual({
      url: "https://example.com",
      response_format: "markdown",
    });
  });

  it("keeps URL order and sends scrapeOptions, but response_format is always markdown", async () => {
    const spy = mockFetch(page("body"));
    const loader = new SpicrawlLoader(["https://a.test", "https://b.test"], {
      apiKey: "spicrawl_test_explicit",
      scrapeOptions: { js_render: true, response_format: "html" },
    });
    const docs = await loader.load();

    expect(docs.map((d) => d.metadata.source)).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
    expect("title" in docs[0].metadata).toBe(false); // no heading: key omitted
    expect(sentBody(spy, 0)).toEqual({
      js_render: true,
      url: "https://a.test",
      response_format: "markdown",
    });
    const init = spy.mock.calls[0][1];
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer spicrawl_test_explicit",
    );
  });

  it("lazyLoad yields documents one by one", async () => {
    mockFetch(page());
    const seen: string[] = [];
    for await (const doc of new SpicrawlLoader([
      "https://a.test",
      "https://b.test",
    ]).lazyLoad()) {
      seen.push(doc.metadata.source as string);
    }
    expect(seen).toEqual(["https://a.test", "https://b.test"]);
  });

  it("uses the content of a JSON envelope", async () => {
    mockFetch(
      page(JSON.stringify({ status: 200, content: PAGE, links: [] }), {
        "content-type": "application/json",
      }),
    );
    const docs = await new SpicrawlLoader("https://example.com", {
      scrapeOptions: { links: true },
    }).load();
    expect(docs[0].pageContent).toBe(PAGE);
  });

  it("throws API errors with code, hint and request id", async () => {
    mockFetch(
      problem("ERR::LIMIT::QUOTA_EXCEEDED", 402, {
        request_id: "01ABC",
        diagnostics: { hint: "Raise the monthly ceiling." },
      }),
    );
    const err = await new SpicrawlLoader("https://example.com")
      .load()
      .catch((e) => e);

    expect(err).toBeInstanceOf(SpicrawlError);
    expect(err.code).toBe("ERR::LIMIT::QUOTA_EXCEEDED");
    expect(err.status).toBe(402);
    expect(err.requestId).toBe("01ABC");
    expect(err.message).toContain("It broke.");
    expect(err.message).toContain("Hint: Raise the monthly ceiling.");
  });

  it("does not treat a blocked target page as content", async () => {
    mockFetch(page("Access denied", { "x-target-status": "403" }));
    const err = await new SpicrawlLoader("https://example.com")
      .load()
      .catch((e) => e);
    expect(err.code).toBe("TARGET_STATUS");
    expect(err.message).toContain("403");
  });

  it("continueOnFailure skips bad URLs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch(({ init }) =>
      (JSON.parse(init.body as string) as { url: string }).url ===
      "https://bad.test"
        ? problem("ERR::UPSTREAM::DNS_FAILED", 502)
        : page(),
    );
    const docs = await new SpicrawlLoader(
      ["https://bad.test", "https://example.com"],
      {
        continueOnFailure: true,
      },
    ).load();

    expect(docs.map((d) => d.metadata.source)).toEqual(["https://example.com"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("https://bad.test"),
    );
  });

  it("retries retryable errors, then succeeds", async () => {
    const spy = mockFetch(
      problem("ERR::LIMIT::RATE_LIMITED", 429, {
        retryable: true,
        retry_after_seconds: 0,
      }),
      problem("ERR::LIMIT::CONCURRENCY_EXCEEDED", 429, {
        retryable: true,
        retry_after_seconds: 0,
      }),
      page(),
    );
    const docs = await new SpicrawlLoader("https://example.com", {
      maxRetries: 2,
    }).load();
    expect(spy).toHaveBeenCalledTimes(3);
    expect(docs[0].pageContent).toBe(PAGE);
  });

  it("backs off when the API gives no Retry-After", async () => {
    vi.useFakeTimers();
    const spy = mockFetch(
      problem("ERR::UPSTREAM::TIMEOUT", 504, { retryable: true }),
      page(),
    );
    const pending = new SpicrawlLoader("https://example.com").load();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("stops at maxRetries", async () => {
    const spy = mockFetch(
      problem("ERR::LIMIT::RATE_LIMITED", 429, {
        retryable: true,
        retry_after_seconds: 0,
      }),
    );
    await expect(
      new SpicrawlLoader("https://example.com", { maxRetries: 1 }).load(),
    ).rejects.toThrow("RATE_LIMITED");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable error", async () => {
    const spy = mockFetch(problem("ERR::AUTH::INVALID_KEY", 401));
    await expect(
      new SpicrawlLoader("https://example.com").load(),
    ).rejects.toThrow("INVALID_KEY");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never retries a dropped connection: the scrape may have been billed", async () => {
    const spy = mockFetch(new TypeError("fetch failed"));
    const err = await new SpicrawlLoader("https://example.com")
      .load()
      .catch((e) => e);
    expect(err.code).toBe("CONNECTION");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("reads the base URL from SPICRAWL_BASE_URL", async () => {
    vi.stubEnv("SPICRAWL_BASE_URL", "https://api.example.test/");
    const spy = mockFetch(page());
    await new SpicrawlLoader("https://example.com").load();
    expect(spy.mock.calls[0][0]).toBe("https://api.example.test/v1/scrape");
  });

  it("requires an API key", () => {
    vi.stubEnv("SPICRAWL_API_KEY", "");
    expect(() => new SpicrawlLoader("https://example.com")).toThrow(
      "SPICRAWL_API_KEY",
    );
  });

  it("does not leak the key when printed", () => {
    const loader = new SpicrawlLoader("https://example.com");
    expect(JSON.stringify(loader)).not.toContain("spicrawl_test_unit");
    expect(String(Object.values(loader))).not.toContain("spicrawl_test_unit");
  });
});
