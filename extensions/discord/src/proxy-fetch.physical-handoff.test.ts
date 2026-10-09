import * as undici from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimitError, RequestClient } from "./internal/rest.js";
import { resolveDiscordProxyFetchForAccount } from "./proxy-fetch.js";

describe("Discord selected proxy physical handoff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("keeps the selected proxy dispatcher and hands off one fixed PATCH on a 429", async () => {
    vi.useFakeTimers();
    let consumed = false;
    let calls = 0;
    let dispatcher: undici.Dispatcher | undefined;
    const physicalFetch = vi.fn(
      async (_url: unknown, init: RequestInit & { dispatcher: undici.Dispatcher }) => {
        dispatcher = init.dispatcher;
        calls++;
        expect(consumed).toBe(true);
        expect(init.method).toBe("PATCH");
        expect(init.redirect).toBe("error");
        expect(await new Response(init.body).text()).toBe('{"explicit_content_filter":2}');
        return calls === 1
          ? Response.json({ retry_after: 0.01 }, { status: 429 })
          : Response.json({});
      },
    );
    vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: physicalFetch });
    const proxyFetch = resolveDiscordProxyFetchForAccount(
      { config: { proxy: "http://127.0.0.1:43210" } },
      {},
    );
    const directFetch = vi.fn();
    vi.stubGlobal("fetch", directFetch);
    const client = new RequestClient("synthetic-token", { fetch: proxyFetch });
    const result = client
      .patch(
        "/guilds/1476211213699514509",
        {
          body: { explicit_content_filter: 2 },
        },
        undefined,
        {
          physicalHandoff: {
            assertCurrent: () => {},
            consumePhysicalHandoff: () => {
              consumed = true;
            },
          },
        },
      )
      .catch((error: unknown) => error);
    try {
      await vi.runAllTimersAsync();
      expect(await result).toBeInstanceOf(RateLimitError);
      expect(calls).toBe(1);
      expect(dispatcher).toBeInstanceOf(undici.ProxyAgent);
      expect(directFetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await dispatcher?.close();
    }
  });
});
