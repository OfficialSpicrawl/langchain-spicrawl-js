# @spicrawl/langchain

[![smithery badge](https://smithery.ai/badge/spicrawl/web-scraper)](https://smithery.ai/servers/spicrawl/web-scraper)

Also available as an MCP server: [Smithery](https://smithery.ai/servers/spicrawl/web-scraper) · [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.OfficialSpicrawl/mcp)

[LangChain.js](https://docs.langchain.com/oss/javascript/langchain/overview) integration for
[Spicrawl](https://docs.spicrawl.com), a web scraping API that returns any URL as clean markdown,
optionally rendering JavaScript first. It is the TypeScript twin of the Python package
[`langchain-spicrawl`](https://pypi.org/project/langchain-spicrawl/).

| Component | Class | Use it to |
|---|---|---|
| Document loader | `SpicrawlLoader` | Turn URLs into `Document`s (markdown content plus metadata) for RAG and indexing |
| Tool | `SpicrawlScrapeTool` | Let an agent open a URL and read it |

## Installation

```bash
npm install @spicrawl/langchain @langchain/core
```

Requires Node.js 20 or later. Create an API key in the
[Spicrawl dashboard](https://app.spicrawl.com/dashboard/keys) and export it. Keys start with
`spicrawl_live_` (spends credits) or `spicrawl_test_`.

```bash
export SPICRAWL_API_KEY="spicrawl_live_..."
```

## Document loader

```typescript
import { SpicrawlLoader } from "@spicrawl/langchain";

const loader = new SpicrawlLoader(["https://example.com", "https://example.org"]);
const docs = await loader.load();

console.log(docs[0].pageContent);
// 'Example Domain\n\nThis domain is for use in documentation examples without needing permission. ...'
console.log(docs[0].metadata);
// {
//   source: 'https://example.com', final_url: 'https://example.com/', target_status: 200,
//   credits_charged: 1, engine: 'fetch', cache_state: 'hit', request_id: '01M4QYNXGPFF9VRGS64F0JE092'
// }
```

`lazyLoad()` yields documents one by one. A page that needs JavaScript, or any other
`POST /v1/scrape` option, goes in `scrapeOptions`:

```typescript
const loader = new SpicrawlLoader("https://example.com/pricing", {
  scrapeOptions: { js_render: true, wait_for: ".plans", exclude_tags: ["nav", "footer"] },
  continueOnFailure: true, // log and skip a URL that fails instead of throwing
});

for await (const doc of loader.lazyLoad()) {
  console.log(doc.metadata.source, doc.pageContent.length);
}
```

### Index pages for RAG

```typescript
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { OpenAIEmbeddings } from "@langchain/openai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { SpicrawlLoader } from "@spicrawl/langchain";

const docs = await new SpicrawlLoader([
  "https://example.com/docs/intro",
  "https://example.com/docs/api",
]).load();
const chunks = await new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 100,
}).splitDocuments(docs);
const store = await MemoryVectorStore.fromDocuments(chunks, new OpenAIEmbeddings());
console.log(await store.similaritySearch("How do I authenticate?", 3));
```

### Loader parameters

`new SpicrawlLoader(urls, params?)`: `urls` is one URL or an array, scraped one after the other in order.

| Parameter | Default | Meaning |
|---|---|---|
| `apiKey` | `$SPICRAWL_API_KEY` | Spicrawl API key. |
| `baseUrl` | `$SPICRAWL_BASE_URL` or `https://api.spicrawl.com` | API base URL. |
| `scrapeOptions` | `{}` | Extra [`POST /v1/scrape`](https://docs.spicrawl.com/api-reference/scrape/scrape-post) fields sent with every URL. `response_format` is always `markdown`. |
| `continueOnFailure` | `false` | Skip failed URLs (logged with `console.warn`) instead of throwing. |
| `timeout` | `120000` | Milliseconds to wait for each response. |
| `maxRetries` | `2` | Retries of errors the API marks `retryable` (rate limits, timeouts). |

### Metadata

The keys match the Python package, so documents from either are interchangeable in one index.

| Key | Value |
|---|---|
| `source` | The URL you passed |
| `title` | First `#` heading in the markdown (omitted when the page has none) |
| `final_url` | URL after redirects |
| `target_status` | The site's HTTP status |
| `credits_charged` | Credits this page cost |
| `engine` | Rendering tier that served the page: `fetch`, `js` or `browser` |
| `cache_state` | `hit`, `miss` or `bypass` |
| `request_id` | Quote it to Spicrawl support, or look it up with `GET /v1/requests/{id}` |

## Agent tool

```typescript
import { createAgent } from "langchain";
import { SpicrawlScrapeTool } from "@spicrawl/langchain";

const agent = createAgent({
  model: "openai:gpt-4.1", // needs @langchain/openai and OPENAI_API_KEY
  tools: [new SpicrawlScrapeTool({ maxChars: 20_000 })],
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "Read https://example.com and summarize it." }],
});
console.log(result.messages.at(-1)?.content);
```

Call it directly:

```typescript
const tool = new SpicrawlScrapeTool();
await tool.invoke({ url: "https://example.com" });
// 'Example Domain\n\nThis domain is for use in documentation examples without needing permission. ...'
```

The model sees two arguments: `url` and `js_render` (set only when the first attempt came back empty
because the page is built by JavaScript). Everything else is fixed by you at construction:

| Parameter | Default | Meaning |
|---|---|---|
| `apiKey` | `$SPICRAWL_API_KEY` | Spicrawl API key. Never serialized or printed. |
| `baseUrl` | `$SPICRAWL_BASE_URL` or `https://api.spicrawl.com` | API base URL. |
| `scrapeOptions` | `{}` | Extra `POST /v1/scrape` fields for every call. `response_format` is always `markdown`. |
| `maxChars` | `30000` | The page is cut to this length, with a notice, before it reaches the model. |
| `timeout` | `120000` | Milliseconds to wait for each response. |
| `maxRetries` | `2` | Retries of errors the API marks `retryable`. |

A failure (a blocked page, an exhausted credit allowance, a bad key) throws a `SpicrawlError`.
`createAgent` passes that message back to the model as the tool result, so the agent can react
instead of crashing the run.

## Cost, retries and errors

- A plain fetch costs 1 credit and `js_render` costs 3. Failures cost 0. A cached result is billed at
  the price of the fetch that stored it. See [Credits](https://docs.spicrawl.com/credits).
- Only errors the API marks `retryable` are retried, after `Retry-After`. A dropped connection is never
  retried, because the scrape may already have run and been billed.
- A site that answers 4xx or 5xx (an access-denied page, a 404) throws a `SpicrawlError` with
  `code === "TARGET_STATUS"`; it is not returned as content.
- Every `SpicrawlError` carries `code` (for example `ERR::LIMIT::RATE_LIMITED`), `status`, `retryable`
  and `requestId`. All codes are listed in the [error reference](https://docs.spicrawl.com/errors).

```typescript
import { SpicrawlError, SpicrawlLoader } from "@spicrawl/langchain";

try {
  await new SpicrawlLoader("https://example.com").load();
} catch (err) {
  if (err instanceof SpicrawlError) console.error(err.code, err.status, err.requestId);
  else throw err;
}
```

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint + prettier --check
npm test            # unit tests, fetch mocked
npm run build       # ESM + CJS + types into dist/
npm run test:int    # live; needs SPICRAWL_API_KEY, spends credits
```

## License

MIT
