import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { discordMessageActions } from "./channel-actions.js";
import { DiscordConfigSchema } from "./config-schema.js";
import { resolveGuildMediaFilterWriteBinding } from "./guild-media-filter-policy.js";

const binding = {
  accountId: "default",
  botId: "222222222222222222",
  guildIds: ["111111111111111111"],
};
function config(enabled?: boolean): OpenClawConfig {
  return {
    channels: {
      discord: {
        token: "synthetic-token",
        actions: { guildMediaFilter: true },
        guildMediaFilter: { ...binding, allowSetAllMembers: enabled },
        accounts: { austin: { token: "other-synthetic-token" } },
      },
    },
  };
}

describe("Discord fixed media-filter opt-in", () => {
  it("requests trusted inbound identity while leaving the operator route capability-owned", () => {
    const action = "guild-media-filter-set-all-members";
    expect(
      discordMessageActions.requiresTrustedRequesterSender?.({
        action,
        toolContext: { currentChannelProvider: "discord" },
      }),
    ).toBe(true);
    expect(discordMessageActions.requiresTrustedRequesterSender?.({ action })).toBe(false);
  });
  it.each([undefined, false, true])("admits writes only when explicit true (%s)", (enabled) => {
    expect(Boolean(resolveGuildMediaFilterWriteBinding(config(enabled), "default"))).toBe(
      enabled === true,
    );
    expect(resolveGuildMediaFilterWriteBinding(config(enabled), "austin")).toBeUndefined();
  });

  it("keeps the root action gate required", () => {
    const cfg = config(true);
    cfg.channels!.discord!.actions!.guildMediaFilter = false;
    expect(resolveGuildMediaFilterWriteBinding(cfg, "default")).toBeUndefined();
  });

  it.each([undefined, false, true])(
    "discovers receipt-capable action under read binding (%s)",
    (enabled) => {
      const cfg = config(enabled);
      expect(
        discordMessageActions.describeMessageTool!({ cfg, accountId: "default" })?.actions,
      ).toContain("guild-media-filter-set-all-members");
      expect(
        discordMessageActions.describeMessageTool!({ cfg, accountId: "austin" })?.actions,
      ).not.toContain("guild-media-filter-set-all-members");
    },
  );

  it("accepts only boolean opt-in and continues rejecting arbitrary REST fields", () => {
    expect(DiscordConfigSchema.safeParse(config(true).channels!.discord).success).toBe(true);
    for (const extra of [
      { allowSetAllMembers: "true" },
      { body: { explicit_content_filter: 0 } },
      { endpoint: "/guilds/other" },
    ]) {
      expect(
        DiscordConfigSchema.safeParse({
          ...config().channels!.discord,
          guildMediaFilter: { ...binding, ...extra },
        }).success,
      ).toBe(false);
    }
  });
});
