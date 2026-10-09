import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, expect, it, vi } from "vitest";
import { createComponentButtonInteraction } from "../test-support/component-interactions.test-support.js";
import {
  dispatchReplyMock,
  resetDiscordComponentRuntimeMocks,
} from "../test-support/component-runtime.js";
import { dispatchDiscordComponentEvent } from "./agent-components.dispatch.js";
import type { AgentComponentInteraction } from "./agent-components.types.js";

beforeEach(() => {
  resetDiscordComponentRuntimeMocks();
  dispatchReplyMock.mockResolvedValue({
    queuedFinal: false,
    counts: { final: 0, block: 0, tool: 0 },
  });
});

it("passes the submitted interaction identity to the owning host context builder", async () => {
  const ingress = { ingress: { admission: "dispatch" } };
  const message = vi.fn().mockResolvedValue(ingress);
  const buildContext = vi.fn((params) => ({ ...params.extra }));
  const channelRuntime = createPluginRuntimeMock({
    channel: {
      inbound: {
        buildContext,
        ingress: {
          createResolver: vi.fn(() => ({
            message,
            command: vi.fn(),
            event: vi.fn(),
          })),
        },
      },
    },
  }).channel;
  const interaction = {
    id: "9001",
    rawData: { id: "9001" },
    guild: { id: "100", name: "Fixture" },
    client: { rest: {} },
  } as AgentComponentInteraction;
  const user = createComponentButtonInteraction({}, "42").interaction.user;
  if (!user) {
    throw new Error("expected isolated interaction user");
  }
  await dispatchDiscordComponentEvent({
    ctx: {
      cfg: {},
      accountId: "fixture",
      channelRuntime,
      token: "fixture-not-a-real-token",
      discordConfig: { replyToMode: "off" },
    },
    interaction,
    interactionCtx: {
      channelId: "101",
      user,
      username: "Fixture",
      userId: "42",
      replyOpts: {},
      rawGuildId: "100",
      isDirectMessage: false,
      isGroupDm: false,
      memberRoleIds: [],
    },
    channelCtx: {
      channelName: "reports",
      channelSlug: "reports",
      displayChannelSlug: "reports",
      channelType: 0,
      isThread: false,
      parentId: undefined,
      parentName: undefined,
      parentSlug: "",
    },
    guildInfo: { id: "100" },
    eventText: "PRIVATE_REPORT",
    replyToId: "8000",
    routeOverrides: { agentId: "desk", accountId: "fixture", sessionKey: "fixture-key" },
  });
  expect(message).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      subject: { stableId: "42", aliases: { participantKind: "user" } },
      contextBinding: {
        agentId: "desk",
        sessionKey: "fixture-key",
        nativeChannelId: "101",
        messageId: "9001",
        inboundEventKind: "user_request",
      },
    }),
  );
  expect(buildContext).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      channelIngress: ingress,
      accountId: "fixture",
      messageId: "9001",
      sender: expect.objectContaining({ id: "42" }),
      conversation: expect.objectContaining({ nativeChannelId: "101", spaceId: "100" }),
    }),
  );
  expect(buildContext.mock.calls[0]?.[0].messageId).not.toBe("8000");
});
