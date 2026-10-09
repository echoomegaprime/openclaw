import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import {
  captureMcpLocalChannelPrincipal,
  hasMcpLocalChannelPrincipal,
} from "../../agents/mcp-local-channel-context.js";
import type { FollowupRun } from "../../auto-reply/reply/queue/types.js";
import { createContext as createGatewayFixture } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { buildChannelInboundEventContext } from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import { copyChannelParticipantAdmissionEvidence } from "./admission-evidence.js";
import {
  bindLocalChannelFollowup,
  bindLocalChannelFollowupAdmission,
} from "./local-channel-principal.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

describe("native local channel principal custody", () => {
  it.each([
    "normal",
    "plain-copy",
    "explicit-copy",
    "changed-room",
    "stale-owner",
    "restart",
    "aggregate",
    "repeat-admission",
    "revoked-after-admission",
    "mutated-event-during-build",
    "changed-launch-after-admission",
    "runtime-policy-replaced",
    "bot",
    "proxy-member",
    "not-designated",
  ])("preserves the boundary for %s", async (scenario) => {
    await withOpenClawTestState({ prefix: "mcp-local-principal-" }, async (state) => {
      let live = true;
      const scope = {
        agentId: "desk",
        provider: "discord",
        accountId: "fixture",
        spaceId: "100",
        channelId: "101",
      };
      const cfg = {
        mcp: {
          servers: {
            owned: {
              enabled: scenario !== "not-designated",
              command: process.execPath,
              args: [] as string[],
              cwd: path.resolve("."),
              transport: "stdio" as const,
              localChannelContext: { version: 1 as const, scopes: [scope] },
            },
          },
        },
      };
      // This isolated fixture supplies the only gateway operation consumed by this host handoff.
      let runtimeCfg = cfg;
      const gateway = createGatewayFixture();
      gateway.getRuntimeConfig = () => runtimeCfg;
      const owner = {
        channelId: "discord",
        isLive: () => live,
        resolveGatewayContext: () => gateway,
      };
      const ingress = await createHostChannelIngressRuntime(owner).resolveStable({
        channelId: "discord",
        accountId: "fixture",
        identity: {
          authentication: "verified",
          resolveParticipant: (subject) => ({
            domain: scenario === "proxy-member" ? "pluralkit" : "discord",
            idKind: scenario === "bot" ? "bot" : "user",
            id: String(subject.stableId),
          }),
        },
        subject: { stableId: "42", authentication: { stableId: "verified" } },
        conversation: { kind: "channel", id: "101" },
        contextBinding: {
          agentId: "desk",
          sessionKey: "fixture-key",
          messageId: "9001",
          nativeChannelId: "101",
          inboundEventKind: "user_request",
        },
        dmPolicy: "disabled",
        groupPolicy: "open",
        useDefaultPairingStore: false,
      });
      expect(ingress.ingress.admission).toBe("dispatch");
      const build = async (params: Parameters<typeof buildChannelInboundEventContext>[0]) => {
        if (scenario === "mutated-event-during-build") {
          await Promise.resolve();
          params.messageIdFull = "9002";
        }
        return buildChannelInboundEventContext(params);
      };
      const context = await createHostChannelInboundEventContextBuilder(
        build,
        owner,
      )({
        channel: "discord",
        accountId: "fixture",
        messageId: "9001",
        messageIdFull: "9001",
        from: "discord:channel:101",
        sender: { id: "42" },
        conversation: { kind: "channel", id: "101", nativeChannelId: "101", spaceId: "100" },
        route: { agentId: "desk", routeSessionKey: "fixture-key" },
        reply: { to: "channel:101" },
        message: { rawBody: "PRIVATE_REPORT", inboundEventKind: "user_request" },
        channelIngress: ingress,
      });
      const source =
        scenario.includes("copy") || scenario === "changed-room" ? { ...context } : context;
      if (scenario === "explicit-copy") {
        copyChannelParticipantAdmissionEvidence(context, source);
      }
      if (scenario === "changed-room") {
        source.NativeChannelId = "102";
        copyChannelParticipantAdmissionEvidence(context, source);
      }
      const followup: FollowupRun = {
        prompt: "PRIVATE_REPORT",
        messageId: scenario === "mutated-event-during-build" ? "9002" : "9001",
        enqueuedAt: Date.now(),
        originatingChatId: "101",
        originatingChannel: "discord",
        run: {
          agentId: "desk",
          agentDir: state.agentDir(),
          sessionId: "fixture-session",
          sessionKey: "fixture-key",
          sessionFile: state.path("session.jsonl"),
          workspaceDir: state.workspaceDir,
          config: cfg,
          provider: "fixture",
          model: "fixture",
          timeoutMs: 1000,
          blockReplyBreak: "text_end",
          senderId: "42",
          agentAccountId: "fixture",
          groupSpace: "100",
        },
      };
      if (scenario === "stale-owner") {
        live = false;
      }
      if (scenario === "stale-owner") {
        expect(() => bindLocalChannelFollowup(source, followup, cfg)).toThrow("authority_expired");
        return;
      }
      const bound = bindLocalChannelFollowup(source, followup, cfg);
      expect(bound).toBe(
        ![
          "plain-copy",
          "changed-room",
          "mutated-event-during-build",
          "bot",
          "proxy-member",
          "not-designated",
        ].includes(scenario),
      );
      if (!bound) {
        return;
      }
      const serializedFollowup = JSON.stringify(followup);
      const candidate: FollowupRun =
        scenario === "restart"
          ? JSON.parse(serializedFollowup)
          : scenario === "aggregate"
            ? { ...followup }
            : followup;
      const prepared = prepareAgentRunAdmission({
        cfg: {},
        facts: {
          runId: "fixture-run",
          agentId: "desk",
          ingress: { kind: "channel", boundary: "fixture", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef("fixture-run"),
        onAdmitted: (admitted) => bindLocalChannelFollowupAdmission(candidate, admitted),
      });
      try {
        const admitted = await prepared.admit("embedded");
        expect(hasMcpLocalChannelPrincipal(admitted)).toBe(
          !["restart", "aggregate"].includes(scenario),
        );
        if (scenario === "repeat-admission") {
          expect(() => bindLocalChannelFollowupAdmission(candidate, admitted)).toThrow(
            "authority_expired",
          );
        }
        if (
          scenario === "revoked-after-admission" ||
          scenario === "changed-launch-after-admission" ||
          scenario === "runtime-policy-replaced"
        ) {
          const run = captureMcpLocalChannelPrincipal(admitted, {
            agentId: "desk",
            sessionId: "fixture-session",
            sessionKey: "fixture-key",
          });
          if (scenario === "revoked-after-admission") {
            live = false;
          } else if (scenario === "runtime-policy-replaced") {
            runtimeCfg = { ...cfg };
          } else {
            cfg.mcp.servers.owned = { ...cfg.mcp.servers.owned, args: ["changed-entrypoint"] };
          }
          expect(() => run(() => undefined)).toThrow("authority_expired");
          if (scenario === "runtime-policy-replaced") {
            runtimeCfg = cfg;
            expect(() => run(() => undefined)).toThrow("authority_expired");
          }
        }
      } finally {
        prepared.close();
      }
    });
  });
});
