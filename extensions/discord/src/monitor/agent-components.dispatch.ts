import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createCommandTurnContext,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
  runChannelInboundEvent,
} from "openclaw/plugin-sdk/channel-inbound";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { logError } from "openclaw/plugin-sdk/logging-core";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { createNonExitingRuntime, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import { createDiscordRestClient } from "../client.js";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import {
  resolveAgentComponentRoute,
  resolveComponentCommandAuthorized,
  resolvePinnedMainDmOwnerFromAllowlist,
  type AgentComponentContext,
  type AgentComponentInteraction,
  type ComponentInteractionContext,
  type DiscordChannelContext,
} from "./agent-components-helpers.js";
import { readSessionUpdatedAt, resolveStorePath } from "./agent-components.deps.runtime.js";
import {
  normalizeDiscordAllowList,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
} from "./allow-list.js";
import { formatDiscordUserTag } from "./format.js";
import {
  buildDiscordGroupSystemPrompt,
  buildDiscordInboundAccessContext,
} from "./inbound-context.js";
import { discordIngressIdentity } from "./ingress-identity.js";
import { buildDirectLabel, buildGuildLabel } from "./reply-context.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import { buildDiscordConversationRouteContext } from "./route-resolution.js";

const loadConversationRuntime = createLazyRuntimeModule(
  () => import("./agent-components.runtime.js"),
);

const loadTypingRuntime = createLazyRuntimeModule(() => import("./typing.js"));

function buildDiscordComponentConversationLabel(params: {
  interactionCtx: ComponentInteractionContext;
  interaction: AgentComponentInteraction;
  channelCtx: DiscordChannelContext;
}) {
  if (params.interactionCtx.isDirectMessage) {
    return buildDirectLabel(params.interactionCtx.user);
  }
  if (params.interactionCtx.isGroupDm) {
    return `Group DM #${params.channelCtx.channelName ?? params.interactionCtx.channelId} channel id:${params.interactionCtx.channelId}`;
  }
  return buildGuildLabel({
    guild: params.interaction.guild ?? undefined,
    channelName: params.channelCtx.channelName ?? params.interactionCtx.channelId,
    channelId: params.interactionCtx.channelId,
  });
}

function resolveDiscordComponentChatType(interactionCtx: ComponentInteractionContext) {
  if (interactionCtx.isDirectMessage) {
    return "direct";
  }
  if (interactionCtx.isGroupDm) {
    return "group";
  }
  return "channel";
}

function resolveDiscordComponentOriginatingTo(
  interactionCtx: Pick<ComponentInteractionContext, "isDirectMessage" | "userId" | "channelId">,
) {
  return resolveDiscordConversationIdentity({
    isDirectMessage: interactionCtx.isDirectMessage,
    userId: interactionCtx.userId,
    channelId: interactionCtx.channelId,
  });
}

export async function dispatchDiscordComponentEvent(params: {
  ctx: AgentComponentContext;
  interaction: AgentComponentInteraction;
  interactionCtx: ComponentInteractionContext;
  channelCtx: DiscordChannelContext;
  guildInfo: ReturnType<typeof resolveDiscordGuildEntry>;
  eventText: string;
  commandSource?: "native";
  replyToId?: string;
  routeOverrides?: { sessionKey?: string; agentId?: string; accountId?: string };
}): Promise<void> {
  const { ctx, interaction, interactionCtx, channelCtx, guildInfo, eventText } = params;
  // Snapshot the authenticated interaction before asynchronous context work. The shared
  // form's message id is a reply reference, never this submission's identity.
  const native = Object.freeze({
    eventId: interaction.rawData.id,
    senderId: interactionCtx.userId,
    accountId: ctx.accountId,
    channelId: interactionCtx.channelId,
    spaceId: interactionCtx.rawGuildId,
  });
  const runtime = ctx.runtime ?? createNonExitingRuntime();
  const route = resolveAgentComponentRoute({
    ctx,
    rawGuildId: interactionCtx.rawGuildId,
    memberRoleIds: interactionCtx.memberRoleIds,
    isDirectMessage: interactionCtx.isDirectMessage,
    isGroupDm: interactionCtx.isGroupDm,
    userId: interactionCtx.userId,
    channelId: interactionCtx.channelId,
    parentId: channelCtx.parentId,
  });
  const sessionKey = params.routeOverrides?.sessionKey ?? route.sessionKey;
  const agentId = params.routeOverrides?.agentId ?? route.agentId;
  const accountId = params.routeOverrides?.accountId ?? route.accountId;
  const inboundLastRouteSessionKey = sessionKey;
  const fromLabel = buildDiscordComponentConversationLabel({
    interactionCtx,
    interaction,
    channelCtx,
  });
  const chatType = resolveDiscordComponentChatType(interactionCtx);
  const senderName = interactionCtx.user.globalName ?? interactionCtx.user.username;
  const senderUsername = interactionCtx.user.username;
  const senderTag = formatDiscordUserTag(interactionCtx.user);
  const groupChannel =
    !interactionCtx.isDirectMessage && channelCtx.displayChannelSlug
      ? `#${channelCtx.displayChannelSlug}`
      : undefined;
  const groupSubject = interactionCtx.isDirectMessage ? undefined : groupChannel;
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo,
    channelId: interactionCtx.channelId,
    channelName: channelCtx.channelName,
    channelSlug: channelCtx.channelSlug,
    parentId: channelCtx.parentId,
    parentName: channelCtx.parentName,
    parentSlug: channelCtx.parentSlug,
    scope: channelCtx.isThread ? "thread" : "channel",
  });
  const allowNameMatching = isDangerousNameMatchingEnabled(ctx.discordConfig);
  const { ownerAllowFrom } = buildDiscordInboundAccessContext({
    channelConfig,
    guildInfo,
    sender: { id: interactionCtx.user.id, name: interactionCtx.user.username, tag: senderTag },
    allowNameMatching,
    isGuild: !interactionCtx.isDirectMessage,
  });
  const groupSystemPrompt = buildDiscordGroupSystemPrompt(channelConfig);
  const pinnedMainDmOwner = interactionCtx.isDirectMessage
    ? resolvePinnedMainDmOwnerFromAllowlist({
        dmScope: ctx.cfg.session?.dmScope,
        allowFrom: channelConfig?.users ?? guildInfo?.users,
        normalizeEntry: (entry: string) => {
          const normalized = normalizeDiscordAllowList([entry], ["discord:", "user:", "pk:"]);
          const candidate = normalized?.ids.values().next().value;
          return typeof candidate === "string" && /^\d+$/.test(candidate) ? candidate : undefined;
        },
      })
    : null;
  const commandAuthorized = await resolveComponentCommandAuthorized({
    ctx,
    interactionCtx,
    channelConfig,
    guildInfo,
    allowNameMatching,
  });
  const storePath = resolveStorePath(ctx.cfg.session?.store, { agentId });
  const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey,
  });
  const timestamp = Date.now();
  const combinedBody = formatInboundEnvelope({
    channel: "Discord",
    from: fromLabel,
    timestamp,
    body: eventText,
    chatType,
    senderLabel: senderName,
    previousTimestamp,
    envelope: envelopeOptions,
  });

  const {
    createReplyReferencePlanner,
    finalizeInboundContext,
    resolveChunkMode,
    resolveTextChunkLimit,
  } = await (async () => {
    const conversationRuntime = await loadConversationRuntime();
    return {
      ...conversationRuntime,
    };
  })();

  let ctxPayload: FinalizedMsgContext & { From: string; To: string } = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: eventText,
    RawBody: eventText,
    CommandBody: eventText,
    From: interactionCtx.isDirectMessage
      ? `discord:${interactionCtx.userId}`
      : interactionCtx.isGroupDm
        ? `discord:group:${interactionCtx.channelId}`
        : `discord:channel:${interactionCtx.channelId}`,
    To: `channel:${interactionCtx.channelId}`,
    SessionKey: sessionKey,
    AccountId: accountId,
    ChatType: chatType,
    ...buildDiscordConversationRouteContext({
      isDirectMessage: interactionCtx.isDirectMessage,
      isGroupDm: interactionCtx.isGroupDm,
      directUserId: interactionCtx.userId,
      conversationId: interactionCtx.channelId,
      isThread: channelCtx.isThread,
      parentConversationId: channelCtx.parentId,
    }),
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: interactionCtx.userId,
    SenderUsername: senderUsername,
    SenderTag: senderTag,
    GroupSubject: groupSubject,
    GroupChannel: groupChannel,
    MemberRoleIds: interactionCtx.memberRoleIds,
    GroupSystemPrompt: interactionCtx.isDirectMessage ? undefined : groupSystemPrompt,
    GroupSpace: guildInfo?.id ?? guildInfo?.slug ?? interactionCtx.rawGuildId ?? undefined,
    OwnerAllowFrom: ownerAllowFrom,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: true,
    CommandAuthorized: commandAuthorized,
    CommandTurn: createCommandTurnContext(params.commandSource ?? "text", {
      authorized: commandAuthorized,
      body: eventText,
    }),
    CommandSource: params.commandSource ?? "text",
    MessageSid: interaction.rawData.id,
    Timestamp: timestamp,
    OriginatingChannel: "discord" as const,
    OriginatingTo:
      resolveDiscordComponentOriginatingTo(interactionCtx) ?? `channel:${interactionCtx.channelId}`,
  });

  if (ctx.channelRuntime && accountId === native.accountId) {
    if (ctx.isPolicyCurrent?.() === false) {
      throw new Error("discord component policy expired");
    }
    // The component handler already checked current room/member and form access.
    // Reuse the host's native identity handoff; this does not grant command-owner
    // or moderator authority. The protected MCP scope remains a separate opt-in.
    const allowedSender = [`user:${native.senderId}`];
    const channelIngress = await ctx.channelRuntime.inbound.ingress
      .createResolver({
        channelId: "discord",
        accountId: native.accountId,
        identity: discordIngressIdentity,
        useDefaultPairingStore: false,
      })
      .message({
        subject: { stableId: native.senderId, aliases: { participantKind: "user" } },
        conversation: {
          kind: chatType,
          id: native.channelId,
          ...(channelCtx.isThread
            ? { parentId: channelCtx.parentId, threadId: native.channelId }
            : {}),
        },
        contextBinding: {
          agentId,
          sessionKey,
          nativeChannelId: native.channelId,
          messageId: native.eventId,
          inboundEventKind: "user_request",
        },
        dmPolicy: "allowlist",
        groupPolicy: "allowlist",
        allowFrom: allowedSender,
        groupAllowFrom: allowedSender,
        event: { mayPair: false },
      });
    if (ctx.isPolicyCurrent?.() === false) {
      throw new Error("discord component policy expired");
    }
    if (channelIngress.ingress.admission !== "dispatch") {
      return;
    }
    ctxPayload = ctx.channelRuntime.inbound.buildContext({
      channel: "discord",
      accountId: native.accountId,
      channelIngress,
      messageId: native.eventId,
      timestamp,
      from: ctxPayload.From,
      sender: {
        id: native.senderId,
        name: senderName,
        username: senderUsername,
        tag: senderTag,
        roles: interactionCtx.memberRoleIds,
      },
      conversation: {
        kind: chatType,
        id: native.channelId,
        nativeChannelId: native.channelId,
        spaceId: native.spaceId,
      },
      route: { agentId, routeSessionKey: sessionKey },
      reply: { to: ctxPayload.To },
      message: {
        rawBody: eventText,
        body: combinedBody,
        bodyForAgent: eventText,
        commandBody: eventText,
        inboundEventKind: "user_request",
      },
      commandTurn: ctxPayload.CommandTurn,
      // Preserve ordinary component formatting/routing while binding native identity outside text.
      extra: {
        ...ctxPayload,
        AccountId: native.accountId,
        SenderId: native.senderId,
        MessageSid: native.eventId,
        GroupSpace: native.spaceId,
      },
    });
    if (ctx.isPolicyCurrent?.() === false) {
      throw new Error("discord component policy expired");
    }
  }

  const deliverTarget = `channel:${interactionCtx.channelId}`;
  const typingChannelId = interactionCtx.channelId;
  const tableMode = resolveMarkdownTableMode({
    cfg: ctx.cfg,
    channel: "discord",
    accountId,
  });
  const textLimit = resolveTextChunkLimit(ctx.cfg, "discord", accountId, {
    fallbackLimit: 2000,
  });
  const token = ctx.token ?? "";
  const feedbackRest = createDiscordRestClient({
    cfg: ctx.cfg,
    token,
    accountId,
  }).rest;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(ctx.cfg, agentId);
  const replyToMode =
    ctx.discordConfig?.replyToMode ?? ctx.cfg.channels?.discord?.replyToMode ?? "off";
  const replyReference = createReplyReferencePlanner({
    replyToMode,
    startId: params.replyToId,
  });

  await runChannelInboundEvent({
    channel: "discord",
    accountId,
    raw: interaction,
    adapter: {
      ingest: () => ({
        id: interaction.id,
        rawText: ctxPayload.RawBody ?? "",
        textForAgent: ctxPayload.BodyForAgent,
        textForCommands: ctxPayload.CommandBody,
        raw: interaction,
      }),
      resolveTurn: () => ({
        cfg: ctx.cfg,
        channel: "discord",
        accountId,
        route: { agentId, sessionKey },
        ctxPayload,
        // Forward the owning runtime's bound dispatcher into the turn plan; never invoked here.
        dispatchReplyFromConfig: ctx.channelRuntime?.reply?.dispatchReplyFromConfig,
        record: {
          updateLastRoute: interactionCtx.isDirectMessage
            ? {
                sessionKey: inboundLastRouteSessionKey,
                channel: "discord",
                to:
                  resolveDiscordComponentOriginatingTo(interactionCtx) ??
                  `user:${interactionCtx.userId}`,
                accountId,
                mainDmOwnerPin:
                  inboundLastRouteSessionKey === route.mainSessionKey && pinnedMainDmOwner
                    ? {
                        ownerRecipient: pinnedMainDmOwner,
                        senderRecipient: interactionCtx.userId,
                        onSkip: ({ ownerRecipient, senderRecipient }) => {
                          logVerbose(
                            `discord: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                          );
                        },
                      }
                    : undefined,
              }
            : undefined,
          onRecordError: (err) => {
            logVerbose(`discord: failed updating component session meta: ${String(err)}`);
          },
        },
        delivery: {
          deliverWithProviderMessageSending: async (payload, info) => {
            const replyToId = replyReference.use();
            const result = await deliverDiscordReply({
              cfg: ctx.cfg,
              replies: [payload],
              target: deliverTarget,
              token,
              accountId,
              rest: interaction.client.rest,
              runtime,
              replyToId,
              replyToMode,
              textLimit,
              maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
                cfg: ctx.cfg,
                discordConfig: ctx.discordConfig,
                accountId,
              }),
              tableMode,
              chunkMode: resolveChunkMode(ctx.cfg, "discord", accountId),
              mediaLocalRoots,
              kind: info.kind,
              bindPendingFinalDelivery: info.bindPendingFinalDelivery,
              onPlatformSendDispatch: info.onPlatformSendDispatch,
              assertPlatformSendAuthorized: info.assertPlatformSendAuthorized,
            });
            if (result.visibleReplySent) {
              replyReference.markSent();
            }
            return result;
          },
          onError: (err) => {
            logError(`discord component dispatch failed: ${String(err)}`);
          },
        },
        replyPipeline: {},
        dispatcherOptions: {
          humanDelay: resolveHumanDelayConfig(ctx.cfg, agentId),
          onReplyStart: async () => {
            try {
              const { sendTyping } = await loadTypingRuntime();
              await sendTyping({ rest: feedbackRest, channelId: typingChannelId });
            } catch (err) {
              logVerbose(`discord: typing failed for component reply: ${String(err)}`);
            }
          },
        },
      }),
    },
  });
}
