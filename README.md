# @spicrawl/langchain: load web pages into LangChain.js as Markdown

**How do I load web pages into LangChain as Markdown?** Use `SpicrawlLoader` from
`@spicrawl/langchain`. Give it one URL or an array and call `load()`: you get LangChain `Document`s
whose `pageContent` is each page as Markdown, with the final URL, the site's HTTP status and the
credits charged in `metadata`, ready for a text splitter and a vector store. The package also has
`SpicrawlScrapeTool`, a LangChain tool that lets an agent open a URL and read it. Both call the
[Spicrawl](https://docs.spicrawl.com) web scraping API with your API key, and `js_render` renders
pages that need JavaScript first. It ships TypeScript types and needs Node.js 20 or later and
`@langchain/core` 1.x.

[LangChain.js](https://docs.langchain.com/oss/javascript/langchain/overview) integration for
[Spicrawl](https://docs.spicrawl.com), a web scraping API that returns a URL as clean markdown,
optionally rendering JavaScript first. It is the TypeScript twin of the Python package
[`langchain-spicrawl`](https://github.com/OfficialSpicrawl/langchain-spicrawl).

| Component | Class | Use it to |
|---|---|---|
| Document loader | `SpicrawlLoader` | Turn URLs into `Document`s (markdown content plus metadata) for RAG and indexing |
| Tool | `SpicrawlScrapeTool` | Let an agent open a URL and read it |

## Installation

The package is not on npm yet, so install it from this repository. The repo has no `prepare` script
and `dist/` is not committed, so `npm install github:OfficialSpicrawl/langchain-spicrawl-js` would
install it unbuilt. Clone, build (the build needs Node.js 22), pack, then install the tarball:

```bash
git clone https://github.com/OfficialSpicrawl/langchain-spicrawl-js.git
cd langchain-spicrawl-js
npm ci && npm run build && npm pack

cd /path/to/your/project
npm install /path/to/langchain-spicrawl-js/spicrawl-langchain-<version>.tgz @langchain/core
```

Install the tarball, not the folder: a folder install symlinks the clone, whose own `node_modules`
carries a second copy of `@langchain/core`, and two copies break LangChain's `instanceof` checks.

The package itself runs on Node.js 20 or later. Create an API key in the
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

## Use cases

- **RAG over web content.** Load an array of URLs with `SpicrawlLoader`, split the documents and put
  them in any vector store (see [Index pages for RAG](#index-pages-for-rag)). Spicrawl fetches only
  the URLs you list; it does not crawl a site, split text or embed it, so the URL list (from a
  sitemap, for example) and the vector store are yours.
- **Agents that read the web.** Give a LangChain.js agent `SpicrawlScrapeTool` and it can open a URL
  the user mentions, or one it found, and read the page as Markdown (see [Agent tool](#agent-tool)).
- **Pages built by JavaScript.** Set `scrapeOptions: { js_render: true }` and, if needed, `wait_for`
  for a selector to wait for.
- **Large URL lists.** `lazyLoad()` yields one document at a time, so a long list can be indexed as
  it loads.

## FAQ

### How do I load a web page into LangChain.js as Markdown?

```typescript
import { SpicrawlLoader } from "@spicrawl/langchain";

const docs = await new SpicrawlLoader("https://example.com").load();
console.log(docs[0].pageContent); // the page as Markdown
```

Set `SPICRAWL_API_KEY` first. Each `Document` carries `source`, `final_url`, `target_status`,
`credits_charged` and more in `metadata`; see [Metadata](#metadata).

### How do I build a RAG pipeline over a website with LangChain.js?

Collect the URLs, load them with `SpicrawlLoader`, split the documents with a LangChain text
splitter and add the chunks to a vector store. A complete example is under
[Index pages for RAG](#index-pages-for-rag).

### Can it load pages that need JavaScript?

Yes. Pass `scrapeOptions: { js_render: true }` to the loader. A plain fetch costs 1 credit and
JavaScript rendering costs 3. The agent tool lets the model set `js_render` itself when the first
attempt comes back empty.

### Does it crawl a whole website?

No. It fetches the URLs you pass. To cover a site, collect its URLs first and load them as an array.

### How do I give a LangChain.js agent access to web pages?

Pass `new SpicrawlScrapeTool()` in the agent's `tools`, as in [Agent tool](#agent-tool). To give an
agent all 24 `spicrawl_*` tools (batch jobs, sessions, usage and more), connect it to the hosted
Spicrawl MCP server instead; see [Agent frameworks](https://docs.spicrawl.com/agents/frameworks).

### What happens when a page is blocked or the site returns an error?

A site that answers 4xx or 5xx throws a `SpicrawlError` with `code === "TARGET_STATUS"`. Pass
`continueOnFailure: true` to log a warning and skip that URL. `createAgent` hands a tool error back
to the model instead of crashing the run. Failed requests cost 0 credits.

### Do I need an API key, and what does it cost?

Yes: create a key in the [Spicrawl dashboard](https://app.spicrawl.com/dashboard/keys). Credits are
charged only for successful requests; see [Credits](https://docs.spicrawl.com/credits).

### Is there a Python version?

Yes: [`langchain-spicrawl`](https://github.com/OfficialSpicrawl/langchain-spicrawl), with the same
classes and the same metadata keys.

### What license is it under?

MIT.

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
