/** Private native event ownership. This is separate from optional admission audit evidence. */
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import {
  bindMcpLocalChannelPrincipal,
  hasMcpLocalChannelScope,
  resolveMcpLocalChannelScopeFingerprint,
  type McpLocalChannelFacts,
} from "../../agents/mcp-local-channel-context.js";
import type { FollowupRun } from "../../auto-reply/reply/queue/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { finalizedContextScopeKey, ownDataValue } from "./admission-evidence-scope-key.js";
import type { ChannelParticipantInput } from "./ingress-host-owner.js";

type NativePrincipal = Readonly<{
  facts: McpLocalChannelFacts;
  assertCurrent: () => void;
}>;
type ContextPrincipal = { principal: NativePrincipal; scope: string };
const contexts = new WeakMap<object, ContextPrincipal>();
const assignedFollowups = new WeakMap<NativePrincipal, object>();
const followups = new WeakMap<
  object,
  { principal: NativePrincipal; sessionId: string; admitted?: AdmittedRunContext }
>();

function scopeKey(context: object): string | undefined {
  const base = finalizedContextScopeKey(context);
  const space = ownDataValue(context, "GroupSpace");
  return base && typeof space === "string" ? JSON.stringify([base, space]) : undefined;
}
function snowflake(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,20}$/.test(value);
}

/** Called only after the private one-shot host ingress handoff has been consumed and checked. */
export function bindNativeLocalChannelPrincipal(
  context: object,
  input: ChannelParticipantInput,
): void {
  const principal = input.verifiedPrincipal;
  const binding = input.binding;
  const scope = scopeKey(context);
  const spaceId = ownDataValue(context, "GroupSpace");
  const fullId = ownDataValue(context, "MessageSidFull");
  const eventId = fullId ?? ownDataValue(context, "MessageSid");
  // This first producer is Discord's verified native member path. Other producers are not inferred.
  if (
    !principal ||
    principal.channelId !== "discord" ||
    input.identity.type !== "remote" ||
    input.identity.domain !== "discord" ||
    input.identity.idKind !== "user" ||
    input.owner.channelId !== principal.channelId ||
    binding.inboundEventKind !== "user_request" ||
    !scope ||
    !snowflake(spaceId) ||
    !snowflake(eventId) ||
    !snowflake(principal.senderId) ||
    !snowflake(binding.nativeChannelId) ||
    ownDataValue(context, "SenderId") !== principal.senderId ||
    ownDataValue(context, "AccountId") !== principal.accountId ||
    ownDataValue(context, "MessageSid") !== binding.messageId ||
    ownDataValue(context, "SessionKey") !== binding.sessionKey ||
    ownDataValue(context, "NativeChannelId") !== binding.nativeChannelId
  ) {
    return;
  }
  const facts: McpLocalChannelFacts = Object.freeze({
    agentId: binding.agentId,
    provider: principal.channelId,
    accountId: principal.accountId,
    spaceId,
    channelId: binding.nativeChannelId,
    senderId: principal.senderId,
    eventId,
    eventKind: "user_request",
    sessionKey: binding.sessionKey,
  });
  const owner = input.owner;
  const gateway = input.gatewayContext;
  const admittedConfig = gateway?.getRuntimeConfig();
  const launchFingerprint =
    admittedConfig && resolveMcpLocalChannelScopeFingerprint(admittedConfig, facts);
  let revoked = false;
  const assertCurrent = () => {
    if (
      revoked ||
      !owner.isLive() ||
      !gateway ||
      owner.resolveGatewayContext?.() !== gateway ||
      gateway.getRuntimeConfig() !== admittedConfig ||
      resolveMcpLocalChannelScopeFingerprint(gateway.getRuntimeConfig(), facts) !==
        launchFingerprint
    ) {
      revoked = true;
      throw new Error("local_channel_context:authority_expired");
    }
  };
  if (!gateway || !launchFingerprint) {
    return;
  }
  assertCurrent();
  contexts.set(context, { scope, principal: Object.freeze({ facts, assertCurrent }) });
}

/** Ordinary context replacement only; changed identity/room/event cannot carry authority. */
export function copyNativeLocalChannelPrincipal(source: object, target: object): void {
  const owned = contexts.get(source);
  if (!owned || scopeKey(source) !== owned.scope || scopeKey(target) !== owned.scope) {
    return;
  }
  owned.principal.assertCurrent();
  const current = contexts.get(target);
  if (current && current.principal !== owned.principal) {
    contexts.delete(target);
    return;
  }
  contexts.set(target, owned);
}

/** Exact followup object only: JSON replay and synthetic aggregate objects have no entry. */
export function bindLocalChannelFollowup(
  context: object,
  followup: FollowupRun,
  cfg: OpenClawConfig,
): boolean {
  const owned = contexts.get(context);
  if (
    !owned ||
    scopeKey(context) !== owned.scope ||
    !hasMcpLocalChannelScope(cfg, owned.principal.facts)
  ) {
    return false;
  }
  owned.principal.assertCurrent();
  const facts = owned.principal.facts;
  if (
    followup.messageId !== facts.eventId ||
    followup.run.agentId !== facts.agentId ||
    followup.run.sessionKey !== facts.sessionKey ||
    followup.run.senderId !== facts.senderId ||
    followup.run.agentAccountId !== facts.accountId ||
    followup.originatingChatId !== facts.channelId ||
    followup.originatingChannel !== facts.provider ||
    followup.run.groupSpace !== facts.spaceId
  ) {
    return false;
  }
  if (assignedFollowups.has(owned.principal)) {
    return false;
  }
  assignedFollowups.set(owned.principal, followup);
  followups.set(followup, { principal: owned.principal, sessionId: followup.run.sessionId });
  return true;
}

/** Bind the already-admitted original event to this run's live generation and cancellation owner. */
export function bindLocalChannelFollowupAdmission(
  followup: FollowupRun,
  context: AdmittedRunContext,
): void {
  const assignment = followups.get(followup);
  if (!assignment) {
    return;
  }
  if (assignment.admitted) {
    throw new Error("local_channel_context:authority_expired");
  }
  assignment.admitted = context;
  const principal = assignment.principal;
  const facts = principal.facts;
  const assertSourceCurrent = () => {
    principal.assertCurrent();
    if (
      followups.get(followup) !== assignment ||
      followup.run.sessionId !== assignment.sessionId ||
      assignment.admitted !== context ||
      followup.abortSignal?.aborted ||
      followup.queueAbortSignal?.aborted ||
      followup.turnAdoptionLifecycle?.abortSignal?.aborted ||
      followup.messageId !== facts.eventId ||
      followup.run.agentId !== facts.agentId ||
      followup.run.sessionKey !== facts.sessionKey ||
      followup.run.senderId !== facts.senderId ||
      followup.run.agentAccountId !== facts.accountId ||
      followup.originatingChatId !== facts.channelId ||
      followup.originatingChannel !== facts.provider ||
      followup.run.groupSpace !== facts.spaceId
    ) {
      throw new Error("local_channel_context:authority_expired");
    }
  };
  bindMcpLocalChannelPrincipal({
    context,
    facts,
    sessionId: followup.run.sessionId,
    assertSourceCurrent,
  });
}
