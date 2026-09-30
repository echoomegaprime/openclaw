import { createHash } from "node:crypto";
import type {
  MessageControlAdmission,
  MessageControlPrincipal,
} from "./message-control-operation.types.js";

function invalid(): never {
  throw new Error("Invalid message-control binding");
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid();
  }
  if (Object.keys(value).toSorted().join("|") !== keys.toSorted().join("|")) {
    return invalid();
  }
  // SAFETY: the guards above require a non-array object with exactly these own keys; values stay unknown.
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > limit
  ) {
    return invalid();
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return invalid();
    }
  }
  return value;
}
function normalized(value: unknown): string {
  const result = text(value, 128);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(result)) {
    return invalid();
  }
  return result;
}
function snowflake(value: unknown): string {
  const result = text(value, 20);
  if (!/^[1-9][0-9]*$/.test(result) || BigInt(result) > 18446744073709551615n) {
    return invalid();
  }
  return result;
}
export function messageControlNamespace(principal: MessageControlPrincipal): string {
  if (principal.kind === "gateway-system-owner") {
    object(principal, ["kind"]);
    return JSON.stringify([1, principal.kind]);
  }
  if (principal.kind === "gateway-profile") {
    object(principal, ["kind", "profileId"]);
    return JSON.stringify([1, principal.kind, text(principal.profileId, 256)]);
  }
  if (principal.kind === "discord-linked-admin") {
    object(principal, [
      "kind",
      "profileId",
      "channelId",
      "requesterAccountId",
      "requesterSenderId",
    ]);
    if (principal.channelId !== "discord") {
      return invalid();
    }
    return JSON.stringify([
      1,
      principal.kind,
      text(principal.profileId, 256),
      "discord",
      normalized(principal.requesterAccountId),
      snowflake(principal.requesterSenderId),
    ]);
  }
  return invalid();
}
export function encodeMessageControlAdmission(input: MessageControlAdmission) {
  object(input, ["key", "operationId", "attemptId", "stable", "execution"]);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.key)) {
    return invalid();
  }
  text(input.operationId, 256);
  text(input.attemptId, 256);
  const stable = input.stable;
  object(stable, ["version", "principal", "session", "intent"]);
  if (stable.version !== 1) {
    return invalid();
  }
  const namespace = messageControlNamespace(stable.principal);
  const session = stable.session;
  if (session.kind === "sessionless") {
    object(session, ["kind"]);
  } else if (session.kind === "session") {
    object(session, ["kind", "agentId", "canonicalSessionKey", "sessionId", "lifecycleRevision"]);
    normalized(session.agentId);
    text(session.canonicalSessionKey, 1024);
    text(session.sessionId, 256);
    text(session.lifecycleRevision, 256);
  } else {
    return invalid();
  }
  if ((stable.principal.kind === "discord-linked-admin") !== (session.kind === "session")) {
    return invalid();
  }
  const intent = stable.intent;
  object(intent, [
    "action",
    "channelId",
    "accountId",
    "expectedBotId",
    "guildId",
    "expectedCurrent",
    "desired",
  ]);
  if (
    intent.action !== "guild-media-filter-set-all-members" ||
    intent.channelId !== "discord" ||
    intent.desired !== 2 ||
    ![0, 1, 2].includes(intent.expectedCurrent)
  ) {
    return invalid();
  }
  normalized(intent.accountId);
  snowflake(intent.expectedBotId);
  snowflake(intent.guildId);
  if (
    stable.principal.kind === "discord-linked-admin" &&
    stable.principal.requesterAccountId !== intent.accountId
  ) {
    return invalid();
  }
  const execution = input.execution;
  object(execution, [
    "version",
    "requestId",
    "connectionId",
    "gatewayInstanceId",
    "run",
    "policyFingerprint",
    "providerRegistrationFingerprint",
    "databaseIdentityFingerprint",
    "databaseGeneration",
    "admittedAtMs",
  ]);
  if (
    execution.version !== 1 ||
    !Number.isSafeInteger(execution.admittedAtMs) ||
    execution.admittedAtMs < 0
  ) {
    return invalid();
  }
  for (const value of [execution.requestId, execution.connectionId, execution.gatewayInstanceId]) {
    text(value, 256);
  }
  for (const value of [
    execution.policyFingerprint,
    execution.providerRegistrationFingerprint,
    execution.databaseIdentityFingerprint,
  ]) {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      return invalid();
    }
  }
  const generation = object(execution.databaseGeneration, ["kind", "captured"]);
  if (generation.kind !== "process-local" || generation.captured !== true) {
    return invalid();
  }
  if (execution.run !== null) {
    object(execution.run, ["runId", "toolCallId", "placementId", "claimId"]);
    text(execution.run.runId, 256);
    for (const value of [
      execution.run.toolCallId,
      execution.run.placementId,
      execution.run.claimId,
    ]) {
      if (value !== null) {
        text(value, 256);
      }
    }
  }
  // Recursively sorted closed records yield the same bytes after property reordering.
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, entry]) => [key, canonical(entry)]),
          )
        : value;
  const stableJson = JSON.stringify(canonical(stable));
  const executionJson = JSON.stringify(canonical(execution));
  if (
    Buffer.byteLength(
      stableJson + executionJson + namespace + input.key + input.operationId + input.attemptId,
      "utf8",
    ) > 7168
  ) {
    return invalid();
  }
  return {
    namespace,
    stableJson,
    executionJson,
    digest: createHash("sha256").update(stableJson).digest("hex"),
    resourceKey: `discord:guild:${intent.guildId}:explicit_content_filter`,
  };
}
