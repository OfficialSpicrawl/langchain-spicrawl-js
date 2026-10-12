import { StructuredTool, type ToolParams } from "@langchain/core/tools";
import { z } from "zod";
import {
  SpicrawlClient,
  type ScrapeOptions,
  type ScrapeResult,
  type SpicrawlClientParams,
} from "./client.js";

const schema = z.object({
  url: z.string().describe("Absolute http(s) URL of the page to read."),
  js_render: z
    .boolean()
    .optional()
    .describe(
      "Set true only when a first attempt returned an empty page or a placeholder because the content is built by JavaScript. Costs 3 credits instead of 1.",
    ),
});

export interface SpicrawlScrapeToolParams
  extends ToolParams, SpicrawlClientParams {
  /**
   * Extra `POST /v1/scrape` fields for every call, e.g. `{ wait_for: ".content" }`.
   * `response_format` is always `markdown`.
   */
  scrapeOptions?: ScrapeOptions;
  /** The page is cut to this many characters before it reaches the model. Defaults to 30000. */
  maxChars?: number;
}

/**
 * Tool that reads a web page as markdown with the Spicrawl API.
 *
 * Setup: `npm install @spicrawl/langchain @langchain/core` and set `SPICRAWL_API_KEY`.
 *
 * ```typescript
 * import { SpicrawlScrapeTool } from "@spicrawl/langchain";
 *
 * const tool = new SpicrawlScrapeTool({ maxChars: 20_000 });
 * await tool.invoke({ url: "https://example.com" });
 * ```
 *
 * A failure (a blocked page, an exhausted credit allowance, a bad key) throws a
 * {@link SpicrawlError}; `createAgent` hands that message back to the model.
 */
export class SpicrawlScrapeTool extends StructuredTool<typeof schema> {
  static lc_name(): string {
    return "SpicrawlScrapeTool";
  }

  name = "spicrawl_scrape";

  description =
    "Read a web page and return its main content as markdown. Use it to open a URL you already have. Input is the page URL. Set js_render only if the first result is empty because the page is built by JavaScript.";

  schema = schema;

  get lc_secrets(): { [key: string]: string } {
    return { apiKey: "SPICRAWL_API_KEY" };
  }

  readonly scrapeOptions: ScrapeOptions;
  readonly maxChars: number;
  readonly #client: SpicrawlClient;

  constructor(params: SpicrawlScrapeToolParams = {}) {
    super(params);
    this.scrapeOptions = { ...params.scrapeOptions };
    this.maxChars = params.maxChars ?? 30_000;
    this.#client = new SpicrawlClient(params);
  }

  protected async _call(input: z.infer<typeof schema>): Promise<string> {
    const options = input.js_render
      ? { ...this.scrapeOptions, js_render: true }
      : this.scrapeOptions;
    return this.#format(await this.#client.scrape(input.url, options));
  }

  #format(result: ScrapeResult): string {
    const text = result.content.trim();
    if (!text) {
      return `${result.url} returned no readable content. If the page is built by JavaScript, call again with js_render=true.`;
    }
    if (text.length > this.maxChars) {
      return `${text.slice(0, this.maxChars)}\n\n[truncated: showing ${this.maxChars} of ${text.length} characters]`;
    }
    return text;
  }
}
