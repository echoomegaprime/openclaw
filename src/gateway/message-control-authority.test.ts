import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { prepareUserChannelIdentityAuthority } from "../state/user-channel-identity-operations.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "./agent-runtime-identity-token.js";
import { resolveGatewayAuthPolicyGeneration } from "./auth-policy.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "./device-revocation.js";
import {
  mintMessageActionTurnCapability,
  resolveMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "./message-action-turn-capability.js";
import {
  prepareMessageControlAuthority,
  type PrepareMessageControlAuthorityParams,
} from "./message-control-authority.js";
import {
  bindGatewayRequestHandlerMutationAuthority,
  bindWebSocketRequestMutationAuthority,
} from "./server-methods/session-mutation-guards.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { retainGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";
import { sameWorkerSessionTurnClaim } from "./worker-environments/placement-record.js";

// The identity worker and session reader own storage. Keep grant, role, turn,
// request and revocation owners real while substituting only these storage seams.
vi.mock("../state/user-channel-identity-operations.js", () => ({
  prepareUserChannelIdentityAuthority: vi.fn(),
}));
vi.mock("./session-utils-read-lifetime.js", () => ({ retainGatewaySessionEntryReadOnly: vi.fn() }));

const releases: Array<() => void> = [];
let config: OpenClawConfig;
beforeEach(() => {
  config = {};
  setRuntimeConfigSnapshot(config, config);
  vi.clearAllMocks();
});
afterEach(() => {
  for (const release of releases.splice(0).toReversed()) {
    release();
  }
  clearRuntimeConfigSnapshot();
});

function fixture() {
  const controller = new AbortController();
  const context = {
    getRuntimeConfig: () => config,
    getCommittedRuntimeConfig: () => config,
  } as GatewayRequestContext;
  const client: GatewayClient = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "cli", version: "test", platform: "test", mode: "cli" },
      role: "operator",
      scopes: ["operator.admin"],
    },
    connId: "connection-one",
    internal: {
      operatorRoleActor: { kind: "operator", profileId: "profile-one" },
      operatorAccessAuthority: null,
    },
  };
  const device = captureGatewayDeviceRevocation(
    context,
    { deviceId: "device-one", role: "operator" },
    () => !controller.signal.aborted,
  );
  releases.push(device.release);
  const invocation: GatewayRequestHandlerOptions = {
    req: { type: "req", id: "request-one", method: "message.action" },
    params: {},
    client,
    context,
    isWebchatConnect: () => false,
    respond: () => {},
    signal: controller.signal,
    hasCurrentClientAuthority: device.isCurrent,
  };
  const params: PrepareMessageControlAuthorityParams = {
    invocation,
    request: {},
    accountId: "default",
    stateOptions: {},
    assertCurrent: () => controller.signal.throwIfAborted(),
  };
  return { params, invocation, client, context, controller };
}

function sharedFixture() {
  const result = fixture();
  const connId = result.client.connId;
  if (!connId) {
    throw new Error("missing fixture connection identity");
  }
  const client: GatewayWsClient = {
    connect: result.client.connect,
    connId,
    internal: { operatorRoleActor: { kind: "system" as const } },
    usesSharedGatewayAuth: true,
    sharedGatewaySessionGeneration: "generation-one",
    authPolicyGeneration: resolveGatewayAuthPolicyGeneration(config),
    socket: {
      readyState: 1,
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      once: vi.fn(),
    } satisfies GatewayWsClient["socket"],
  };
  result.invocation.client = client;
  const generations = new SharedGatewaySessionGenerationState({
    current: "generation-one",
    required: null,
  });
  const request = bindWebSocketRequestMutationAuthority(
    { ...result.invocation },
    client,
    generations.reader,
  );
  bindGatewayRequestHandlerMutationAuthority(request, result.invocation, undefined);
  return { ...result, client, generations };
}

function discordFixture(scheduled = false) {
  const result = fixture();
  config = {
    gateway: {
      roles: {
        definitions: {
          admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config, config);
  const agentId = "main";
  const sessionKey = "agent:main:discord:channel:111";
  const sessionId = "session-one";
  const operationalRunInstance = { instanceId: "instance-one", runId: "run-one" };
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  releases.push(() => releaseAgentRunDelegatedAuthority(delegatedAuthority));
  const token = mintMessageActionTurnCapability({
    agentId,
    runId: "run-one",
    sessionKey,
    sessionId,
    requesterAccountId: "default",
    requesterSenderId: "123456789",
    toolContext: { currentChannelProvider: "discord" },
    ...(scheduled
      ? {
          scheduled: {
            policy: { version: 1 as const, mode: "trusted" as const },
            assertCurrent: () => {},
          },
        }
      : {}),
  });
  releases.push(() => {
    revokeMessageActionTurnCapability(token);
  });
  const messageActionContext = resolveMessageActionTurnCapability({
    token,
    agentId,
    runId: "run-one",
    sessionKey,
    sessionId,
  });
  if (!messageActionContext) {
    throw new Error("missing test turn");
  }
  result.client.internal = {
    agentRuntimeIdentity: {
      kind: "agentRuntime",
      agentId,
      sessionKey,
      operationalRunInstance,
      delegatedAuthority: { ...delegatedAuthority, kind: "local" },
      messageActionContext: { ...messageActionContext, turnCapability: token },
    },
  };
  result.context.validateAgentRuntimeApprovalAuthority =
    createAgentRuntimeApprovalAuthorityValidator();
  result.params.request = { agentId, sessionKey, sessionId };
  let linked = true;
  vi.mocked(prepareUserChannelIdentityAuthority).mockResolvedValue({
    linked: { profileId: "linked-one", role: "admin", emails: [], loginIdentities: [] },
    isCurrent: () => linked,
  });
  let rowCurrent = true;
  let physicalCurrent = true;
  const storePath = "/fixture/main/agent.sqlite";
  const entry = { sessionId, lifecycleRevision: "revision-one", updatedAt: 1 };
  const read = {
    cfg: config,
    agentId,
    storePath,
    store: { [sessionKey]: entry },
    storeKeys: [sessionKey],
    legacyKey: undefined,
    readSource: { agentId, path: storePath },
    canonicalKey: sessionKey,
    entry,
    isCurrent: () => physicalCurrent,
    isCurrentAtResponse: () => rowCurrent && physicalCurrent,
    release: vi.fn(),
  } satisfies ReturnType<typeof retainGatewaySessionEntryReadOnly>;
  vi.mocked(retainGatewaySessionEntryReadOnly).mockReturnValue(read);
  return {
    ...result,
    token,
    read,
    runLeaseClaimId: delegatedAuthority.claimId,
    closeRun: () => releaseAgentRunDelegatedAuthority(delegatedAuthority),
    unlink: () => {
      linked = false;
    },
    changeRow: () => {
      rowCurrent = false;
    },
    replaceStore: () => {
      physicalCurrent = false;
    },
  };
}

describe("message control authority admission", () => {
  it("derives a named admin namespace and retains request lifetime", async () => {
    const { params, controller } = fixture();
    const authority = await prepareMessageControlAuthority(params);
    releases.push(authority.release);
    expect(authority.principal).toEqual({ kind: "gateway-profile", profileId: "profile-one" });
    expect(authority.namespace).toBe('[1,"gateway-profile","profile-one"]');
    expect(authority.session).toEqual({ kind: "sessionless" });
    expect(authority.execution).toEqual({
      requestId: "request-one",
      connectionId: "connection-one",
      run: null,
    });
    authority.assertCurrent();
    controller.abort();
    expect(() => authority.assertCurrent()).toThrow();
  });

  it.each(["write-only", "no-profile", "node", "supplied-session"])(
    "rejects %s instead of inventing an operator",
    async (kind) => {
      const { params, client } = fixture();
      if (kind === "write-only") {
        client.connect.scopes = ["operator.write"];
      }
      if (kind === "no-profile") {
        client.internal = undefined;
      }
      if (kind === "node") {
        client.connect.role = "node";
      }
      if (kind === "supplied-session") {
        params.request.sessionId = "supplied";
      }
      await expect(prepareMessageControlAuthority(params)).rejects.toThrow();
    },
  );

  it("preserves stable identity across reconnect without replacing old execution facts", async () => {
    const first = fixture();
    const one = await prepareMessageControlAuthority(first.params);
    releases.push(one.release);
    const next = fixture();
    next.client.connId = "connection-two";
    next.invocation.req = { ...next.invocation.req, id: "request-two" };
    const two = await prepareMessageControlAuthority(next.params);
    releases.push(two.release);
    expect(two.namespace).toBe(one.namespace);
    expect(two.session).toEqual(one.session);
    expect(one.execution.connectionId).toBe("connection-one");
    expect(two.execution.connectionId).toBe("connection-two");
  });

  it("accepts only the actual shared owner WS binding", async () => {
    const { params, generations } = sharedFixture();
    const authority = await prepareMessageControlAuthority(params);
    releases.push(authority.release);
    expect(authority.principal).toEqual({ kind: "gateway-system-owner" });
    expect(authority.namespace).toBe('[1,"gateway-system-owner"]');
    generations.publish({ current: "generation-two", required: null });
    expect(() => authority.assertCurrent()).toThrow();
  });

  it.each([
    "copied-invocation",
    "missing-generation",
    "missing-policy",
    "not-shared",
    "write-only",
  ])("rejects shared owner with %s", async (kind) => {
    const { params, client } = sharedFixture();
    if (kind === "copied-invocation") {
      params.invocation = { ...params.invocation };
    }
    if (kind === "missing-generation") {
      delete (client as Partial<GatewayWsClient>).sharedGatewaySessionGeneration;
    }
    if (kind === "missing-policy") {
      delete (client as Partial<GatewayWsClient>).authPolicyGeneration;
    }
    if (kind === "not-shared") {
      client.usesSharedGatewayAuth = false;
    }
    if (kind === "write-only") {
      client.connect.scopes = ["operator.write"];
    }
    await expect(prepareMessageControlAuthority(params)).rejects.toThrow();
  });

  it("rejects source revocation after named admission", async () => {
    const { params, context } = fixture();
    const authority = await prepareMessageControlAuthority(params);
    releases.push(authority.release);
    invalidateGatewayDeviceRevocation(context, "device-one", "operator");
    expect(() => authority.assertCurrent()).toThrow();
  });

  it("rejects lost admin scope and cannot revive the same retained authority", async () => {
    const { params, client } = fixture();
    const authority = await prepareMessageControlAuthority(params);
    releases.push(authority.release);
    client.connect.scopes = ["operator.write"];
    expect(() => authority.assertCurrent()).toThrow();
    client.connect.scopes = ["operator.admin"];
    expect(() => authority.assertCurrent()).toThrow();
  });

  it("binds trusted Discord identity to the linked admin and actual session lifecycle", async () => {
    const { params, changeRow, read } = discordFixture();
    const authority = await prepareMessageControlAuthority(params);
    releases.push(authority.release);
    expect(authority.namespace).toBe(
      '[1,"discord-linked-admin","linked-one","discord","default","123456789"]',
    );
    expect(authority.session).toEqual({
      kind: "session",
      agentId: "main",
      canonicalSessionKey: "agent:main:discord:channel:111",
      sessionId: "session-one",
      lifecycleRevision: "revision-one",
    });
    expect(authority.execution.run?.runId).toBe("run-one");
    changeRow();
    expect(read.isCurrent()).toBe(true);
    expect(() => authority.assertCurrent()).toThrow();
  });

  it("records the real local run lease claim without inventing a worker placement", async () => {
    const { params, runLeaseClaimId } = discordFixture();
    const authority = await prepareMessageControlAuthority(params);
    releases.push(authority.release);
    expect(authority.execution.run?.claimId).toBe(runLeaseClaimId);
    expect(authority.execution.run?.placementId).toBeNull();
  });

  it("does not follow a replacement run claim on the same host identity", async () => {
    const { params, client, context, closeRun } = discordFixture();
    const identity = client.internal?.agentRuntimeIdentity;
    if (!identity) {
      throw new Error("missing fixture identity");
    }
    const authority = await prepareMessageControlAuthority(params);
    releases.push(authority.release);
    closeRun();
    const replacement = claimAgentRunDelegatedAuthority(identity.operationalRunInstance);
    releases.push(() => releaseAgentRunDelegatedAuthority(replacement));
    identity.delegatedAuthority = { ...replacement, kind: "local" };
    expect(context.validateAgentRuntimeApprovalAuthority?.(identity)).toBe(true);
    expect(() => authority.assertCurrent()).toThrow();
  });

  it("does not follow a replacement worker placement claim on the same host identity", async () => {
    const { params, client, context } = discordFixture();
    const identity = client.internal?.agentRuntimeIdentity;
    if (!identity) {
      throw new Error("missing fixture identity");
    }
    let claim = {
      sessionId: "session-one",
      claimId: "worker-claim-one",
      runId: "run-one",
      placementGeneration: 1,
      owner: { kind: "worker" as const, environmentId: "worker-one", ownerEpoch: 1 },
    };
    identity.delegatedAuthority = {
      ...identity.delegatedAuthority,
      kind: "worker",
      turnClaim: claim,
    };
    context.validateAgentRuntimeApprovalAuthority = createAgentRuntimeApprovalAuthorityValidator({
      validateTurnClaim: (candidate) => sameWorkerSessionTurnClaim(candidate, claim),
    });
    const authority = await prepareMessageControlAuthority(params);
    releases.push(authority.release);
    expect(authority.execution.run?.claimId).toBe("worker-claim-one");
    claim = { ...claim, placementGeneration: 2 };
    identity.delegatedAuthority = {
      ...identity.delegatedAuthority,
      kind: "worker",
      turnClaim: claim,
    };
    expect(context.validateAgentRuntimeApprovalAuthority?.(identity)).toBe(true);
    expect(() => authority.assertCurrent()).toThrow();
  });

  it.each([
    "unlinked",
    "no-validator",
    "invalid-validator",
    "missing-revision",
    "wrong-session",
    "other-account",
    "revoked-turn",
  ])("rejects Discord %s", async (kind) => {
    const { params, context, read, token } = discordFixture();
    if (kind === "unlinked") {
      vi.mocked(prepareUserChannelIdentityAuthority).mockResolvedValue(undefined);
    }
    if (kind === "no-validator") {
      context.validateAgentRuntimeApprovalAuthority = undefined;
    }
    if (kind === "invalid-validator") {
      context.validateAgentRuntimeApprovalAuthority = () => false;
    }
    if (kind === "missing-revision") {
      read.entry.lifecycleRevision = "";
    }
    if (kind === "wrong-session") {
      read.entry.sessionId = "session-two";
    }
    if (kind === "other-account") {
      params.accountId = "austin";
    }
    if (kind === "revoked-turn") {
      revokeMessageActionTurnCapability(token);
    }
    await expect(prepareMessageControlAuthority(params)).rejects.toThrow();
  });

  it.each(["unlink", "turn", "validator", "store", "run"])(
    "rechecks Discord %s after admission",
    async (kind) => {
      const { params, context, unlink, token, replaceStore, closeRun } = discordFixture();
      const authority = await prepareMessageControlAuthority(params);
      releases.push(authority.release);
      if (kind === "unlink") {
        unlink();
      }
      if (kind === "turn") {
        revokeMessageActionTurnCapability(token);
      }
      if (kind === "validator") {
        context.validateAgentRuntimeApprovalAuthority = () => false;
      }
      if (kind === "store") {
        replaceStore();
      }
      if (kind === "run") {
        closeRun();
      }
      expect(() => authority.assertCurrent()).toThrow();
    },
  );

  it("rejects scheduled turns even when the linked sender is an admin", async () => {
    const { params } = discordFixture(true);
    await expect(prepareMessageControlAuthority(params)).rejects.toThrow();
  });

  it.each(["sender", "provider", "session"])(
    "does not accept forged Discord %s metadata",
    async (field) => {
      const { params, client } = discordFixture();
      const context = client.internal?.agentRuntimeIdentity?.messageActionContext;
      if (!context) {
        throw new Error("missing fixture context");
      }
      if (field === "sender") {
        context.requesterSenderId = "987654321";
      }
      if (field === "provider") {
        context.toolContext = { currentChannelProvider: "telegram" };
      }
      if (field === "session") {
        params.request.sessionId = "different-session";
      }
      await expect(prepareMessageControlAuthority(params)).rejects.toThrow();
    },
  );

  it("releases retained session on a denial after an awaited link read", async () => {
    const { params, read, controller } = discordFixture();
    vi.mocked(prepareUserChannelIdentityAuthority).mockImplementation(async () => {
      controller.abort();
      return undefined;
    });
    await expect(prepareMessageControlAuthority(params)).rejects.toThrow();
    // Cleanup must not depend on an admitted result reaching the caller.
    expect(read.release).toHaveBeenCalledOnce();
  });

  it("does not let diagnostic failure replace admission or cleanup", async () => {
    const { params } = fixture();
    params.onDiagnostic = () => {
      throw new Error("unsafe arbitrary log detail");
    };
    const authority = await prepareMessageControlAuthority(params);
    authority.assertCurrent();
    authority.release();
    expect(() => authority.assertCurrent()).toThrow();
    expect(() => authority.release()).not.toThrow();
  });
});
