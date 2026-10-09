import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestClient } from "./internal/rest.js";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", async (original) => ({
  ...(await original<typeof import("node:dns/promises")>()),
  lookup: dns.lookup,
}));

function installPhysicalFetch(fetcher: typeof fetch) {
  // A vi.fn global fetch deliberately bypasses DNS in fetch-guard. Use the
  // existing Undici test seam at the physical leaf so DNS stays in the path.
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", { ...undici, fetch: fetcher });
  vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => fetcher(...args));
}

describe("Discord endpoint physical handoff", () => {
  beforeEach(() => {
    vi.stubEnv("DISCORD_API_URL", "https://discord.example/api/v10");
    dns.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    dns.lookup.mockReset();
  });

  it("consumes at the real guarded fetch leaf after asynchronous DNS preparation", async () => {
    const entered = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<Array<{ address: string; family: number }>>();
    dns.lookup.mockImplementation(() => {
      entered.resolve();
      return lookup.promise;
    });
    let consumed = false;
    const fetcher = vi.fn(async () => {
      expect(consumed).toBe(true);
      return Response.json({ explicit_content_filter: 2 });
    });
    installPhysicalFetch(fetcher);
    const client = new RequestClient("synthetic-token");
    const result = client.patch(
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
    );
    await Promise.race([entered.promise, result]);
    expect(consumed).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    lookup.resolve([{ address: "93.184.216.34", family: 4 }]);
    await expect(result).resolves.toEqual({ explicit_content_filter: 2 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("denies revoked authority after DNS without consuming or fetching", async () => {
    const entered = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<Array<{ address: string; family: number }>>();
    dns.lookup.mockImplementation(() => {
      entered.resolve();
      return lookup.promise;
    });
    let current = true;
    let consumed = false;
    const fetcher = vi.fn(async () => Response.json({ explicit_content_filter: 2 }));
    installPhysicalFetch(fetcher);
    const client = new RequestClient("synthetic-token");
    const result = client
      .patch(
        "/guilds/1476211213699514509",
        {
          body: { explicit_content_filter: 2 },
        },
        undefined,
        {
          physicalHandoff: {
            assertCurrent: () => {
              if (!current) {
                throw new Error("authority_revoked");
              }
            },
            consumePhysicalHandoff: () => {
              consumed = true;
            },
          },
        },
      )
      .catch((error: unknown) => error);
    await Promise.race([entered.promise, result]);
    current = false;
    lookup.resolve([{ address: "93.184.216.34", family: 4 }]);
    expect(await result).toEqual(new Error("authority_revoked"));
    expect(fetcher).not.toHaveBeenCalled();
    expect(consumed).toBe(false);
  });

  it.each([307, 308])("refuses %s without a second physical PATCH", async (status) => {
    let handoffs = 0;
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status,
          headers: { Location: "https://discord.example/api/v10/guilds/1476211213699514509" },
        }),
    );
    installPhysicalFetch(fetcher);
    const client = new RequestClient("synthetic-token");
    await expect(
      client.patch(
        "/guilds/1476211213699514509",
        {
          body: { explicit_content_filter: 2 },
        },
        undefined,
        {
          physicalHandoff: {
            assertCurrent: () => {},
            consumePhysicalHandoff: () => {
              handoffs++;
            },
          },
        },
      ),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(handoffs).toBe(1);
  });
});
