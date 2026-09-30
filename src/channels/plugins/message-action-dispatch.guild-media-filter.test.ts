import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  dispatchChannelMessageAction,
  isFencedProviderReadAction,
  isScheduledMessageWriteAction,
} from "./message-action-dispatch.js";

const handleAction = vi.fn(async () => jsonResult({ ok: true }));

beforeEach(() => {
  handleAction.mockClear();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: "discord",
            label: "Discord",
            config: { listAccountIds: () => ["default"] },
          }),
          actions: {
            describeMessageTool: () => ({ actions: ["role-info", "guild-media-filter-get"] }),
            supportsAction: () => true,
            handleAction,
          },
        },
      },
    ]),
  );
});

afterEach(() => setActivePluginRegistry(createTestRegistry([])));

describe("guild media-filter host read authority", () => {
  it.each(["role-info", "guild-media-filter-get"] as const)(
    "dispatches %s only through the host's read authority",
    async (action) => {
      const request = {
        cfg: {},
        channel: "discord",
        action,
        params: { guildId: "111111111111111111", conversationReadOrigin: "direct-operator" },
        accountId: "default",
      };
      await dispatchChannelMessageAction({ ...request, conversationReadOrigin: "direct-operator" });
      expect(handleAction).toHaveBeenCalledOnce();
      handleAction.mockClear();
      await expect(
        dispatchChannelMessageAction({ ...request, conversationReadOrigin: "delegated" }),
      ).rejects.toThrow("requires the exact current conversation and account");
      expect(handleAction).not.toHaveBeenCalled();
    },
  );

  it("uses the existing provider read fence without admitting a scheduled write", () => {
    expect(isFencedProviderReadAction("guild-media-filter-get")).toBe(true);
    expect(isScheduledMessageWriteAction("guild-media-filter-get")).toBe(false);
    expect(isScheduledMessageWriteAction("guild-media-filter-set-all-members")).toBe(false);
  });
});
