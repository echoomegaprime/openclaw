import { describe, expect, it, vi } from "vitest";
import type { ChannelControlAdapter } from "./message-control-operation.runtime.js";
import type {
  MessageControlAdmission,
  MessageControlAdmissionResult,
  MessageControlRecord,
  MessageControlDisposition,
} from "./message-control-operation.types.js";

const admission: MessageControlAdmission = {
  key: "one-change",
  operationId: "operation-1",
  attemptId: "attempt-1",
  stable: {
    version: 1,
    principal: { kind: "gateway-system-owner" },
    session: { kind: "sessionless" },
    intent: {
      action: "guild-media-filter-set-all-members",
      channelId: "discord",
      accountId: "default",
      expectedBotId: "111",
      guildId: "222",
      expectedCurrent: 0,
      desired: 2,
    },
  },
  execution: {
    version: 1,
    requestId: "req",
    connectionId: "conn",
    gatewayInstanceId: "boot",
    run: null,
    policyFingerprint: "a".repeat(64),
    providerRegistrationFingerprint: "b".repeat(64),
    databaseIdentityFingerprint: "c".repeat(64),
    databaseGeneration: { kind: "process-local", captured: true },
    admittedAtMs: 1,
  },
};
async function runtime() {
  const api = await import("./message-control-operation.runtime.js").catch(() => undefined);
  expect(api, "the private host capability must own the full effect lifecycle").toBeDefined();
  return api!;
}
function fixture() {
  const record: MessageControlRecord = {
    operationId: admission.operationId,
    attemptId: admission.attemptId,
    namespace: '[1,"gateway-system-owner"]',
    key: admission.key,
    stable: admission.stable,
    execution: admission.execution,
    phase: "prepared",
    held: true,
    result: null,
    observation: null,
    cancelRequested: false,
  };
  const store = {
    assertCurrent: vi.fn(),
    admit: vi.fn(async (): Promise<MessageControlAdmissionResult> => ({
      disposition: "admitted",
      record,
    })),
    dispatch: vi.fn(async (): Promise<MessageControlRecord> => ({
      ...record,
      phase: "dispatching",
    })),
    settle: vi.fn(
      async (input: { disposition: MessageControlDisposition }): Promise<MessageControlRecord> => ({
        ...record,
        phase: input.disposition === "unknown" ? "unknown" : "settled",
        held: input.disposition === "unknown",
        result: { disposition: input.disposition, at: 2, atomicCas: false },
      }),
    ),
    read: vi.fn(async () => record),
    observe: vi.fn(async () => record),
    cancel: vi.fn(async () => record),
  };
  const adapter = {
    assertAuthorized: vi.fn(async () => {}),
    binding: { accountId: "default", botId: "111", guildId: "222" },
    getCurrentValue: vi.fn<ChannelControlAdapter["getCurrentValue"]>(async () => 0),
    patch: vi.fn<ChannelControlAdapter["patch"]>(async (handoff) => {
      handoff.assertCurrent();
      handoff.consumePhysicalHandoff({
        method: "PATCH",
        path: "/guilds/222",
        body: '{"explicit_content_filter":2}',
      });
      return "acknowledged";
    }),
  };
  return { record, store, adapter };
}
describe("private fixed message-control capability", () => {
  it("binds the Discord member identity before any provider authorization or admission", async () => {
    const api = await runtime();
    const f = fixture();
    const discord = structuredClone(admission);
    discord.stable.principal = {
      kind: "discord-linked-admin",
      profileId: "profile",
      channelId: "discord",
      requesterAccountId: "default",
      requesterSenderId: "444",
    };
    discord.stable.session = {
      kind: "session",
      agentId: "main",
      canonicalSessionKey: "agent:main:discord:channel:555",
      sessionId: "session",
      lifecycleRevision: "1",
    };
    const owner = api.createMessageControlCapability({
      admission: discord,
      store: f.store,
      assertCurrent() {},
    });
    await expect(api.executeChannelControlOperation(owner.capability, f.adapter)).rejects.toThrow(
      /binding/,
    );
    expect(f.adapter.assertAuthorized).not.toHaveBeenCalled();
    expect(f.store.admit).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2] as const)(
    "preserves expected %s and never writes a pre-read conflict or existing all-members value",
    async (expected) => {
      const api = await runtime();
      const f = fixture();
      const input = structuredClone(admission);
      input.stable.intent.expectedCurrent = expected;
      f.adapter.getCurrentValue.mockResolvedValue(2);
      const owner = api.createMessageControlCapability({
        admission: input,
        store: f.store,
        assertCurrent() {},
      });
      expect(
        (await api.executeChannelControlOperation(owner.capability, f.adapter)).record?.result
          ?.disposition,
      ).toBe(expected === 2 ? "noop" : "conflict");
      expect(f.adapter.patch).not.toHaveBeenCalled();
      expect(f.store.dispatch).not.toHaveBeenCalled();
    },
  );
  it.each(["read", "reconcile", "cancel"] as const)(
    "%s inspects only the owned receipt and cannot replay or clear an unknown hold",
    async (mode) => {
      const api = await runtime();
      const f = fixture();
      f.record.phase = "unknown";
      f.record.result = { disposition: "unknown", at: 2, atomicCas: false };
      f.adapter.getCurrentValue.mockResolvedValue(2);
      const owner = api.createMessageControlCapability({
        admission,
        store: f.store,
        assertCurrent() {},
        mode: { mode, operationId: admission.operationId },
      });
      expect(
        (await api.executeChannelControlOperation(owner.capability, f.adapter)).record?.held,
      ).toBe(true);
      expect(f.store.read).toHaveBeenCalledWith({
        namespace: f.record.namespace,
        operationId: admission.operationId,
      });
      expect(f.adapter.getCurrentValue).toHaveBeenCalledTimes(mode === "reconcile" ? 1 : 0);
      expect(f.adapter.patch).not.toHaveBeenCalled();
      expect(f.store.dispatch).not.toHaveBeenCalled();
      expect(f.store.admit).not.toHaveBeenCalled();
      expect(f.store.settle).not.toHaveBeenCalled();
    },
  );
  it("closes copied capabilities and refuses substituted receipt targets before any reconciliation GET", async () => {
    const api = await runtime();
    const f = fixture();
    const closed = api.createMessageControlCapability({
      admission,
      store: f.store,
      assertCurrent() {},
    });
    closed.close();
    await expect(api.executeChannelControlOperation(closed.capability, f.adapter)).rejects.toThrow(
      /expired/,
    );
    f.store.read.mockResolvedValueOnce({
      ...f.record,
      stable: { ...f.record.stable, intent: { ...f.record.stable.intent, guildId: "333" } },
    });
    const read = api.createMessageControlCapability({
      admission,
      store: f.store,
      assertCurrent() {},
      mode: { mode: "reconcile", operationId: admission.operationId },
    });
    await expect(api.executeChannelControlOperation(read.capability, f.adapter)).rejects.toThrow(
      /binding/,
    );
    expect(f.adapter.getCurrentValue).not.toHaveBeenCalled();
  });
  it("checks provider permission after authentic capability but before durable admission or receipt lookup", async () => {
    const api = await runtime();
    const f = fixture();
    f.adapter.assertAuthorized.mockRejectedValue(new Error("missing ManageGuild"));
    const owner = api.createMessageControlCapability({
      admission,
      store: f.store,
      assertCurrent() {},
    });
    await expect(api.executeChannelControlOperation(owner.capability, f.adapter)).rejects.toThrow(
      /ManageGuild/,
    );
    expect(f.store.admit).not.toHaveBeenCalled();
    expect(f.adapter.patch).not.toHaveBeenCalled();
    const read = api.createMessageControlCapability({
      admission,
      store: f.store,
      assertCurrent() {},
      mode: { mode: "read", operationId: admission.operationId },
    });
    await expect(api.executeChannelControlOperation(read.capability, f.adapter)).rejects.toThrow(
      /ManageGuild/,
    );
    expect(f.store.read).not.toHaveBeenCalled();
  });
  it("requires a real host capability and exact target before provider calls", async () => {
    const api = await runtime();
    const { store, adapter } = fixture();
    await expect(api.executeChannelControlOperation({ version: 1 }, adapter)).rejects.toThrow(
      /capability/i,
    );
    const owner = api.createMessageControlCapability({ admission, store, assertCurrent() {} });
    await expect(
      api.executeChannelControlOperation(owner.capability, {
        ...adapter,
        binding: { ...adapter.binding, guildId: "333" },
      }),
    ).rejects.toThrow(/binding/i);
    expect(adapter.getCurrentValue).not.toHaveBeenCalled();
    expect(adapter.assertAuthorized).not.toHaveBeenCalled();
    expect(store.admit).not.toHaveBeenCalled();
  });
  it("records intent and dispatch before exactly one physical handoff and independently verifies value2", async () => {
    const api = await runtime();
    const { store, adapter } = fixture();
    adapter.getCurrentValue.mockResolvedValueOnce(0).mockResolvedValueOnce(2);
    const owner = api.createMessageControlCapability({ admission, store, assertCurrent() {} });
    const result = await api.executeChannelControlOperation(owner.capability, adapter);
    expect(store.admit.mock.invocationCallOrder[0]).toBeLessThan(
      store.dispatch.mock.invocationCallOrder[0],
    );
    expect(store.dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      adapter.patch.mock.invocationCallOrder[0],
    );
    expect(adapter.patch).toHaveBeenCalledTimes(1);
    expect(adapter.getCurrentValue).toHaveBeenCalledTimes(2);
    expect(result.record?.result?.disposition).toBe("verified_updated");
    expect(result.record?.result?.atomicCas).toBe(false);
    await expect(api.executeChannelControlOperation(owner.capability, adapter)).rejects.toThrow(
      /consumed/i,
    );
  });
  it("never replays receipt or uncertain PATCH, even when a later read reports2", async () => {
    const api = await runtime();
    const { store, adapter, record } = fixture();
    store.admit.mockResolvedValueOnce({ disposition: "receipt", record });
    const replay = api.createMessageControlCapability({ admission, store, assertCurrent() {} });
    await api.executeChannelControlOperation(replay.capability, adapter);
    expect(adapter.patch).not.toHaveBeenCalled();
    adapter.patch.mockImplementationOnce(async (handoff) => {
      handoff.consumePhysicalHandoff({
        method: "PATCH",
        path: "/guilds/222",
        body: '{"explicit_content_filter":2}',
      });
      throw new Error("lost response");
    });
    const uncertain = api.createMessageControlCapability({ admission, store, assertCurrent() {} });
    const outcome = await api.executeChannelControlOperation(uncertain.capability, adapter);
    expect(outcome.record?.held).toBe(true);
    expect(outcome.record?.result?.disposition).toBe("unknown");
    expect(adapter.patch).toHaveBeenCalledTimes(1);
  });
  it("refuses unknown native dispatch and rechecks current authority at physical handoff", async () => {
    const api = await runtime();
    const { store, adapter } = fixture();
    store.dispatch.mockRejectedValueOnce(new Error("native outcome unknown"));
    const first = api.createMessageControlCapability({ admission, store, assertCurrent() {} });
    await expect(api.executeChannelControlOperation(first.capability, adapter)).rejects.toThrow();
    expect(adapter.patch).not.toHaveBeenCalled();
    let current = true;
    adapter.patch.mockImplementationOnce(async (handoff) => {
      current = false;
      handoff.consumePhysicalHandoff({
        method: "PATCH",
        path: "/guilds/222",
        body: '{"explicit_content_filter":2}',
      });
      return "acknowledged";
    });
    const second = api.createMessageControlCapability({
      admission,
      store,
      assertCurrent() {
        if (!current) {
          throw new Error("revoked");
        }
      },
    });
    await expect(api.executeChannelControlOperation(second.capability, adapter)).rejects.toThrow(
      /revoked/,
    );
    expect(store.settle).toHaveBeenCalledWith(
      expect.objectContaining({ disposition: "not_entered" }),
    );
  });
});
