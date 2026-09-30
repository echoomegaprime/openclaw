/** Closed durable identities. None of these data records conveys authority. */
export type MessageControlPrincipal =
  | { kind: "gateway-profile"; profileId: string }
  | { kind: "gateway-system-owner" }
  | {
      kind: "discord-linked-admin";
      profileId: string;
      channelId: "discord";
      requesterAccountId: string;
      requesterSenderId: string;
    };
export type MessageControlSession =
  | { kind: "sessionless" }
  | {
      kind: "session";
      agentId: string;
      canonicalSessionKey: string;
      sessionId: string;
      lifecycleRevision: string;
    };
export type MessageControlStableBinding = {
  version: 1;
  principal: MessageControlPrincipal;
  session: MessageControlSession;
  intent: {
    action: "guild-media-filter-set-all-members";
    channelId: "discord";
    accountId: string;
    expectedBotId: string;
    guildId: string;
    expectedCurrent: 0 | 1 | 2;
    desired: 2;
  };
};
export type MessageControlExecution = {
  version: 1;
  requestId: string;
  connectionId: string;
  gatewayInstanceId: string;
  run: null | {
    runId: string;
    toolCallId: string | null;
    placementId: string | null;
    claimId: string | null;
  };
  policyFingerprint: string;
  providerRegistrationFingerprint: string;
  databaseIdentityFingerprint: string;
  databaseGeneration: { kind: "process-local"; captured: true };
  admittedAtMs: number;
};
export type MessageControlDisposition =
  | "not_entered"
  | "rejected"
  | "conflict"
  | "noop"
  | "verified_updated"
  | "unknown";
export type MessageControlRecord = {
  operationId: string;
  attemptId: string;
  namespace: string;
  key: string;
  stable: MessageControlStableBinding;
  execution: MessageControlExecution;
  phase: "prepared" | "dispatching" | "settled" | "unknown";
  held: boolean;
  result: null | { disposition: MessageControlDisposition; at: number; atomicCas: false };
  observation: null | { value: 0 | 1 | 2; at: number };
  cancelRequested: boolean;
};
export type MessageControlAdmission = {
  key: string;
  operationId: string;
  attemptId: string;
  stable: MessageControlStableBinding;
  execution: MessageControlExecution;
};
export type MessageControlAdmissionResult =
  | { disposition: "admitted" | "receipt"; record: MessageControlRecord }
  | { disposition: "conflict" | "held" | "capacity" };
export type MessageControlLocator = { namespace: string; operationId: string };
export type MessageControlAttempt = MessageControlLocator & { attemptId: string; now: number };
