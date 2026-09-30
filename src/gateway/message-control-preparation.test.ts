import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageActionParams } from "../../packages/gateway-protocol/src/index.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createMessageControlCapability } from "../infra/outbound/message-control-operation.runtime.js";
import type { MessageControlAdmission } from "../infra/outbound/message-control-operation.types.js";
import { prepareGatewayMessageControl } from "./message-control-preparation.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

const mocks = vi.hoisted(() => ({
  registration: vi.fn(),
  instance: vi.fn(),
  captureState: vi.fn(),
  store: vi.fn(),
  authority: vi.fn(),
}));
vi.mock("../channels/plugins/registry.js", () => ({
  resolveChannelPluginRegistration: mocks.registration,
}));
vi.mock("../plugins/plugin-instance-scope.js", () => ({ getPluginValueInstance: mocks.instance }));
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: mocks.captureState,
}));
vi.mock("../infra/outbound/message-control-operation.store.js", () => ({
  createMessageControlStore: mocks.store,
}));
vi.mock("./message-control-authority.js", () => ({
  prepareMessageControlAuthority: mocks.authority,
}));
vi.mock("../infra/outbound/message-control-operation.runtime.js", async (original) => {
  const runtime =
    await original<typeof import("../infra/outbound/message-control-operation.runtime.js")>();
  return {
    ...runtime,
    createMessageControlCapability: vi.fn(runtime.createMessageControlCapability),
  };
});

const target = {
  accountId: "default",
  expectedBotId: "1385881607952404640",
  guildId: "1476211213699514509",
};
const cleanup: Array<() => void> = [];

function fixture() {
  const cfg: OpenClawConfig = {
    channels: {
      discord: {
        enabled: true,
        actions: { guildMediaFilter: true },
        guildMediaFilter: {
          accountId: target.accountId,
          botId: target.expectedBotId,
          guildIds: [target.guildId],
          allowSetAllMembers: true,
        },
      },
    },
  };
  const plugin = { id: "discord" } as ChannelPlugin;
  let currentConfig = cfg;
  const context = {
    gatewayInstanceId: "real-kernel-boot",
    getRuntimeConfig: () => currentConfig,
    getCommittedRuntimeConfig: () => currentConfig,
  };
  const request: MessageActionParams = {
    channel: "discord",
    action: "guild-media-filter-set-all-members",
    accountId: "default",
    idempotencyKey: "filter-once",
    params: { ...target, expectedCurrent: 0 },
  };
  const invocation = {
    req: { id: "request-one", type: "req", method: "message.action" },
    params: request,
    context,
  } as unknown as GatewayRequestHandlerOptions;
  const caller = vi.fn();
  const registrationCurrent = vi.fn(() => true);
  const registration = {
    plugin,
    origin: "global",
    captureReadAuthority: () => registrationCurrent,
  };
  const instance = {
    pluginId: "discord",
    sourceDigest: "real-loader-digest",
    acceptingCalls: true,
  };
  const state = {
    environment: { OPENCLAW_STATE_DIR: "fixture-state" },
    admission: { databasePath: "fixture-state/openclaw.db", assertCurrent: vi.fn() },
  };
  const authority = {
    principal: { kind: "gateway-profile" as const, profileId: "profile-one" },
    session: { kind: "sessionless" as const },
    namespace: JSON.stringify([1, "gateway-profile", "profile-one"]),
    execution: { requestId: "request-one", connectionId: "connection-one", run: null },
    assertCurrent: vi.fn(),
    release: vi.fn(),
  };
  const store = { databaseIdentityFingerprint: "a".repeat(64), assertCurrent: vi.fn() };
  mocks.registration.mockReturnValue(registration);
  mocks.instance.mockReturnValue(instance);
  mocks.captureState.mockReturnValue(state);
  mocks.authority.mockResolvedValue(authority);
  mocks.store.mockReturnValue(store);
  const prepare = () =>
    prepareGatewayMessageControl({
      invocation,
      request,
      cfg,
      channel: "discord",
      plugin,
      accountId: "default",
      assertCurrent: caller,
    });
  const retain = async () => {
    const result = await prepare();
    cleanup.push(result.close);
    return result;
  };
  return {
    cfg,
    request,
    invocation,
    context,
    plugin,
    instance,
    state,
    authority,
    caller,
    registration,
    registrationCurrent,
    prepare,
    retain,
    replaceConfig: (next: OpenClawConfig) => {
      currentConfig = next;
    },
  };
}
function admission(): MessageControlAdmission {
  return vi.mocked(createMessageControlCapability).mock.calls.at(-1)![0].admission;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  for (const close of cleanup.splice(0)) {
    close();
  }
});

describe("gateway message-control preparation", () => {
  it("retains actual owner provenance and the numeric expected zero", async () => {
    const f = fixture();
    const prepared = await f.retain();
    expect(prepared.controlOperation).toEqual({ version: 1 });
    expect(admission()).toMatchObject({
      key: "filter-once",
      stable: {
        principal: f.authority.principal,
        session: f.authority.session,
        intent: {
          ...target,
          action: f.request.action,
          channelId: "discord",
          expectedCurrent: 0,
          desired: 2,
        },
      },
      execution: {
        gatewayInstanceId: "real-kernel-boot",
        requestId: "request-one",
        connectionId: "connection-one",
        databaseIdentityFingerprint: "a".repeat(64),
        databaseGeneration: { kind: "process-local", captured: true },
      },
    });
    expect(admission().execution.providerRegistrationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const authorityCall = mocks.authority.mock.calls[0];
    const storeCall = mocks.store.mock.calls[0];
    if (!authorityCall || !storeCall) {
      throw new Error("expected authority and store preparation calls");
    }
    expect(authorityCall[0].invocation).toBe(f.invocation);
    expect(authorityCall[0].stateOptions).toEqual({
      path: f.state.admission.databasePath,
      env: f.state.environment,
    });
    expect(storeCall[0].stateOptions).toEqual({
      path: f.state.admission.databasePath,
      env: f.state.environment,
    });
    prepared.close();
    prepared.close();
    expect(f.authority.release).toHaveBeenCalledTimes(1);
    expect(() => prepared.assertCurrent()).toThrow();
  });

  it.each([undefined, null, "0", -1, 3])(
    "rejects non-exact expectedCurrent %s before mint",
    async (value) => {
      const f = fixture();
      f.request.params.expectedCurrent = value;
      await expect(f.prepare()).rejects.toThrow();
      expect(createMessageControlCapability).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, false])("requires explicit apply opt-in %s", async (enabled) => {
    const f = fixture();
    f.cfg.channels!.discord!.guildMediaFilter!.allowSetAllMembers = enabled;
    await expect(f.prepare()).rejects.toThrow();
    expect(createMessageControlCapability).not.toHaveBeenCalled();
  });

  it.each(["read", "reconcile", "cancel"] as const)(
    "allows authorized %s with writes disabled",
    async (mode) => {
      const f = fixture();
      f.cfg.channels!.discord!.guildMediaFilter!.allowSetAllMembers = false;
      f.request.params.controlMode = mode;
      f.request.params.operationId = "original-operation";
      delete f.request.params.expectedCurrent;
      await f.retain();
      expect(vi.mocked(createMessageControlCapability).mock.calls.at(-1)![0].mode).toEqual({
        mode,
        operationId: "original-operation",
      });
    },
  );

  it.each([
    "missing-boot",
    "missing-owner",
    "missing-digest",
    "retired-registration",
    "wrong-bot",
    "wrong-guild",
    "read-disabled",
    "missing-receipt",
    "unknown-mode",
  ])("fails closed for %s", async (kind) => {
    const f = fixture();
    if (kind === "missing-boot") {
      delete (f.context as { gatewayInstanceId?: string }).gatewayInstanceId;
    }
    if (kind === "missing-owner") {
      mocks.instance.mockReturnValue(undefined);
    }
    if (kind === "missing-digest") {
      f.instance.sourceDigest = "";
    }
    if (kind === "retired-registration") {
      f.registrationCurrent.mockReturnValue(false);
    }
    if (kind === "wrong-bot") {
      f.request.params.expectedBotId = "123";
    }
    if (kind === "wrong-guild") {
      f.request.params.guildId = "123";
    }
    if (kind === "read-disabled") {
      f.cfg.channels!.discord!.actions!.guildMediaFilter = false;
    }
    if (kind === "missing-receipt") {
      f.request.params.controlMode = "read";
    }
    if (kind === "unknown-mode") {
      f.request.params.controlMode = "retry";
    }
    await expect(f.prepare()).rejects.toThrow();
    expect(createMessageControlCapability).not.toHaveBeenCalled();
  });

  it.each([
    "config",
    "guild-policy",
    "committed-owner",
    "registration",
    "instance",
    "digest",
    "read-grant",
    "state",
    "caller",
    "principal",
    "boot",
  ])("invalidates retained authority when %s changes", async (kind) => {
    const f = fixture();
    const prepared = await f.retain();
    if (kind === "config") {
      f.cfg.channels!.discord!.guildMediaFilter!.allowSetAllMembers = false;
    }
    if (kind === "guild-policy") {
      f.cfg.channels!.discord!.guilds = { [target.guildId]: { users: ["another-user"] } };
    }
    if (kind === "committed-owner") {
      f.replaceConfig(structuredClone(f.cfg));
    }
    if (kind === "registration") {
      mocks.registration.mockReturnValue({ ...f.registration, plugin: { id: "discord" } });
    }
    if (kind === "instance") {
      mocks.instance.mockReturnValue({ ...f.instance });
    }
    if (kind === "digest") {
      f.instance.sourceDigest = "replacement-code";
    }
    if (kind === "read-grant") {
      f.registrationCurrent.mockReturnValue(false);
    }
    if (kind === "state") {
      f.state.admission.assertCurrent.mockImplementation(() => {
        throw new Error("state gone");
      });
    }
    if (kind === "caller") {
      f.caller.mockImplementation(() => {
        throw new Error("caller gone");
      });
    }
    if (kind === "principal") {
      f.authority.assertCurrent.mockImplementation(() => {
        throw new Error("principal gone");
      });
    }
    if (kind === "boot") {
      f.context.gatewayInstanceId = "other-boot";
    }
    expect(() => prepared.assertCurrent()).toThrow();
  });

  it("rechecks policy after awaited principal preparation and releases on denial", async () => {
    const f = fixture();
    mocks.authority.mockImplementationOnce(async () => {
      f.cfg.channels!.discord!.guildMediaFilter!.allowSetAllMembers = false;
      return f.authority;
    });
    await expect(f.prepare()).rejects.toThrow();
    expect(f.authority.release).toHaveBeenCalledTimes(1);
    expect(createMessageControlCapability).not.toHaveBeenCalled();
  });
});
