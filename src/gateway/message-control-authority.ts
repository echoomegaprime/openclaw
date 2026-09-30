import type { MessageActionParams } from "../../packages/gateway-protocol/src/index.js";
import { messageControlNamespace } from "../infra/outbound/message-control-operation.identity.js";
import type {
  MessageControlExecution,
  MessageControlPrincipal,
  MessageControlSession,
} from "../infra/outbound/message-control-operation.types.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db-contract.js";
import { isGatewayAuthPolicyCurrent } from "./auth-policy.js";
import { prepareChannelOperatorAdmin } from "./channel-operator-authority.js";
import {
  authorizeCurrentOperatorRoleScopes,
  resolveGatewayOperatorRoleActor,
} from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { ADMIN_SCOPE } from "./operator-scopes.js";
import {
  resolveAgentRuntimeMessageActionAuthorization,
  resolveTrustedMessageActionToolContext,
} from "./server-methods/message-action-context.js";
import { readGatewayRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { retainGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";
import { sameWorkerSessionTurnClaim } from "./worker-environments/placement-record.js";

type DenialCategory =
  | "unsupported_route"
  | "missing_request_authority"
  | "admin_required"
  | "shared_owner_unavailable"
  | "discord_authority_unavailable"
  | "session_unavailable"
  | "identity_unavailable"
  | "authority_changed"
  | "released";

/** Bounded categories only: underlying authority errors may contain private state. */
export class MessageControlAuthorityDeniedError extends Error {
  readonly code = "message_control_authority_denied";

  constructor(readonly category: DenialCategory) {
    super(`Message-control authority denied (${category})`);
    this.name = "MessageControlAuthorityDeniedError";
  }
}

export type MessageControlAuthority = {
  principal: MessageControlPrincipal;
  session: MessageControlSession;
  namespace: string;
  execution: Pick<MessageControlExecution, "requestId" | "connectionId" | "run">;
  assertCurrent: () => void;
  release: () => void;
};

export type PrepareMessageControlAuthorityParams = {
  /** Original registered-handler object, including its private request binding. */
  invocation: GatewayRequestHandlerOptions;
  request: Pick<MessageActionParams, "agentId" | "sessionKey" | "sessionId">;
  accountId: string;
  /** Captured by the core state owner, never supplied by message.action wire data. */
  stateOptions: OpenClawStateDatabaseOptions;
  assertCurrent: () => void;
  onDiagnostic?: (event: {
    category: string;
    disposition: "denied" | "admitted" | "released";
  }) => void;
};

function deny(category: DenialCategory): never {
  throw new MessageControlAuthorityDeniedError(category);
}

function identityText(value: unknown, limit = 256): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > limit ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  ) {
    deny("identity_unavailable");
  }
  return value;
}

/** Compose existing grants; durable records and request lifetime never create a principal. */
export async function prepareMessageControlAuthority(
  params: PrepareMessageControlAuthorityParams,
): Promise<MessageControlAuthority> {
  const { invocation, accountId, assertCurrent: assertCallerCurrent, onDiagnostic } = params;
  const { client, context, req } = invocation;
  const request = { ...params.request };
  const checks: Array<() => void> = [];
  const releases: Array<() => void> = [];
  let released = false;
  let denial: MessageControlAuthorityDeniedError | undefined;
  const diagnostic = (category: string, disposition: "denied" | "admitted" | "released") => {
    try {
      onDiagnostic?.({ category, disposition });
    } catch {
      // Diagnostics cannot grant authority, replace an outcome, or prevent cleanup.
    }
  };
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    for (const releaseHold of releases.splice(0).toReversed()) {
      try {
        releaseHold();
      } catch {
        diagnostic("cleanup_failed", "released");
      }
    }
    diagnostic("released", "released");
  };
  const mutation = readGatewayRequestMutationAuthority(invocation);
  const assertCurrent = () => {
    if (released) {
      deny("released");
    }
    if (denial) {
      throw denial;
    }
    try {
      if (
        !client ||
        invocation.client !== client ||
        invocation.context !== context ||
        invocation.req !== req ||
        typeof assertCallerCurrent !== "function" ||
        (!invocation.hasCurrentClientAuthority && !invocation.sessionMutationCommitGuard)
      ) {
        deny("missing_request_authority");
      }
      assertCallerCurrent();
      mutation.assertCurrent();
      for (const check of checks) {
        check();
      }
    } catch (error) {
      denial =
        error instanceof MessageControlAuthorityDeniedError
          ? error
          : new MessageControlAuthorityDeniedError("authority_changed");
      diagnostic(denial.category, "denied");
      throw denial;
    }
  };

  try {
    assertCurrent();
    if (!client) {
      deny("unsupported_route");
    }
    const execution: MessageControlAuthority["execution"] = {
      requestId: identityText(req.id),
      connectionId: identityText(client.connId),
      run: null,
    };
    let principal: MessageControlPrincipal;
    let session: MessageControlSession = { kind: "sessionless" };
    const identity = client.internal?.agentRuntimeIdentity;
    if (identity) {
      const trusted = resolveTrustedMessageActionToolContext({ client, request });
      const authorization = resolveAgentRuntimeMessageActionAuthorization(client);
      if (
        !trusted.ok ||
        !authorization ||
        authorization.scheduled ||
        trusted.toolContext?.currentChannelProvider !== "discord" ||
        authorization.toolContext?.currentChannelProvider !== "discord" ||
        !trusted.runtimeAgentId ||
        !trusted.sessionId ||
        trusted.requesterAccountId !== accountId ||
        authorization.requesterAccountId !== trusted.requesterAccountId ||
        !trusted.requesterSenderId ||
        authorization.requesterSenderId !== trusted.requesterSenderId
      ) {
        deny("discord_authority_unavailable");
      }
      const requesterAccountId = identityText(trusted.requesterAccountId, 128);
      const requesterSenderId = identityText(trusted.requesterSenderId, 20);
      const agentId = identityText(trusted.runtimeAgentId, 128);
      const sessionId = identityText(trusted.sessionId);
      const sessionKey = identityText(identity.sessionKey, 1024);
      const runId = identityText(identity.operationalRunInstance.runId);
      const instanceId = identityText(identity.operationalRunInstance.instanceId);
      const runLeaseClaimId = identityText(identity.delegatedAuthority.claimId);
      const delegatedKind = identity.delegatedAuthority.kind;
      const lifecycleGeneration = identityText(identity.delegatedAuthority.lifecycleGeneration);
      const workerClaim =
        identity.delegatedAuthority.kind === "worker"
          ? structuredClone(identity.delegatedAuthority.turnClaim)
          : undefined;
      checks.push(() => {
        const current = resolveTrustedMessageActionToolContext({ client, request });
        const currentAuthorization = resolveAgentRuntimeMessageActionAuthorization(client);
        const validate = context.validateAgentRuntimeApprovalAuthority;
        const delegated = identity.delegatedAuthority;
        if (
          client.internal?.agentRuntimeIdentity !== identity ||
          !validate ||
          !validate(identity) ||
          !current.ok ||
          !currentAuthorization ||
          currentAuthorization.scheduled ||
          current.runtimeAgentId !== agentId ||
          current.sessionId !== sessionId ||
          identity.sessionKey !== sessionKey ||
          identity.operationalRunInstance.runId !== runId ||
          identity.operationalRunInstance.instanceId !== instanceId ||
          delegated.claimId !== runLeaseClaimId ||
          delegated.kind !== delegatedKind ||
          delegated.lifecycleGeneration !== lifecycleGeneration ||
          delegated.operationalRunInstance.runId !== runId ||
          delegated.operationalRunInstance.instanceId !== instanceId ||
          (workerClaim &&
            (workerClaim.sessionId !== sessionId ||
              workerClaim.runId !== runId ||
              delegated.kind !== "worker" ||
              !sameWorkerSessionTurnClaim(workerClaim, delegated.turnClaim))) ||
          current.toolContext?.currentChannelProvider !== "discord" ||
          currentAuthorization.toolContext?.currentChannelProvider !== "discord" ||
          current.requesterAccountId !== requesterAccountId ||
          current.requesterSenderId !== requesterSenderId ||
          currentAuthorization.requesterAccountId !== requesterAccountId ||
          currentAuthorization.requesterSenderId !== requesterSenderId
        ) {
          deny("discord_authority_unavailable");
        }
      });
      assertCurrent();
      const retained = retainGatewaySessionEntryReadOnly(sessionKey, agentId);
      releases.push(retained.release);
      if (
        !retained.entry ||
        retained.entry.sessionId !== sessionId ||
        retained.agentId !== agentId ||
        !retained.entry.lifecycleRevision
      ) {
        deny("session_unavailable");
      }
      session = {
        kind: "session",
        agentId,
        canonicalSessionKey: identityText(retained.canonicalKey, 1024),
        sessionId,
        lifecycleRevision: identityText(retained.entry.lifecycleRevision),
      };
      checks.push(() => {
        if (!retained.isCurrentAtResponse()) {
          deny("session_unavailable");
        }
      });
      assertCurrent();
      const getConfig = () => context.getCommittedRuntimeConfig?.() ?? context.getRuntimeConfig();
      const admin = await prepareChannelOperatorAdmin(
        getConfig(),
        { channelId: "discord", accountId: requesterAccountId, senderId: requesterSenderId },
        params.stateOptions,
      );
      if (!admin) {
        deny("admin_required");
      }
      checks.push(() => {
        admin.signal?.throwIfAborted();
        if (!admin.isCurrent(getConfig())) {
          deny("admin_required");
        }
      });
      principal = {
        kind: "discord-linked-admin",
        profileId: identityText(admin.profileId),
        channelId: "discord",
        requesterAccountId,
        requesterSenderId,
      };
      execution.run = Object.freeze({
        runId,
        toolCallId: identity.messageActionContext?.sourceReplyToolCallId
          ? identityText(identity.messageActionContext.sourceReplyToolCallId)
          : null,
        placementId: null,
        claimId: workerClaim ? identityText(workerClaim.claimId) : runLeaseClaimId,
      });
    } else {
      if (request.sessionKey !== undefined || request.sessionId !== undefined) {
        deny("unsupported_route");
      }
      const actor = resolveGatewayOperatorRoleActor(client);
      checks.push(() => {
        if (
          client.internal?.agentRuntimeIdentity ||
          client.connect.role !== "operator" ||
          !client.connect.scopes?.includes(ADMIN_SCOPE) ||
          authorizeCurrentOperatorRoleScopes(
            client,
            context.getCommittedRuntimeConfig?.() ?? context.getRuntimeConfig(),
          )
        ) {
          deny("admin_required");
        }
      });
      assertCurrent();
      if (actor?.kind === "operator") {
        const profileId = identityText(actor.profileId);
        const captured = captureGatewayOperatorRunAuthority({
          client,
          context,
          hasCurrentClientAuthority: invocation.hasCurrentClientAuthority,
        });
        if (!captured) {
          deny("admin_required");
        }
        releases.push(captured.release);
        checks.push(() => {
          const currentActor = resolveGatewayOperatorRoleActor(client);
          captured.authority.assertCurrent();
          if (
            currentActor?.kind !== "operator" ||
            currentActor.profileId !== profileId ||
            captured.authority.profileId !== profileId ||
            !captured.authority.scopes.includes(ADMIN_SCOPE)
          ) {
            deny("admin_required");
          }
        });
        principal = { kind: "gateway-profile", profileId };
      } else if (actor?.kind === "system") {
        // The opaque binding proves the WS owner. Shape checks only narrow its
        // host-populated facts; caller-supplied system flags cannot create it.
        if (
          mutation.family !== "worker" ||
          !("usesSharedGatewayAuth" in client) ||
          client.usesSharedGatewayAuth !== true ||
          !("sharedGatewaySessionGeneration" in client) ||
          typeof client.sharedGatewaySessionGeneration !== "string" ||
          !client.sharedGatewaySessionGeneration ||
          !("authPolicyGeneration" in client) ||
          typeof client.authPolicyGeneration !== "string" ||
          !client.authPolicyGeneration
        ) {
          deny("shared_owner_unavailable");
        }
        const generation = client.sharedGatewaySessionGeneration;
        const policyGeneration = client.authPolicyGeneration;
        checks.push(() => {
          mutation.assertWorkerCurrent();
          if (
            resolveGatewayOperatorRoleActor(client)?.kind !== "system" ||
            client.usesSharedGatewayAuth !== true ||
            client.sharedGatewaySessionGeneration !== generation ||
            client.authPolicyGeneration !== policyGeneration ||
            !isGatewayAuthPolicyCurrent(
              policyGeneration,
              context.getCommittedRuntimeConfig?.() ?? context.getRuntimeConfig(),
            )
          ) {
            deny("shared_owner_unavailable");
          }
        });
        principal = { kind: "gateway-system-owner" };
      } else {
        deny("unsupported_route");
      }
    }
    const namespace = messageControlNamespace(principal);
    assertCurrent();
    diagnostic(principal.kind, "admitted");
    return Object.freeze({
      principal: Object.freeze(principal),
      session: Object.freeze(session),
      namespace,
      execution: Object.freeze(execution),
      assertCurrent,
      release,
    });
  } catch (error) {
    release();
    const failure =
      error instanceof MessageControlAuthorityDeniedError
        ? error
        : new MessageControlAuthorityDeniedError("authority_changed");
    diagnostic(failure.category, "denied");
    throw failure;
  }
}
