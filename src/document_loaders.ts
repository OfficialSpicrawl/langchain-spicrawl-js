import { Document } from "@langchain/core/documents";
import { BaseDocumentLoader } from "@langchain/core/document_loaders/base";
import {
  SpicrawlClient,
  SpicrawlError,
  type ScrapeOptions,
  type ScrapeResult,
  type SpicrawlClientParams,
} from "./client.js";

export interface SpicrawlLoaderParams extends SpicrawlClientParams {
  /**
   * Extra `POST /v1/scrape` fields sent with every URL, for example `js_render`, `wait_for`,
   * `proxy`, `include_tags`, `exclude_tags` or `main_content_only`.
   * `response_format` is always `markdown`.
   */
  scrapeOptions?: ScrapeOptions;
  /** Log and skip a URL that fails instead of throwing. */
  continueOnFailure?: boolean;
}

const TITLE = /^#[ \t]+(.+?)[ \t]*$/m;

function toDocument(result: ScrapeResult): Document {
  const metadata: Record<string, unknown> = {
    source: result.url,
    title: TITLE.exec(result.content)?.[1],
    final_url: result.finalUrl,
    target_status: result.targetStatus,
    credits_charged: result.creditsCharged,
    engine: result.engine,
    cache_state: result.cacheState,
    request_id: result.requestId,
  };
  for (const key of Object.keys(metadata)) {
    if (metadata[key] === undefined) delete metadata[key];
  }
  return new Document({ pageContent: result.content, metadata });
}

/**
 * Load web pages as markdown `Document`s with the Spicrawl API.
 *
 * Setup: `npm install @spicrawl/langchain @langchain/core` and set `SPICRAWL_API_KEY`.
 *
 * ```typescript
 * import { SpicrawlLoader } from "@spicrawl/langchain";
 *
 * const loader = new SpicrawlLoader(["https://example.com", "https://example.org"], {
 *   scrapeOptions: { js_render: true },
 * });
 * const docs = await loader.load();
 * console.log(docs[0].pageContent, docs[0].metadata);
 * ```
 *
 * Each page costs 1 credit (3 with `js_render`). Pages are fetched one after the other; for
 * thousands of URLs use the Spicrawl batch API.
 *
 * Metadata keys (the same as in the Python package): `source` (the URL you passed), `title`
 * (first `#` heading), `final_url`, `target_status` (the site's HTTP status), `credits_charged`,
 * `engine` (rendering tier), `cache_state` and `request_id`.
 */
export class SpicrawlLoader extends BaseDocumentLoader {
  readonly urls: string[];
  readonly scrapeOptions: ScrapeOptions;
  readonly continueOnFailure: boolean;
  readonly #client: SpicrawlClient;

  constructor(urls: string | string[], params: SpicrawlLoaderParams = {}) {
    super();
    this.urls = typeof urls === "string" ? [urls] : [...urls];
    this.scrapeOptions = { ...params.scrapeOptions };
    this.continueOnFailure = params.continueOnFailure ?? false;
    this.#client = new SpicrawlClient(params);
  }

  /** Scrape each URL in order and yield one `Document` per page. */
  async *lazyLoad(): AsyncGenerator<Document> {
    for (const url of this.urls) {
      let doc: Document;
      try {
        doc = toDocument(await this.#client.scrape(url, this.scrapeOptions));
      } catch (err) {
        if (!this.continueOnFailure || !(err instanceof SpicrawlError))
          throw err;
        console.warn(`Skipping ${url}: ${err.message}`);
        continue;
      }
      yield doc;
    }
  }

  async load(): Promise<Document[]> {
    const docs: Document[] = [];
    for await (const doc of this.lazyLoad()) docs.push(doc);
    return docs;
  }
}
