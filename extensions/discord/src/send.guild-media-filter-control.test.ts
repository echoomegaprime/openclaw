import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordError, RequestClient } from "./internal/rest.js";
import { setGuildMediaFilterAllMembersDiscord } from "./send.guild.js";

const cfg: OpenClawConfig = { channels: { discord: { token: "synthetic-token" } } };
const guildId = "111111111111111111";
const handoff = { assertCurrent: () => {}, consumePhysicalHandoff: () => {} };
const rest = new RequestClient("synthetic-token");
const opts = { cfg, accountId: "default", rest };

afterEach(() => vi.restoreAllMocks());

describe("Discord fixed media-filter helper", () => {
  it("uses only the fixed endpoint/body and exact host physical capability", async () => {
    const patch = vi.spyOn(rest, "patch").mockResolvedValue({ explicit_content_filter: 2 });
    await expect(setGuildMediaFilterAllMembersDiscord(guildId, opts, handoff)).resolves.toBe(
      "acknowledged",
    );
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      `/guilds/${guildId}`,
      { body: { explicit_content_filter: 2 } },
      undefined,
      { physicalHandoff: handoff },
    );
  });

  it.each([400, 401, 403, 404, 405, 429])(
    "classifies explicit provider rejection %i without replay",
    async (status) => {
      const patch = vi
        .spyOn(rest, "patch")
        .mockRejectedValue(new DiscordError(new Response(null, { status }), {}));
      await expect(setGuildMediaFilterAllMembersDiscord(guildId, opts, handoff)).resolves.toBe(
        "rejected",
      );
      expect(patch).toHaveBeenCalledOnce();
    },
  );

  it.each([408, 421, 500, 502])(
    "leaves ambiguous status %i for core reconciliation",
    async (status) => {
      const error = new DiscordError(new Response(null, { status }), {});
      const patch = vi.spyOn(rest, "patch").mockRejectedValue(error);
      await expect(setGuildMediaFilterAllMembersDiscord(guildId, opts, handoff)).rejects.toBe(
        error,
      );
      expect(patch).toHaveBeenCalledOnce();
    },
  );

  it("preserves an unknown transport failure without retry", async () => {
    const error = new Error("synthetic transport failure");
    const patch = vi.spyOn(rest, "patch").mockRejectedValue(error);
    await expect(setGuildMediaFilterAllMembersDiscord(guildId, opts, handoff)).rejects.toBe(error);
    expect(patch).toHaveBeenCalledOnce();
  });
});
