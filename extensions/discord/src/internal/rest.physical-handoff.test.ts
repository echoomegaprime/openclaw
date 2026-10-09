import { fetch as undiciFetch, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordError, RateLimitError, RequestClient } from "./rest.js";

// These tests exercise the real REST/scheduler boundary. Endpoint preparation
// has its own suite; do not initialize unrelated gateway/SQLite owners here.
vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({
  captureChannelReadAuthority: () => undefined,
}));
vi.mock("../endpoint-runtime.js", () => ({ getDiscordEndpointRuntime: () => undefined }));

const path = "/guilds/1476211213699514509";
const data = () => ({ body: { explicit_content_filter: 2 } });

function permit() {
  let current = true;
  let consumed = false;
  return {
    revoke: () => {
      current = false;
    },
    get consumed() {
      return consumed;
    },
    assertCurrent: () => {
      if (!current) {
        throw new Error("authority_revoked");
      }
    },
    consumePhysicalHandoff: () => {
      if (!current) {
        throw new Error("authority_revoked");
      }
      if (consumed) {
        throw new Error("physical_attempt_already_consumed");
      }
      consumed = true;
    },
  };
}

describe("Discord fixed media-filter physical handoff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("makes one PATCH on a 429 even when the normal scheduler would requeue", async () => {
    vi.useFakeTimers();
    const physicalHandoff = permit();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      calls.push(init.method ?? "GET");
      return calls.length === 1
        ? Response.json({ retry_after: 0.01 }, { status: 429 })
        : Response.json({ explicit_content_filter: 2 });
    });
    const client = new RequestClient("synthetic-token");
    const result = client
      .patch(path, data(), undefined, { physicalHandoff })
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(RateLimitError);
    expect(calls).toEqual(["PATCH"]);
    expect(physicalHandoff.consumed).toBe(true);
    expect(client.queueSize).toBe(0);
    expect(client.getSchedulerMetrics().invalidRequestCountByStatus).toEqual({ 429: 1 });
  });

  it("does not let the actual HTTP library replay a fixed PATCH after 421", async () => {
    const previousDispatcher = getGlobalDispatcher();
    const dispatcher = new MockAgent();
    dispatcher.disableNetConnect();
    let physicalRequests = 0;
    dispatcher
      .get("https://discord.com")
      .intercept({ path: `/api/v10${path}`, method: "PATCH" })
      .reply(() => ({
        statusCode: ++physicalRequests === 1 ? 421 : 200,
        data: '{"explicit_content_filter":2}',
      }))
      .persist();
    setGlobalDispatcher(dispatcher);
    vi.stubGlobal("fetch", undiciFetch);
    try {
      const client = new RequestClient("synthetic-token");
      const result = await client
        .patch(path, data(), undefined, { physicalHandoff: permit() })
        .catch((error: unknown) => error);
      expect(physicalRequests).toBe(1);
      expect(result).toBeInstanceOf(DiscordError);
    } finally {
      setGlobalDispatcher(previousDispatcher);
      await dispatcher.close();
    }
  });

  it("consumes immediately before fetch and leaves independent GETs available", async () => {
    const physicalHandoff = permit();
    const calls: Array<{ method?: string; consumed: boolean; redirect?: string; body: unknown }> =
      [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      calls.push({
        method: init.method,
        consumed: physicalHandoff.consumed,
        redirect: init.redirect,
        body: init.body ? await new Response(init.body).text() : undefined,
      });
      return Response.json({ explicit_content_filter: 2 });
    });
    const client = new RequestClient("synthetic-token");
    await client.get(path);
    await client.patch(path, data(), undefined, { physicalHandoff });
    await client.get(path);
    await expect(client.patch(path, data(), undefined, { physicalHandoff })).rejects.toThrow(
      "physical_attempt_already_consumed",
    );
    expect(calls).toEqual([
      { method: "GET", consumed: false, redirect: undefined, body: undefined },
      { method: "PATCH", consumed: true, redirect: "error", body: '{"explicit_content_filter":2}' },
      { method: "GET", consumed: true, redirect: undefined, body: undefined },
    ]);
  });

  it.each([
    ["wrong path", "/channels/1", data(), undefined],
    ["wrong value", path, { body: { explicit_content_filter: 0 } }, undefined],
    ["extra field", path, { body: { explicit_content_filter: 2, name: "changed" } }, undefined],
    ["raw body", path, { body: '{"explicit_content_filter":2}', rawBody: true }, undefined],
    ["headers", path, { ...data(), headers: { Authorization: "changed" } }, undefined],
    ["query", path, data(), { extra: "value" }],
  ] as const)("rejects %s before any fetch", async (_label, target, body, query) => {
    const fetcher = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    const physicalHandoff = permit();
    const client = new RequestClient("synthetic-token");
    await expect(client.patch(target, body, query, { physicalHandoff })).rejects.toThrow(
      "invalid_physical_handoff_request",
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(physicalHandoff.consumed).toBe(false);
  });

  it("refuses unsupported injected fetch without selecting a different transport", async () => {
    const customFetch = vi.fn(async () => Response.json({}));
    const directFetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", directFetch);
    const physicalHandoff = permit();
    const client = new RequestClient("synthetic-token", { fetch: customFetch });
    await expect(client.patch(path, data(), undefined, { physicalHandoff })).rejects.toThrow(
      "unsupported_transport",
    );
    expect(customFetch).not.toHaveBeenCalled();
    expect(directFetch).not.toHaveBeenCalled();
    expect(physicalHandoff.consumed).toBe(false);
  });

  it("rechecks authority after waiting in the scheduler", async () => {
    const first = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<void>();
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      entered.resolve();
      return first.promise;
    });
    const client = new RequestClient("synthetic-token", { scheduler: { maxConcurrency: 1 } });
    const get = client.get("/users/@me");
    await entered.promise;
    const physicalHandoff = permit();
    const write = client
      .patch(path, data(), undefined, { physicalHandoff })
      .catch((e: unknown) => e);
    physicalHandoff.revoke();
    first.resolve(Response.json({ id: "1" }));
    await get;
    expect(await write).toEqual(new Error("authority_revoked"));
    expect(calls).toBe(1);
    expect(physicalHandoff.consumed).toBe(false);
  });

  it("snapshots the fixed body before waiting in the scheduler", async () => {
    const first = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<void>();
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      bodies.push(init.body ? await new Response(init.body).text() : undefined);
      entered.resolve();
      return bodies.length === 1 ? first.promise : Response.json({ explicit_content_filter: 2 });
    });
    const client = new RequestClient("synthetic-token", { scheduler: { maxConcurrency: 1 } });
    const get = client.get("/users/@me");
    await entered.promise;
    const original = data();
    const write = client.patch(path, original, undefined, { physicalHandoff: permit() });
    original.body.explicit_content_filter = 0;
    first.resolve(Response.json({ id: "1" }));
    await get;
    await write;
    expect(bodies).toEqual([undefined, '{"explicit_content_filter":2}']);
  });

  it("retains normal PATCH rate-limit retries", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", async () =>
      ++calls === 1
        ? Response.json({ retry_after: 0.01 }, { status: 429 })
        : Response.json({ name: "updated" }),
    );
    const client = new RequestClient("synthetic-token");
    const result = client.patch(path, { body: { name: "updated" } });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ name: "updated" });
    expect(calls).toBe(2);
  });

  it("refuses a forced second executor even if the host callback is accidentally repeatable", async () => {
    class DuplicateExecutorClient extends RequestClient {
      protected override async executeRequest(
        ...args: Parameters<RequestClient["executeRequest"]>
      ) {
        await super.executeRequest(...args);
        return await super.executeRequest(...args);
      }
    }
    let handoffs = 0;
    const fetcher = vi.fn(async () => Response.json({ explicit_content_filter: 2 }));
    vi.stubGlobal("fetch", fetcher);
    const client = new DuplicateExecutorClient("synthetic-token");
    await expect(
      client.patch(path, data(), undefined, {
        physicalHandoff: {
          assertCurrent: () => {},
          consumePhysicalHandoff: () => {
            handoffs++;
          },
        },
      }),
    ).rejects.toThrow("physical_attempt_already_consumed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(handoffs).toBe(1);
  });

  it("does not hand off an already aborted direct request", async () => {
    const signal = AbortSignal.abort();
    const physicalHandoff = permit();
    const fetcher = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetcher);
    const client = new RequestClient("synthetic-token", { signal });
    await expect(client.patch(path, data(), undefined, { physicalHandoff })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(physicalHandoff.consumed).toBe(false);
  });

  it.each([path, "/guilds/222"])(
    "passes actual fixed request bytes to the host binding for %s",
    async (target) => {
      const received: unknown[] = [];
      const expected = { method: "PATCH", path, body: '{"explicit_content_filter":2}' };
      const fetcher = vi.fn(async () => Response.json({ explicit_content_filter: 2 }));
      vi.stubGlobal("fetch", fetcher);
      const client = new RequestClient("synthetic-token");
      const result = await client
        .patch(target, data(), undefined, {
          physicalHandoff: {
            assertCurrent: () => {},
            consumePhysicalHandoff: (
              request?: Readonly<{ method: string; path: string; body: string }>,
            ) => {
              received.push(request);
              if (
                !request ||
                request.method !== expected.method ||
                request.path !== expected.path ||
                request.body !== expected.body
              ) {
                throw new Error("physical_handoff_binding_mismatch");
              }
            },
          },
        })
        .catch((error: unknown) => error);
      expect(received).toEqual([{ ...expected, path: target }]);
      if (target === path) {
        expect(result).toEqual({ explicit_content_filter: 2 });
        expect(fetcher).toHaveBeenCalledTimes(1);
      } else {
        expect(result).toEqual(new Error("physical_handoff_binding_mismatch"));
        expect(fetcher).not.toHaveBeenCalled();
      }
    },
  );
});
