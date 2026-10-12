import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolMessage } from "@langchain/core/messages";
import { SpicrawlError, SpicrawlScrapeTool } from "../index.js";
import { PAGE, mockFetch, page, problem, sentBody } from "./helpers.js";

beforeEach(() => {
  vi.stubEnv("SPICRAWL_API_KEY", "spicrawl_test_unit");
  vi.stubEnv("SPICRAWL_BASE_URL", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("SpicrawlScrapeTool", () => {
  it("has a name, a description and a schema with url and js_render", () => {
    const tool = new SpicrawlScrapeTool();
    expect(tool.name).toBe("spicrawl_scrape");
    expect(tool.description).toContain("markdown");
    expect(Object.keys(tool.schema.shape)).toEqual(["url", "js_render"]);
  });

  it("returns the page as markdown", async () => {
    const spy = mockFetch(page());
    const tool = new SpicrawlScrapeTool({
      scrapeOptions: { main_content_only: true },
    });

    expect(await tool.invoke({ url: "https://example.com/pricing" })).toBe(
      PAGE.trim(),
    );
    expect(sentBody(spy)).toEqual({
      main_content_only: true,
      url: "https://example.com/pricing",
      response_format: "markdown",
    });
  });

  it("passes js_render to the API", async () => {
    const spy = mockFetch(page());
    await new SpicrawlScrapeTool().invoke({
      url: "https://example.com",
      js_render: true,
    });
    expect(sentBody(spy).js_render).toBe(true);
  });

  it("answers a tool call with a ToolMessage", async () => {
    mockFetch(page());
    const tool = new SpicrawlScrapeTool();
    const msg = await tool.invoke({
      type: "tool_call",
      id: "1",
      name: tool.name,
      args: { url: "https://example.com" },
    });
    expect(msg).toBeInstanceOf(ToolMessage);
    expect(msg.content).toBe(PAGE.trim());
  });

  it("truncates long pages", async () => {
    mockFetch(page("x".repeat(100)));
    const out = await new SpicrawlScrapeTool({ maxChars: 10 }).invoke({
      url: "https://example.com",
    });
    expect(out.startsWith(`${"x".repeat(10)}\n\n[truncated`)).toBe(true);
    expect(out).toContain("10 of 100");
  });

  it("suggests js_render when the page is empty", async () => {
    mockFetch(page("  \n"));
    const out = await new SpicrawlScrapeTool().invoke({
      url: "https://example.com",
    });
    expect(out).toContain("js_render=true");
  });

  it("throws a SpicrawlError the agent can read", async () => {
    mockFetch(
      problem("ERR::UPSTREAM::CHALLENGE", 502, { detail: "Bot challenge." }),
    );
    const err = await new SpicrawlScrapeTool()
      .invoke({ url: "https://example.com" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SpicrawlError);
    expect(err.message).toBe("ERR::UPSTREAM::CHALLENGE: Bot challenge.");
  });

  it("requires an API key", () => {
    vi.stubEnv("SPICRAWL_API_KEY", "");
    expect(() => new SpicrawlScrapeTool()).toThrow("SPICRAWL_API_KEY");
  });

  it("keeps the key out of serialization and printing", () => {
    const tool = new SpicrawlScrapeTool({ apiKey: "spicrawl_test_secret" });
    expect(JSON.stringify(tool)).not.toContain("spicrawl_test_secret");
    expect(tool.lc_secrets).toEqual({ apiKey: "SPICRAWL_API_KEY" });
  });
});
