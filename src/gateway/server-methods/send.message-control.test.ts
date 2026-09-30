import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { sendHandlers } from "./send.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), dispatch: vi.fn(), mirror: vi.fn() }));
vi.mock("../message-control-preparation.js", () => ({
  prepareGatewayMessageControl: mocks.prepare,
}));
vi.mock("../../channels/plugins/message-action-dispatch.js", async (original) => ({
  ...(await original<typeof import("../../channels/plugins/message-action-dispatch.js")>()),
  dispatchChannelMessageAction: mocks.dispatch,
}));
vi.mock("./message-operation-result.js", async (original) => ({
  ...(await original<typeof import("./message-operation-result.js")>()),
  scheduleDeliveredSourceReplyTranscriptMirror: mocks.mirror,
}));

function fixture(action = "guild-media-filter-set-all-members") {
  const cfg: OpenClawConfig = { channels: { discord: { enabled: true } } };
  setRuntimeConfigSnapshot(cfg, cfg);
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "discord",
      config: { resolveAccount: () => ({ enabled: true }), isConfigured: () => true },
    }),
    actions: { supportsAction: () => true, handleAction: async () => jsonResult({ ok: true }) },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", source: "fixture", plugin }]));
  const context = {
    getRuntimeConfig: () => cfg,
    getCommittedRuntimeConfig: () => cfg,
    gatewayInstanceId: "kernel-boot",
    dedupe: new Map(),
  } as GatewayRequestContext;
  const prepared = {
    controlOperation: Object.freeze({ version: 1 }),
    assertCurrent: vi.fn(),
    close: vi.fn(),
  };
  mocks.prepare.mockResolvedValue(prepared);
  mocks.dispatch.mockResolvedValue(jsonResult({ ok: true, marker: "current-result" }));
  const createInvocation = () =>
    ({
      req: { type: "req", id: "control-request", method: "message.action" },
      params: {
        channel: "discord",
        accountId: "default",
        action,
        idempotencyKey: "control-idempotency",
        params: {
          accountId: "default",
          expectedBotId: "1385881607952404640",
          guildId: "1476211213699514509",
          expectedCurrent: 0,
        },
      },
      context,
      client: null,
      isWebchatConnect: () => false,
      respond: vi.fn(),
      hasCurrentClientAuthority: () => true,
    }) as GatewayRequestHandlerOptions;
  const invoke = async (invocation = createInvocation()) => {
    await sendHandlers["message.action"]!(invocation);
    return invocation;
  };
  return { context, plugin, prepared, createInvocation, invoke };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.mirror.mockReset();
  mocks.mirror.mockResolvedValue(undefined);
});
afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

describe("message.action fixed control operation", () => {
  it("preserves the exact original request and passes only the private capability downstream", async () => {
    const f = fixture();
    const invocation = f.createInvocation();
    vi.mocked(invocation.respond).mockImplementation(() => {
      expect(f.prepared.assertCurrent).toHaveBeenCalled();
      expect(f.prepared.close).not.toHaveBeenCalled();
    });
    await f.invoke(invocation);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.prepare.mock.calls[0][0].invocation).toBe(invocation);
    expect(mocks.dispatch.mock.calls[0][0].controlOperation).toBe(f.prepared.controlOperation);
    expect(mocks.dispatch.mock.calls[0][0]).not.toHaveProperty("invocation");
    expect(f.prepared.close).toHaveBeenCalledTimes(1);
    expect(invocation.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ marker: "current-result" }),
      undefined,
      expect.anything(),
    );
  });

  it("rechecks current control admission instead of replaying the generic result cache", async () => {
    const f = fixture();
    await f.invoke();
    mocks.prepare.mockRejectedValueOnce(new Error("current authority denied"));
    const second = await f.invoke();
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(second.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.anything(),
      expect.anything(),
    );
  });

  it("closes the capability after an adapter failure", async () => {
    const f = fixture();
    mocks.dispatch.mockRejectedValueOnce(new Error("adapter unavailable"));
    await f.invoke();
    expect(f.prepared.close).toHaveBeenCalledTimes(1);
  });

  it("prevents dispatch when control preparation denies", async () => {
    const f = fixture();
    mocks.prepare.mockRejectedValueOnce(new Error("denied"));
    const invocation = await f.invoke();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(invocation.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.anything(),
      expect.anything(),
    );
  });

  it("leaves ordinary actions on their existing cache path", async () => {
    const f = fixture("channel-info");
    await f.invoke();
    await f.invoke();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  });

  it("preserves a settled control receipt when unrelated source-reply mirroring throws", async () => {
    const f = fixture();
    mocks.mirror.mockRejectedValue(new Error("optional mirror unavailable"));
    const invocation = await f.invoke();
    expect(invocation.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ marker: "current-result" }),
      undefined,
      expect.anything(),
    );
    expect(mocks.mirror).not.toHaveBeenCalled();
    expect(f.prepared.close).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "denied"] as const)(
    "does not cache a %s control result for an ordinary action using the same key",
    async (outcome) => {
      const f = fixture();
      if (outcome === "denied") {
        mocks.prepare.mockRejectedValueOnce(new Error("current admission denied"));
      }
      await f.invoke();
      expect(f.context.dedupe.size).toBe(0);
      mocks.dispatch.mockResolvedValueOnce(
        jsonResult({ ok: true, marker: "ordinary-after-control" }),
      );
      const ordinary = f.createInvocation();
      ordinary.params = { ...ordinary.params, action: "channel-info" };
      await f.invoke(ordinary);
      expect(ordinary.respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ marker: "ordinary-after-control" }),
        undefined,
        expect.anything(),
      );
      expect(mocks.prepare).toHaveBeenCalledTimes(1);
      expect(mocks.dispatch).toHaveBeenCalledTimes(outcome === "success" ? 2 : 1);
    },
  );
});
