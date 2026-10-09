import { createHash, randomUUID } from "node:crypto";
import type { MessageActionParams } from "../../packages/gateway-protocol/src/index.js";
import { createAccountActionGate } from "../channels/plugins/account-action-gate.js";
import { resolveChannelPluginRegistration } from "../channels/plugins/registry.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { resolveMergedAccountConfig } from "../config/channel-account-config.js";
import type { DiscordAccountConfig } from "../config/types.discord.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createMessageControlCapability,
  type MessageControlMode,
} from "../infra/outbound/message-control-operation.runtime.js";
import { createMessageControlStore } from "../infra/outbound/message-control-operation.store.js";
import { getPluginValueInstance } from "../plugins/plugin-instance-scope.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  prepareMessageControlAuthority,
  type MessageControlAuthority,
} from "./message-control-authority.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

export type PrepareGatewayMessageControlParams = {
  invocation: GatewayRequestHandlerOptions;
  request: MessageActionParams;
  cfg: OpenClawConfig;
  channel: string;
  plugin: ChannelPlugin;
  accountId: string | undefined;
  assertCurrent: () => void;
};

function denied(): never {
  throw new Error("Gateway message-control authority is unavailable.");
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readMode(values: Record<string, unknown>): MessageControlMode {
  const mode = values.controlMode === undefined ? "apply" : values.controlMode;
  if (mode === "apply") {
    if (values.operationId !== undefined) {
      denied();
    }
    return { mode };
  }
  if (
    (mode !== "read" && mode !== "reconcile" && mode !== "cancel") ||
    typeof values.operationId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(values.operationId)
  ) {
    denied();
  }
  return { mode, operationId: values.operationId };
}

/** Core preparation creates no grant; it composes current existing owners. */
export async function prepareGatewayMessageControl(params: PrepareGatewayMessageControlParams) {
  let authority: MessageControlAuthority | undefined;
  let issued: ReturnType<typeof createMessageControlCapability> | undefined;
  let closed = false;
  let invalidated = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      issued?.close();
    } finally {
      authority?.release();
    }
  };
  try {
    const { invocation, request, cfg, channel, plugin, accountId } = params;
    const context = invocation.context;
    const gatewayInstanceId = context.gatewayInstanceId;
    if (
      request.action !== "guild-media-filter-set-all-members" ||
      channel !== "discord" ||
      plugin.id !== "discord" ||
      !accountId ||
      accountId !== normalizeAccountId(accountId) ||
      typeof params.assertCurrent !== "function" ||
      typeof gatewayInstanceId !== "string" ||
      !gatewayInstanceId.trim()
    ) {
      denied();
    }
    const mode = readMode(request.params);
    const expectedCurrent = mode.mode === "apply" ? request.params.expectedCurrent : 0;
    if (expectedCurrent !== 0 && expectedCurrent !== 1 && expectedCurrent !== 2) {
      denied();
    }
    const { expectedBotId, guildId } = request.params;
    if (typeof expectedBotId !== "string" || typeof guildId !== "string") {
      denied();
    }
    const policy = (config: OpenClawConfig) => {
      const channelConfig = config.channels?.discord;
      const accountConfig = resolveAccountEntry(channelConfig?.accounts, accountId);
      const merged = resolveMergedAccountConfig<DiscordAccountConfig>({
        channelConfig,
        accounts: channelConfig?.accounts,
        accountId,
        channelId: "discord",
      });
      const binding = merged.guildMediaFilter;
      const enabled = createAccountActionGate({
        baseActions: channelConfig?.actions,
        accountActions: accountConfig?.actions,
      })("guildMediaFilter", false);
      if (
        channelConfig?.enabled === false ||
        merged.enabled === false ||
        !enabled ||
        !binding ||
        binding.accountId !== accountId ||
        binding.botId !== expectedBotId ||
        !binding.guildIds.includes(guildId) ||
        (mode.mode === "apply" && binding.allowSetAllMembers !== true)
      ) {
        denied();
      }
      return hash([
        channel,
        accountId,
        enabled,
        binding.accountId,
        binding.botId,
        binding.guildIds.toSorted(),
        binding.allowSetAllMembers === true,
        config.channels?.defaults?.groupPolicy,
        merged.groupPolicy,
        merged.guilds,
      ]);
    };
    const policyFingerprint = policy(cfg);
    const readConfig = () => context.getCommittedRuntimeConfig?.() ?? context.getRuntimeConfig();
    const committedConfig = readConfig();
    if (policy(committedConfig) !== policyFingerprint) {
      denied();
    }
    const registration = resolveChannelPluginRegistration(channel, { loadedOnly: true });
    const registrationCurrent = registration?.captureReadAuthority?.();
    const instance = getPluginValueInstance(plugin);
    const sourceDigest = instance?.sourceDigest;
    if (
      registration?.plugin !== plugin ||
      !registrationCurrent ||
      !instance ||
      !instance.acceptingCalls ||
      typeof sourceDigest !== "string" ||
      !sourceDigest.trim()
    ) {
      denied();
    }
    const providerRegistrationFingerprint = hash([
      channel,
      instance.pluginId,
      registration.origin ?? null,
      sourceDigest,
    ]);
    // The existing state owner captures the physical store and generation before any await.
    const state = captureOpenClawStateWorkerContext();
    const stateOptions = { path: state.admission.databasePath, env: state.environment };
    const assertCurrent = () => {
      if (closed || invalidated) {
        denied();
      }
      try {
        params.assertCurrent();
        state.admission.assertCurrent();
        authority?.assertCurrent();
        const current = resolveChannelPluginRegistration(channel, { loadedOnly: true });
        if (
          invocation.context !== context ||
          context.gatewayInstanceId !== gatewayInstanceId ||
          !registrationCurrent() ||
          current?.plugin !== plugin ||
          current.origin !== registration.origin ||
          getPluginValueInstance(plugin) !== instance ||
          !instance.acceptingCalls ||
          instance.sourceDigest !== sourceDigest ||
          readConfig() !== committedConfig ||
          policy(committedConfig) !== policyFingerprint
        ) {
          denied();
        }
      } catch {
        invalidated = true;
        denied();
      }
    };
    assertCurrent();
    const store = createMessageControlStore({ stateOptions, assertCurrent });
    authority = await prepareMessageControlAuthority({
      invocation,
      request,
      accountId,
      stateOptions,
      assertCurrent: params.assertCurrent,
    });
    assertCurrent();
    issued = createMessageControlCapability({
      admission: {
        key: request.idempotencyKey,
        operationId: randomUUID(),
        attemptId: randomUUID(),
        stable: {
          version: 1,
          principal: authority.principal,
          session: authority.session,
          intent: {
            action: "guild-media-filter-set-all-members",
            channelId: "discord",
            accountId,
            expectedBotId,
            guildId,
            expectedCurrent,
            desired: 2,
          },
        },
        execution: {
          version: 1,
          ...authority.execution,
          gatewayInstanceId,
          policyFingerprint,
          providerRegistrationFingerprint,
          databaseIdentityFingerprint: store.databaseIdentityFingerprint,
          databaseGeneration: { kind: "process-local", captured: true },
          admittedAtMs: Date.now(),
        },
      },
      store,
      assertCurrent,
      mode,
    });
    return { controlOperation: issued.capability, assertCurrent, close };
  } catch {
    close();
    return denied();
  }
}
