/** Host-owned local MCP context. Metadata is carriage, never authentication by itself. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolRequest,
  CallToolResult,
  JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { canonicalizeConfiguredMcpServer } from "../config/mcp-config-normalize.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { McpServerSchema } from "../config/zod-schema.mcp-server.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
} from "./admitted-run-context.js";
import type { McpToolCatalogMetadata } from "./mcp-tool-metadata.js";

const MCP_LOCAL_CHANNEL_META = "io.openclaw/local-channel-context";
type Scope = {
  agentId: string;
  provider: string;
  accountId: string;
  spaceId: string;
  channelId: string;
};
export type McpLocalChannelFacts = Readonly<
  Scope & {
    senderId: string;
    eventId: string;
    eventKind: "user_request";
    sessionKey: string;
  }
>;
type Principal = {
  facts: McpLocalChannelFacts;
  sessionId: string;
  runId: string;
  assertCurrent: () => void;
};
type Designation = {
  serverName: string;
  launchFingerprint: string;
  scopes: readonly Scope[];
  assertCurrent: () => void;
};
type WireGrant = {
  transport: object;
  paramsHash: string;
  assertCurrent: () => void;
  used: boolean;
};
const principals = new WeakMap<AdmittedRunContext, Principal>();
const transports = new WeakMap<object, Designation>();
const currentPrincipal = new AsyncLocalStorage<Principal | undefined>();
const wireGrants = new AsyncLocalStorage<WireGrant>();
const log = createSubsystemLogger("mcp/local-channel-context");

class McpLocalChannelRefused extends Error {
  constructor(
    readonly category:
      | "designation_required"
      | "principal_required"
      | "scope_mismatch"
      | "authority_expired"
      | "write_not_authorized"
      | "invalid_arguments",
  ) {
    super(`local_channel_context:${category}`);
    this.name = "McpLocalChannelRefused";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}
function refuse(category: ConstructorParameters<typeof McpLocalChannelRefused>[0]): never {
  try {
    log.debug("local channel request refused", { event: "mcp.local_channel.refused", category });
  } catch {
    // Optional diagnostics cannot replace the fixed refusal or reveal a caught cause.
  }
  throw new McpLocalChannelRefused(category);
}
function safeAssertion(assertCurrent: () => void): () => void {
  let revoked = false;
  return () => {
    if (revoked) {
      refuse("authority_expired");
    }
    try {
      assertCurrent();
    } catch {
      revoked = true;
      refuse("authority_expired");
    }
  };
}

export function hasMcpLocalChannelScope(cfg: OpenClawConfig, facts: Scope): boolean {
  return resolveMcpLocalChannelScopeFingerprint(cfg, facts) !== undefined;
}

/** Pin matching designated launches, not just the tuple; fresh config cannot revive an old run. */
export function resolveMcpLocalChannelScopeFingerprint(
  cfg: OpenClawConfig,
  facts: Scope,
): string | undefined {
  const matching = Object.entries(cfg.mcp?.servers ?? {}).filter(([, server]) => {
    const parsed = McpServerSchema.safeParse(server);
    return (
      parsed.success &&
      parsed.data.enabled !== false &&
      parsed.data.localChannelContext?.scopes.some(
        (scope) =>
          scope.agentId === facts.agentId &&
          scope.provider === facts.provider &&
          scope.accountId === facts.accountId &&
          scope.spaceId === facts.spaceId &&
          scope.channelId === facts.channelId,
      ) === true
    );
  });
  return matching.length === 0
    ? undefined
    : digest(
        matching
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([name, server]) => [name, canonicalizeConfiguredMcpServer(server)]),
      );
}

/** Internal native handoff only. A real admitted run and a mandatory live source fence are required. */
export function bindMcpLocalChannelPrincipal(params: {
  context: AdmittedRunContext;
  facts: McpLocalChannelFacts;
  sessionId: string;
  assertSourceCurrent: () => void;
  signal?: AbortSignal;
}): void {
  const assertRunCurrent = resolveAdmittedRunActiveAssertion(params.context, params.signal);
  if (
    !assertRunCurrent ||
    typeof params.assertSourceCurrent !== "function" ||
    principals.has(params.context)
  ) {
    refuse("principal_required");
  }
  const facts = Object.freeze({ ...params.facts });
  if (
    facts.eventKind !== "user_request" ||
    !params.sessionId ||
    Object.values(facts).some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 256 ||
        Array.from(value).some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  ) {
    refuse("principal_required");
  }
  const assertCurrent = safeAssertion(() => {
    params.assertSourceCurrent();
    assertRunCurrent();
  });
  assertCurrent();
  principals.set(
    params.context,
    Object.freeze({
      facts,
      sessionId: params.sessionId,
      runId: params.context.operationalRunInstance.runId,
      assertCurrent,
    }),
  );
}

/** Capture once when materializing this run's tools; a retained tool cannot borrow a later run. */
export function captureMcpLocalChannelPrincipal(
  context: AdmittedRunContext | undefined,
  expected: {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
  },
): <T>(run: () => T) => T {
  const principal = context ? principals.get(context) : undefined;
  principal?.assertCurrent();
  if (
    principal &&
    (principal.facts.agentId !== expected.agentId ||
      principal.sessionId !== expected.sessionId ||
      principal.facts.sessionKey !== expected.sessionKey)
  ) {
    refuse("scope_mismatch");
  }
  return (run) => {
    principal?.assertCurrent();
    // Deliberately shadow an outer invocation even when this route has no principal.
    return currentPrincipal.run(principal, run);
  };
}

export function hasMcpLocalChannelPrincipal(context: AdmittedRunContext | undefined): boolean {
  return context !== undefined && principals.has(context);
}

/** Only exact operator config designates a pipe. Bundle metadata cannot opt itself in. */
export function bindMcpLocalChannelTransport(params: {
  transport: object;
  serverName: string;
  rawServer: unknown;
  cfg?: OpenClawConfig;
}): void {
  const servers = params.cfg?.mcp?.servers;
  const configured =
    servers && Object.hasOwn(servers, params.serverName) ? servers[params.serverName] : undefined;
  const rawOptIn = isRecord(params.rawServer) && params.rawServer.localChannelContext !== undefined;
  const ownerOptIn = isRecord(configured) && configured.localChannelContext !== undefined;
  if (!rawOptIn && !ownerOptIn) {
    return;
  }
  if (!isRecord(configured) || !isRecord(params.rawServer) || !ownerOptIn || !rawOptIn) {
    refuse("designation_required");
  }
  const parsed = McpServerSchema.safeParse(configured);
  if (!parsed.success || !parsed.data.localChannelContext || parsed.data.enabled === false) {
    refuse("designation_required");
  }
  const fingerprint = digest(canonicalizeConfiguredMcpServer(configured));
  if (digest(canonicalizeConfiguredMcpServer(params.rawServer)) !== fingerprint) {
    refuse("designation_required");
  }
  const designation: Designation = Object.freeze({
    serverName: params.serverName,
    launchFingerprint: fingerprint,
    scopes: Object.freeze(
      parsed.data.localChannelContext.scopes.map((scope) => Object.freeze({ ...scope })),
    ),
    assertCurrent: safeAssertion(() => {
      const currentServers = params.cfg?.mcp?.servers;
      const current =
        currentServers && Object.hasOwn(currentServers, params.serverName)
          ? currentServers[params.serverName]
          : undefined;
      if (!isRecord(current) || digest(canonicalizeConfiguredMcpServer(current)) !== fingerprint) {
        refuse("authority_expired");
      }
    }),
  });
  transports.set(params.transport, designation);
}

/** Issue exactly one write through the exact pipe, independently of SDK/model argument fields. */
function withMcpLocalChannelRequest<T>(params: {
  transport: object;
  request: CallToolRequest["params"];
  originalInput?: unknown;
  sessionId: string;
  sessionKey?: string;
  assertRuntimeCurrent: () => void;
  send: (request: CallToolRequest["params"]) => T;
}): T {
  const designation = transports.get(params.transport);
  if (!designation) {
    return params.send(params.request);
  }
  if (
    Object.hasOwn(params, "originalInput") &&
    params.originalInput !== undefined &&
    !isRecord(params.originalInput)
  ) {
    refuse("invalid_arguments");
  }
  const principal = currentPrincipal.getStore();
  if (!principal) {
    refuse("principal_required");
  }
  if (
    principal.sessionId !== params.sessionId ||
    principal.facts.sessionKey !== params.sessionKey ||
    !designation.scopes.some(
      (scope) =>
        scope.agentId === principal.facts.agentId &&
        scope.provider === principal.facts.provider &&
        scope.accountId === principal.facts.accountId &&
        scope.spaceId === principal.facts.spaceId &&
        scope.channelId === principal.facts.channelId,
    )
  ) {
    refuse("scope_mismatch");
  }
  const assertCurrent = safeAssertion(() => {
    designation.assertCurrent();
    principal.assertCurrent();
    params.assertRuntimeCurrent();
  });
  assertCurrent();
  const request = structuredClone(params.request);
  request._meta = {
    [MCP_LOCAL_CHANNEL_META]: {
      version: 1,
      ...principal.facts,
      sessionId: principal.sessionId,
      runId: principal.runId,
    },
  };
  const grant: WireGrant = {
    transport: params.transport,
    paramsHash: digest(request),
    assertCurrent,
    used: false,
  };
  return wireGrants.run(grant, () => params.send(request));
}

/** Called after serialization and immediately before the actual synchronous stdin.write. */
export function assertMcpLocalChannelWrite(transport: object, message: JSONRPCMessage): void {
  if (!transports.has(transport) || !("method" in message)) {
    return;
  }
  if (
    [
      "initialize",
      "notifications/initialized",
      "notifications/cancelled",
      "ping",
      "tools/list",
    ].includes(message.method)
  ) {
    return;
  }
  const grant = wireGrants.getStore();
  if (
    message.method !== "tools/call" ||
    !grant ||
    grant.transport !== transport ||
    grant.used ||
    digest(message.params) !== grant.paramsHash
  ) {
    refuse("write_not_authorized");
  }
  grant.assertCurrent();
  // Any following I/O failure has an uncertain outcome. This grant cannot replay.
  grant.used = true;
}

/** Preserve the runtime's request lifetime and result validation around the protected pipe call. */
export async function callMcpLocalChannelTool(params: {
  session: {
    transport: object;
    client: Pick<Client, "callTool">;
    requestTimeoutMs: number;
    retiring: boolean;
    toolMetadata?: Pick<McpToolCatalogMetadata, "validatorForCall">;
  };
  toolName: string;
  input: unknown;
  runtime: { sessionId: string; sessionKey?: string };
  failIfDisposed: () => void;
  isCurrent: () => boolean;
  runGuarded: <T>(request: (signal: AbortSignal) => Promise<T>) => Promise<T>;
}): Promise<CallToolResult> {
  const { session, toolName, input } = params;
  const validateResult = session.toolMetadata?.validatorForCall(toolName);
  // SDK declarations also include the compatibility union accepted by custom schemas.
  const result = (await params.runGuarded((signal) =>
    withMcpLocalChannelRequest({
      transport: session.transport,
      request: { name: toolName, arguments: isRecord(input) ? input : {} },
      originalInput: input,
      sessionId: params.runtime.sessionId,
      sessionKey: params.runtime.sessionKey,
      assertRuntimeCurrent: () => {
        params.failIfDisposed();
        if (signal.aborted || !params.isCurrent() || session.retiring) {
          throw new Error("MCP runtime is no longer current");
        }
      },
      send: (request) =>
        session.client.callTool(request, undefined, {
          timeout: session.requestTimeoutMs,
          signal,
        }),
    }),
  )) as CallToolResult; // SAFETY: SDK callTool's default schema parses CallToolResultSchema.
  validateResult?.(result);
  return result;
}
