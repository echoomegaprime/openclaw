import type { ChannelControlAdapter } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureDiscordRequestAuthority } from "../internal/request-authority.js";
import { controlGuildMediaFilter } from "./runtime.guild-media-filter-control.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  verifyBot: vi.fn(),
  guild: vi.fn(),
  permissions: vi.fn(),
  patch: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/channel-actions", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/channel-actions")>()),
  executeChannelControlOperation: mocks.execute,
}));
vi.mock("../send.guild.js", () => ({
  verifyGuildMediaFilterBotDiscord: mocks.verifyBot,
  fetchGuildInfoDiscord: mocks.guild,
  setGuildMediaFilterAllMembersDiscord: mocks.patch,
}));
vi.mock("../send.permissions.js", () => ({ hasAnyGuildPermissionDiscord: mocks.permissions }));

const guildId = "111111111111111111";
const botId = "222222222222222222";
const senderId = "333333333333333333";
const capability = Object.freeze({ version: 1 as const });
const handoff = {
  assertCurrent: vi.fn(),
  consumePhysicalHandoff: vi.fn(),
};
let cfg: OpenClawConfig;
let coreCurrent = true;
const assertCoreCurrent = () => {
  if (!coreCurrent) {
    throw new Error("core authority revoked");
  }
};
let adapter: ChannelControlAdapter | undefined;
let executeBody: (owner: ChannelControlAdapter) => Promise<unknown>;
const receipt = { disposition: "receipt", record: null, atomicCas: false };
const allowed = vi.fn(async () => {});

function invoke(values: Record<string, unknown> = {}, options = { controlOperation: capability }) {
  return controlGuildMediaFilter({
    values: { accountId: "default", expectedBotId: botId, guildId, ...values },
    cfg,
    assertGuildReadAllowed: allowed,
    options,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  cfg = {
    channels: {
      discord: {
        token: "synthetic-token",
        actions: { guildMediaFilter: true },
        guildMediaFilter: {
          accountId: "default",
          botId,
          guildIds: [guildId],
          allowSetAllMembers: true,
        },
      },
    },
  };
  adapter = undefined;
  coreCurrent = true;
  mocks.verifyBot.mockResolvedValue(botId);
  mocks.permissions.mockResolvedValue(true);
  mocks.guild.mockResolvedValue({ id: guildId, explicit_content_filter: 0 });
  mocks.patch.mockResolvedValue("acknowledged");
  executeBody = async (owner) => {
    await owner.assertAuthorized(assertCoreCurrent);
    assertCoreCurrent();
    await owner.getCurrentValue(assertCoreCurrent);
    assertCoreCurrent();
    await owner.patch(handoff);
    return receipt;
  };
  // The core owner separately tests private capability custody and durable
  // transitions. This fixture exercises the plugin's callback boundary only.
  mocks.execute.mockImplementation(async (received, owner: ChannelControlAdapter) => {
    if (received !== capability) {
      throw new Error("host capability required");
    }
    adapter = owner;
    return await executeBody(owner);
  });
});

describe("Discord fixed media-filter control adapter", () => {
  it("supplies exact binding and the original physical capability to the normal helper", async () => {
    const result = await invoke();
    expect(result.details).toEqual(receipt);
    expect(adapter?.binding).toEqual({ accountId: "default", botId, guildId });
    expect(mocks.patch).toHaveBeenCalledWith(
      guildId,
      expect.objectContaining({ cfg, accountId: "default" }),
      handoff,
    );
    expect(await adapter?.getCurrentValue(assertCoreCurrent)).toBe(0);
  });

  it("rejects a counterfeit host capability before any provider query", async () => {
    await expect(invoke({}, { controlOperation: { version: 1 } })).rejects.toThrow(
      "host capability required",
    );
    expect(mocks.verifyBot).not.toHaveBeenCalled();
    expect(mocks.guild).not.toHaveBeenCalled();
    expect(mocks.permissions).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it.each([undefined, false])("requires explicit true write opt-in (%s)", async (enabled) => {
    cfg.channels!.discord!.guildMediaFilter!.allowSetAllMembers = enabled;
    await expect(invoke()).rejects.toThrow("disabled");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it.each(["read", "cancel"])(
    "keeps %s receipt mode available when writes are disabled",
    async (controlMode) => {
      cfg.channels!.discord!.guildMediaFilter!.allowSetAllMembers = false;
      executeBody = async (owner) => {
        await owner.assertAuthorized(assertCoreCurrent);
        return receipt;
      };
      await invoke({ controlMode, operationId: "existing-operation" });
      expect(mocks.verifyBot).toHaveBeenCalledOnce();
      expect(mocks.permissions).toHaveBeenCalledOnce();
      expect(mocks.guild).toHaveBeenCalledOnce();
      expect(mocks.patch).not.toHaveBeenCalled();
    },
  );

  it("rechecks the write opt-in inside patch even when the wire mode says read", async () => {
    cfg.channels!.discord!.guildMediaFilter!.allowSetAllMembers = false;
    await expect(
      invoke({ controlMode: "read", operationId: "existing-operation" }),
    ).rejects.toThrow("disabled");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it.each([
    { accountId: "austin" },
    { expectedBotId: "444444444444444444" },
    { guildId: "555555555555555555" },
  ])("rejects mismatched account/bot/guild binding %o", async (values) => {
    await expect(invoke(values)).rejects.toThrow("binding");
    expect(mocks.verifyBot).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("preserves the existing guild policy denial", async () => {
    allowed.mockRejectedValueOnce(new Error("guild policy denied"));
    await expect(invoke()).rejects.toThrow("guild policy denied");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("rejects a changed provider guild identity before receipt disclosure", async () => {
    mocks.guild.mockResolvedValue({ id: "555555555555555555", explicit_content_filter: 0 });
    await expect(invoke()).rejects.toThrow("identity");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("requires the current bot to have ManageGuild", async () => {
    mocks.permissions.mockResolvedValue(false);
    await expect(invoke()).rejects.toThrow("permissions");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("checks the host-derived Discord member and ignores a senderUserId wire value", async () => {
    await controlGuildMediaFilter({
      values: { accountId: "default", expectedBotId: botId, guildId, senderUserId: "wire-user" },
      cfg,
      assertGuildReadAllowed: allowed,
      options: { controlOperation: capability, controlRequesterSenderId: senderId },
    });
    expect(mocks.permissions.mock.calls.map((call) => call[1])).toEqual([botId, senderId]);
    expect(adapter?.binding).toMatchObject({ requesterSenderId: senderId });
  });

  it("rejects a trusted Discord member without ManageGuild", async () => {
    mocks.permissions.mockImplementation(async (_guild, user) => user !== senderId);
    await expect(
      controlGuildMediaFilter({
        values: { accountId: "default", expectedBotId: botId, guildId },
        cfg,
        assertGuildReadAllowed: allowed,
        options: { controlOperation: capability, controlRequesterSenderId: senderId },
      }),
    ).rejects.toThrow("permissions");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("stops before permission queries when core authority expires during bot identity", async () => {
    mocks.verifyBot.mockImplementation(async () => {
      coreCurrent = false;
      return botId;
    });
    await expect(invoke()).rejects.toThrow("core authority revoked");
    expect(mocks.permissions).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("carries core authority into a provider permission query awaiting dispatch", async () => {
    mocks.permissions.mockImplementation(async () => {
      const requestGuard = captureDiscordRequestAuthority();
      coreCurrent = false;
      expect(requestGuard).toBeTypeOf("function");
      expect(() => requestGuard?.()).toThrow("core authority revoked");
      return true;
    });
    await expect(invoke()).rejects.toThrow("core authority revoked");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it.each([-1, 3, "2", undefined])("rejects invalid observed value %s", async (value) => {
    mocks.guild.mockResolvedValue({ id: guildId, explicit_content_filter: value });
    await expect(invoke()).rejects.toThrow("filter value");
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it.each([{ controlMode: "unsupported" }, { controlMode: "read" }])(
    "rejects invalid control mode/receipt locator %o",
    async (values) => {
      await expect(invoke(values)).rejects.toThrow();
      expect(mocks.execute).not.toHaveBeenCalled();
      expect(mocks.patch).not.toHaveBeenCalled();
    },
  );
});
