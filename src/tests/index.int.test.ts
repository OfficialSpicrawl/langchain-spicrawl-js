// Live tests: they spend credits. Run with `npm run test:int` and SPICRAWL_API_KEY set.
import { describe, expect, it } from "vitest";
import { SpicrawlLoader, SpicrawlScrapeTool } from "../index.js";

describe.skipIf(!process.env.SPICRAWL_API_KEY)("live", () => {
  it("loads example.com", async () => {
    const docs = await new SpicrawlLoader("https://example.com").load();
    expect(docs).toHaveLength(1);
    expect(docs[0].pageContent).toContain("Example Domain");
    expect(docs[0].metadata.target_status).toBe(200);
  });

  it("reads example.com with the tool", async () => {
    const out = await new SpicrawlScrapeTool().invoke({
      url: "https://example.com",
    });
    expect(out).toContain("Example Domain");
  });
});
