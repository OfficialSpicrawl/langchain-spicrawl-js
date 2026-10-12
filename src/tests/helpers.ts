import { vi } from "vitest";

export const PAGE =
  "# Example Domain\n\nThis domain is for use in illustrative examples.\n";

export const HEADERS: Record<string, string> = {
  "content-type": "text/markdown; charset=utf-8",
  "x-request-id": "01M0HF5WFWE7PRE8KZHDTNETWN",
  "x-target-status": "200",
  "x-final-url": "https://example.com/",
  "x-credits-charged": "1",
  "x-engine": "fetch",
  "cache-state": "miss",
};

export function page(
  text = PAGE,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, {
    status: 200,
    headers: { ...HEADERS, ...headers },
  });
}

export function problem(
  code: string,
  status: number,
  extra: { retryable?: boolean; [key: string]: unknown } = {},
): Response {
  const { retryable = false, ...rest } = extra;
  return new Response(
    JSON.stringify({ code, status, retryable, detail: "It broke.", ...rest }),
    { status, headers: { "content-type": "application/problem+json" } },
  );
}

/** Replace the global fetch. Nothing in the unit tests may reach the network. */
export function mockFetch(
  ...answers: Array<
    Response | Error | ((req: { url: string; init: RequestInit }) => Response)
  >
) {
  let i = 0;
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const answer = answers[Math.min(i, answers.length - 1)];
      i += 1;
      if (answer instanceof Error) throw answer;
      if (typeof answer === "function")
        return answer({ url: String(input), init: init ?? {} });
      return answer.clone();
    });
}

export function sentBody(
  spy: ReturnType<typeof mockFetch>,
  call = -1,
): Record<string, unknown> {
  const calls = spy.mock.calls;
  const init = calls.at(call)?.[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}
