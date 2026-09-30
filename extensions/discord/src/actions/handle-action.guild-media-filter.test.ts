import { PermissionFlagsBits, Routes } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { discordMessageActions } from "../channel-actions.js";
import { DiscordConfigSchema } from "../config-schema.js";
import * as discordRequestClient from "../proxy-request-client.js";
import { createDiscordLoopbackRest } from "../send.test-harness.js";
import { handleDiscordMessageAction } from "./handle-action.js";

const guildId = "111111111111111111";
const botId = "222222222222222222";
const senderId = "333333333333333333";
let cfg: OpenClawConfig;
let filter: unknown;
let returnedBotId: string;
let returnedGuildId: string;
let botPermissions: bigint;
let senderPermissions: bigint;
let currentAuthority: boolean;
let expireAfterIdentity: boolean;
let requests: Awaited<ReturnType<typeof createDiscordLoopbackRest>>["requests"] = [];
let closeLoopback = async () => {};

function readFilter(overrides: Partial<Parameters<typeof handleDiscordMessageAction>[0]> = {}) {
  return handleDiscordMessageAction({
    action: "guild-media-filter-get",
    params: { accountId: "default", guildId, expectedBotId: botId },
    cfg,
    accountId: "default",
    senderIsOwner: true,
    conversationReadOrigin: "direct-operator",
    assertDirectAdapterHandoff: () => {
      if (!currentAuthority) {
        throw new Error("expired request authority");
      }
    },
    ...overrides,
  });
}

beforeAll(async () => {
  const loopback = await createDiscordLoopbackRest({
    queueRequests: true,
    respond: (request) => {
      if (request.path?.endsWith(Routes.user("@me"))) {
        if (expireAfterIdentity) {
          currentAuthority = false;
        }
        return { id: returnedBotId, bot: true };
      }
      if (request.path?.endsWith(Routes.guild(guildId))) {
        return {
          id: returnedGuildId,
          explicit_content_filter: filter,
          owner_id: "444444444444444444",
          name: "not part of the result",
          roles: [
            { id: guildId, permissions: "0" },
            { id: "bot-role", permissions: botPermissions.toString() },
            { id: "sender-role", permissions: senderPermissions.toString() },
          ],
        };
      }
      if (request.path?.endsWith(Routes.guildMember(guildId, botId))) {
        return { user: { id: botId }, roles: ["bot-role"] };
      }
      if (request.path?.endsWith(Routes.guildMember(guildId, senderId))) {
        return { user: { id: senderId }, roles: ["sender-role"] };
      }
      throw new Error(`Unexpected test request: ${request.method} ${request.path}`);
    },
  });
  requests = loopback.requests;
  closeLoopback = loopback.close;
  vi.spyOn(discordRequestClient, "createDiscordRequestClient").mockReturnValue(loopback.rest);
});

beforeEach(() => {
  cfg = {
    channels: {
      discord: {
        token: "test-token",
        groupPolicy: "open",
        actions: { guildMediaFilter: true },
        guildMediaFilter: { accountId: "default", botId, guildIds: [guildId] },
        accounts: { austin: { token: "other-test-token" } },
      },
    },
  };
  filter = 2;
  returnedBotId = botId;
  returnedGuildId = guildId;
  botPermissions = PermissionFlagsBits.ManageGuild;
  senderPermissions = PermissionFlagsBits.ManageGuild;
  currentAuthority = true;
  expireAfterIdentity = false;
  requests.length = 0;
});

afterEach(() => {
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect(requests.every((request) => request.body === "")).toBe(true);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await closeLoopback();
});

describe("registered Discord guild media-filter read", () => {
  it.each([0, 1, 2])(
    "returns the measured enum %i with only identity and filter fields",
    async (value) => {
      filter = value;
      const result = await readFilter();
      expect(result.details).toEqual({
        ok: true,
        accountId: "default",
        botId,
        guildId,
        explicitContentFilter: value,
      });
      expect(requests[0]?.path).toContain(Routes.user("@me"));
      expect(requests.at(-1)?.path).toContain(Routes.guild(guildId));
    },
  );

  it.each(["action", "binding", "account", "guild", "expected bot"])(
    "denies a missing or mismatched %s before REST",
    async (boundary) => {
      const discord = cfg.channels!.discord!;
      const params: Record<string, unknown> = {
        accountId: "default",
        guildId,
        expectedBotId: botId,
      };
      if (boundary === "action") {
        delete discord.actions!.guildMediaFilter;
      }
      if (boundary === "binding") {
        delete discord.guildMediaFilter;
      }
      if (boundary === "account") {
        delete params.accountId;
      }
      if (boundary === "guild") {
        params.guildId = "555555555555555555";
      }
      if (boundary === "expected bot") {
        params.expectedBotId = "666666666666666666";
      }
      await expect(readFilter({ params })).rejects.toThrow(/media.filter|accountId/i);
      expect(requests).toHaveLength(0);
    },
  );

  it("does not let another account inherit the default account binding", async () => {
    await expect(
      readFilter({
        accountId: "austin",
        params: { accountId: "austin", guildId, expectedBotId: botId },
      }),
    ).rejects.toThrow(/media.filter/i);
    expect(requests).toHaveLength(0);
  });

  it("denies an explicitly disabled account before REST", async () => {
    cfg.channels!.discord!.enabled = false;
    await expect(readFilter()).rejects.toThrow(/media.filter/i);
    expect(requests).toHaveLength(0);
  });

  it("does not substitute the selected account for a mismatching explicit selector", async () => {
    await expect(
      readFilter({
        params: { accountId: "austin", guildId, expectedBotId: botId },
      }),
    ).rejects.toThrow(/account binding/i);
    expect(requests).toHaveLength(0);
  });

  it("does not use owner/sender fields supplied in action parameters", async () => {
    await expect(
      readFilter({
        senderIsOwner: false,
        toolContext: { currentChannelProvider: "discord" },
        params: {
          accountId: "default",
          guildId,
          expectedBotId: botId,
          senderIsOwner: true,
          senderUserId: senderId,
        },
      }),
    ).rejects.toThrow(/trusted Discord sender/i);
    expect(requests).toHaveLength(0);
  });

  it("checks the authenticated bot before reading guild information", async () => {
    returnedBotId = "777777777777777777";
    await expect(readFilter()).rejects.toThrow(/bot identity/i);
    expect(requests).toHaveLength(1);
  });

  it("does not forward transport, credential, or mutation overrides from action parameters", async () => {
    await expect(
      readFilter({
        params: {
          accountId: "default",
          guildId,
          expectedBotId: botId,
          token: "untrusted-test-token",
          url: "https://example.invalid/override",
          method: "PATCH",
          body: { explicit_content_filter: 0 },
        },
      }),
    ).resolves.toMatchObject({ details: { explicitContentFilter: 2 } });
    expect(requests.every((request) => !request.path?.includes("override"))).toBe(true);
  });

  it("denies a bot without ManageGuild or Administrator", async () => {
    botPermissions = PermissionFlagsBits.ViewChannel;
    await expect(readFilter()).rejects.toThrow(/bot.*permissions/i);
  });

  it("allows the existing trusted Discord requester only with ManageGuild", async () => {
    const source = {
      senderIsOwner: false,
      requesterSenderId: senderId,
      toolContext: { currentChannelProvider: "discord" },
    };
    await expect(readFilter(source)).resolves.toMatchObject({
      details: { explicitContentFilter: 2 },
    });
    senderPermissions = 0n;
    await expect(readFilter(source)).rejects.toThrow(/sender.*permissions/i);
  });

  it("preserves the existing disabled guild read policy", async () => {
    cfg.channels!.discord!.groupPolicy = "disabled";
    await expect(readFilter()).rejects.toThrow(/not allowed/i);
  });

  it("preserves explicitly denied channels even for the direct operator", async () => {
    cfg.channels!.discord!.guilds = {
      [guildId]: { channels: { "999999999999999999": { enabled: false } } },
    };
    await expect(readFilter()).rejects.toThrow(/wildcard channel allowlist/i);
  });

  it.each([undefined, "2", 3, -1])("fails closed on an invalid filter %s", async (value) => {
    filter = value;
    await expect(readFilter()).rejects.toThrow(/filter response/i);
  });

  it("rejects a mismatched guild response", async () => {
    returnedGuildId = "888888888888888888";
    await expect(readFilter()).rejects.toThrow(/guild identity/i);
  });

  it("rechecks authority after awaited identity before another request", async () => {
    expireAfterIdentity = true;
    await expect(readFilter()).rejects.toThrow(/expired request authority/);
    expect(requests).toHaveLength(1);
  });

  it("discovers the getter only for a configured matching opt-in account", () => {
    const discover = (accountId: string) =>
      discordMessageActions.describeMessageTool!({ cfg, accountId });
    expect(discover("default")?.actions).toContain("guild-media-filter-get");
    expect(discover("austin")?.actions ?? []).not.toContain("guild-media-filter-get");
    delete cfg.channels!.discord!.actions!.guildMediaFilter;
    expect(discover("default")?.actions ?? []).not.toContain("guild-media-filter-get");
  });

  it("validates binding IDs strictly without admitting arbitrary REST fields", () => {
    expect(DiscordConfigSchema.safeParse(cfg.channels!.discord).success).toBe(true);
    for (const binding of [
      { accountId: "default", botId, guildIds: ["*"] },
      { accountId: "default", botId: 123, guildIds: [guildId] },
      { accountId: "default", botId, guildIds: [guildId], body: { explicit_content_filter: 0 } },
    ]) {
      expect(
        DiscordConfigSchema.safeParse({ ...cfg.channels!.discord, guildMediaFilter: binding })
          .success,
      ).toBe(false);
    }
  });
});
