import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { DispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.types.js";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import { buildChannelInboundEventContext } from "../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
import {
  bindLocalChannelFollowup,
  bindLocalChannelFollowupAdmission,
} from "../channels/message-access/local-channel-principal.js";
import { createHostChannelIngressRuntime } from "../channels/message-access/runtime.js";
import { createContext as createGatewayFixture } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import type { ChannelMessageActionContext } from "../plugin-sdk/channel-contract.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import { createSessionMcpRuntime } from "./agent-bundle-mcp-runtime.js";
import { createOwnedContextBuilder } from "./mcp-local-channel-context.test-support.js";

it.each(["response", "lost-response"])(
  "carries native ownership through an owned SDK pipe: %s",
  async (outcome) => {
    await withOpenClawTestState({ prefix: "local-context-pipe-" }, async (state) => {
      const serverPath = state.path("consumer.mjs");
      const receivedPath = state.path("received.jsonl");
      await fs.writeFile(
        serverPath,
        `import readline from "node:readline";
import fs from "node:fs";
for await (const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line); let result;
 if(m.method==="initialize") result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"owned-fixture",version:"1"}};
 if(m.method==="tools/list") result={tools:[{name:"submit",inputSchema:{type:"object",properties:{summary:{type:"string"}}}},{name:"hidden",inputSchema:{type:"object"}}]};
 if(m.method==="tools/call") {
  fs.appendFileSync(process.argv[2],JSON.stringify(m.params)+"\\n");
  if(m.params.arguments?.summary==="DROP_RESPONSE") process.exit(0);
  result={content:[{type:"text",text:JSON.stringify({ticket:"OPS-0001",status:"Awaiting review"})}]};
 }
 if(result) process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");
}`,
      );
      let live = true;
      const scope = {
        agentId: "desk",
        provider: "discord",
        accountId: "fixture",
        spaceId: "100",
        channelId: "101",
      };
      const cfg = {
        plugins: { enabled: false },
        mcp: {
          servers: {
            owned: {
              command: process.execPath,
              args: [serverPath, receivedPath],
              cwd: state.workspaceDir,
              transport: "stdio" as const,
              toolFilter: { include: ["submit"] },
              localChannelContext: { version: 1 as const, scopes: [scope] },
            },
          },
        },
      };
      const gateway = createGatewayFixture();
      gateway.getRuntimeConfig = () => cfg;
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
            domain: "discord",
            idKind: "user",
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
      const context = await createHostChannelInboundEventContextBuilder(
        buildChannelInboundEventContext,
        owner,
      )({
        channel: "discord",
        accountId: "fixture",
        messageId: "9001",
        from: "discord:channel:101",
        sender: { id: "42" },
        conversation: { kind: "channel", id: "101", nativeChannelId: "101", spaceId: "100" },
        route: { agentId: "desk", routeSessionKey: "fixture-key" },
        reply: { to: "channel:101" },
        message: { rawBody: "PRIVATE_REPORT", inboundEventKind: "user_request" },
        channelIngress: ingress,
      });
      const followup: FollowupRun = {
        prompt: "PRIVATE_REPORT",
        messageId: "9001",
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
      expect(bindLocalChannelFollowup(context, followup, cfg)).toBe(true);
      const admission = prepareAgentRunAdmission({
        cfg: {},
        facts: {
          runId: "fixture-run",
          agentId: "desk",
          ingress: { kind: "channel", boundary: "fixture", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef("fixture-run"),
        onAdmitted: (admitted) => bindLocalChannelFollowupAdmission(followup, admitted),
      });
      const runtime = createSessionMcpRuntime({
        sessionId: "fixture-session",
        sessionKey: "fixture-key",
        workspaceDir: state.workspaceDir,
        agentDir: state.agentDir(),
        cfg,
        manifestRegistry: { plugins: [] },
      });
      try {
        const admittedRunContext = await admission.admit("embedded");
        const view = await materializeBundleMcpToolsForRun({
          runtime,
          agentId: "desk",
          admittedRunContext,
        });
        expect(view.tools.map((tool) => tool.name)).toEqual(["owned__submit"]);
        const tool = view.tools[0];
        if (!tool) {
          throw new Error("expected protected consumer tool");
        }
        if (outcome === "lost-response") {
          await expect(tool.execute("uncertain", { summary: "DROP_RESPONSE" })).rejects.toThrow();
          expect((await fs.readFile(receivedPath, "utf8")).trim().split("\n")).toHaveLength(1);
          await view.dispose();
          return;
        }
        const result = await tool.execute("call-1", { summary: "PRIVATE_REPORT" });
        expect(JSON.stringify(result)).not.toContain("PRIVATE_REPORT");
        expect(JSON.stringify(result)).not.toContain("fixture-session");
        const messages = (await fs.readFile(receivedPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(messages).toHaveLength(1);
        expect(messages[0].arguments).toEqual({ summary: "PRIVATE_REPORT" });
        expect(messages[0]._meta["io.openclaw/local-channel-context"]).toEqual({
          version: 1,
          ...scope,
          senderId: "42",
          eventId: "9001",
          eventKind: "user_request",
          sessionKey: "fixture-key",
          sessionId: "fixture-session",
          runId: "fixture-run",
        });
        await expect(tool.execute("malformed", null)).rejects.toThrow("invalid_arguments");
        await expect(runtime.callTool("owned", "submit", { summary: "BYPASS" })).rejects.toThrow(
          "principal_required",
        );
        const callTool = runtime.callTool.bind(runtime);
        vi.spyOn(runtime, "callTool").mockImplementationOnce(async (...args) => {
          const lateResult = await callTool(...args);
          live = false;
          return lateResult;
        });
        await expect(tool.execute("late-result", { summary: "PRIVATE_LATE" })).rejects.toThrow(
          "authority_expired",
        );
        await expect(async () => tool.execute("call-2", { summary: "RETAINED" })).rejects.toThrow(
          "authority_expired",
        );
        expect((await fs.readFile(receivedPath, "utf8")).trim().split("\n")).toHaveLength(2);
        await view.dispose();
      } finally {
        admission.close();
        await runtime.dispose();
        await runtime.joinCleanup?.();
      }
    });
  },
);

it("binds the public native modal factory through admission and the owned consumer pipe", async () => {
  // This optional, explicit test fixture supplies another owner's frozen consumer.
  // It never derives a runtime path or credentials from a user's live profile.
  const externalPath = process.env.OPENCLAW_TEST_LOCAL_CHANNEL_CONSUMER;
  const external = externalPath
    ? (JSON.parse(await fs.readFile(externalPath, "utf8")) as {
        testOnly: boolean;
        command: string;
        script: string;
        scriptSha256: string;
      })
    : undefined;
  if (external) {
    expect(external.testOnly).toBe(true);
    expect(path.isAbsolute(external.command) && path.isAbsolute(external.script)).toBe(true);
    expect(
      createHash("sha256")
        .update(await fs.readFile(external.script))
        .digest("hex"),
    ).toBe(external.scriptSha256);
  }
  await withOpenClawTestState({ prefix: "local-modal-pipe-" }, async (state) => {
    const serverPath = state.path("consumer.mjs");
    const receivedPath = state.path("received.jsonl");
    await fs.writeFile(
      serverPath,
      `import readline from "node:readline"; import fs from "node:fs";
for await (const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line); let result;
 if(m.method==="initialize") result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"fixture",version:"1"}};
 if(m.method==="tools/list") result={tools:["file_ticket","ticket_status"].map(name=>({name,inputSchema:{type:"object"}}))};
 if(m.method==="tools/call") { fs.appendFileSync(process.argv[2],JSON.stringify(m.params)+"\\n");
 result={isError:false,content:[{type:"text",text:JSON.stringify({ticket:"OPS-0001",status:"Awaiting review",tell_reporter:"OPS-0001: Awaiting review.",...(m.params.name==="file_ticket"?{replayed:false}:{})})}]}; }
 if(result) process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");
}`,
    );
    const registryPath = state.path("registry.json");
    await fs.writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        kill_switch: false,
        divisions: { web: { enabled: true, agent: "ops-web" } },
        systems: [],
      }),
    );
    const scope = {
      agentId: "desk",
      provider: "discord",
      accountId: "fixture",
      spaceId: "100",
      channelId: "101",
    };
    const guilds = { "100": { channels: { "101": { enabled: true, requireMention: false } } } };
    const cfg = {
      plugins: { enabled: false },
      channels: { discord: { groupPolicy: "allowlist" as const, guilds } },
      mcp: {
        servers: {
          owned: {
            command: external?.command ?? process.execPath,
            args: external
              ? [external.script, "--trusted-local-stdio"]
              : [serverPath, receivedPath],
            cwd: state.workspaceDir,
            transport: "stdio" as const,
            toolFilter: { include: ["file_ticket", "ticket_status"] },
            env: {
              ECHO_OPS_STATE_DIR: state.path("ops-state"),
              ECHO_OPS_REGISTRY: registryPath,
              ECHO_OPS_GATE_URL: "http://127.0.0.1:9",
              ECHO_OPS_GATE_KEY: "fixture-not-real",
            },
            localChannelContext: { version: 1 as const, scopes: [scope] },
          },
        },
      },
    };
    let live = true;
    const gateway = createGatewayFixture();
    gateway.getRuntimeConfig = () => cfg;
    const owner = {
      channelId: "discord",
      isLive: () => live,
      resolveGatewayContext: () => gateway,
    };
    const runtime = createSessionMcpRuntime({
      sessionId: "modal-session",
      sessionKey: "modal-key",
      workspaceDir: state.workspaceDir,
      agentDir: state.agentDir(),
      cfg,
      manifestRegistry: { plugins: [] },
    });
    let calls = 0;
    const dispatch: DispatchReplyFromConfig = async ({ ctx }) => {
      calls++;
      expect(ctx.MessageSid).toBe("9002");
      expect(ctx.MessageSid).not.toBe("8000");
      expect(ctx.SenderId).toBe("42");
      const followup: FollowupRun = {
        prompt: ctx.BodyForAgent ?? "",
        messageId: ctx.MessageSid,
        enqueuedAt: Date.now(),
        originatingChatId: "101",
        originatingChannel: "discord",
        run: {
          agentId: "desk",
          agentDir: state.agentDir(),
          sessionId: "modal-session",
          sessionKey: "modal-key",
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
      expect(bindLocalChannelFollowup(ctx, followup, cfg)).toBe(true);
      const admission = prepareAgentRunAdmission({
        cfg: {},
        facts: {
          runId: "modal-run",
          agentId: "desk",
          ingress: { kind: "channel", boundary: "fixture", state: "present" },
        },
        operationalRunInstance: createOperationalRunInstanceRef("modal-run"),
        onAdmitted: (admitted) => bindLocalChannelFollowupAdmission(followup, admitted),
      });
      try {
        const admittedRunContext = await admission.admit("embedded");
        const view = await materializeBundleMcpToolsForRun({
          runtime,
          agentId: "desk",
          admittedRunContext,
        });
        try {
          const file = view.tools.find((tool) => tool.name === "owned__file_ticket");
          const status = view.tools.find((tool) => tool.name === "owned__ticket_status");
          if (!file || !status) {
            throw new Error("expected protected consumer tools");
          }
          const filed = await file.execute("file", {
            category: "other",
            summary: "PRIVATE_SUMMARY",
            details: "PRIVATE_REPORT",
          });
          const filedText = filed.content.find((item) => item.type === "text");
          if (!filedText || filedText.type !== "text") {
            throw new Error("expected text receipt");
          }
          const receipt = JSON.parse(filedText.text);
          expect(Object.keys(receipt).toSorted()).toEqual([
            "replayed",
            "status",
            "tell_reporter",
            "ticket",
          ]);
          expect(receipt.ticket).toBe("OPS-0001");
          const read = await status.execute("status", { ticket_id: receipt.ticket });
          expect(JSON.stringify([filed, read])).not.toMatch(
            /PRIVATE_|modal-session|modal-run|senderId|resolution|findings/,
          );
          const controlHandoff = vi.fn(() => {
            throw new Error("unexpected media-control handoff from a public member");
          });
          await expect(
            api.tryHandleDiscordMessageActionGuildAdmin({
              ctx: {
                channel: "discord",
                action: "guild-media-filter-set-all-members",
                cfg,
                accountId: scope.accountId,
                requesterAccountId: scope.accountId,
                requesterSenderId: ctx.SenderId,
                senderIsOwner: false,
                toolContext: { currentChannelProvider: scope.provider },
                assertDirectAdapterHandoff: controlHandoff,
                params: {
                  accountId: scope.accountId,
                  guildId: scope.spaceId,
                  expectedBotId: "43",
                  expectedCurrent: 0,
                },
              },
              resolveChannelId: () => scope.channelId,
              actionOptions: {},
            }),
          ).rejects.toThrow("requires a host capability");
          expect(controlHandoff).not.toHaveBeenCalled();
          expect(noNetwork).not.toHaveBeenCalled();
          await expect(
            runtime.callTool("owned", "ticket_status", { ticket_id: receipt.ticket }),
          ).rejects.toThrow("principal_required");
          admission.close();
          await expect(async () => file.execute("retained", {})).rejects.toThrow(
            "authority_expired",
          );
        } finally {
          await view.dispose();
        }
      } finally {
        admission.close();
      }
      return { queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } };
    };
    const channelRuntime = createPluginRuntimeMock({
      channel: {
        inbound: {
          ingress: createHostChannelIngressRuntime(owner),
          buildContext: createOwnedContextBuilder(owner),
        },
        reply: { dispatchReplyFromConfig: dispatch },
      },
    }).channel;
    const api = await loadBundledPluginFacade<{
      createDiscordComponentModal: (params: object) => {
        run: (interaction: object, data: object) => Promise<void>;
      };
      tryHandleDiscordMessageActionGuildAdmin: (params: {
        ctx: ChannelMessageActionContext;
        resolveChannelId: () => string;
        actionOptions: Record<string, never>;
      }) => Promise<unknown>;
    }>({ pluginId: "discord", artifactBasename: "api.js" });
    expect(typeof api.createDiscordComponentModal).toBe("function");
    const facade = await loadBundledPluginFacade<{
      registerBuiltDiscordComponentMessage: (params: object) => Promise<void>;
    }>({ pluginId: "discord", artifactBasename: "runtime-api.js" });
    await facade.registerBuiltDiscordComponentMessage({
      buildResult: {
        components: [],
        entries: [],
        modals: [
          {
            id: "public-proof-modal",
            title: "Report",
            fields: [],
            sessionKey: "modal-key",
            agentId: "desk",
            accountId: "fixture",
            allowedUsers: ["42"],
          },
        ],
      },
      messageId: "8000",
    });
    const modal = api.createDiscordComponentModal({
      cfg,
      accountId: "fixture",
      discordConfig: cfg.channels.discord,
      guildEntries: guilds,
      channelRuntime,
      isPolicyCurrent: () => live,
      token: "fixture-not-real",
    });
    const acknowledge = vi.fn(async () => {});
    const noNetwork = vi.fn(() => {
      throw new Error("unexpected network in modal proof");
    });
    try {
      await modal.run(
        {
          id: "9002",
          rawData: { id: "9002", guild_id: "100", channel_id: "101", member: { roles: [] } },
          user: { id: "42", username: "Fixture", globalName: null, discriminator: "0" },
          guild: { id: "100", name: "Fixture" },
          channel: { id: "101", name: "reports", type: 0 },
          client: { rest: { get: noNetwork, post: noNetwork, patch: noNetwork } },
          acknowledge,
          reply: noNetwork,
          followUp: noNetwork,
        },
        { mid: "public-proof-modal" },
      );
      expect(calls).toBe(1);
      expect(acknowledge).toHaveBeenCalledOnce();
      expect(noNetwork).not.toHaveBeenCalled();
      if (external) {
        const db = new DatabaseSync(state.path("ops-state", "tickets.db"), { readOnly: true });
        try {
          expect(db.prepare("SELECT source_message_id FROM ticket_intake_requests").all()).toEqual([
            { source_message_id: "9002" },
          ]);
          expect(db.prepare("SELECT reporter_id,reporter_role,channel FROM tickets").all()).toEqual(
            [{ reporter_id: "42", reporter_role: "member", channel: "101" }],
          );
        } finally {
          db.close();
        }
      } else {
        const writes = (await fs.readFile(receivedPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(writes).toHaveLength(2);
        expect(writes[0]._meta["io.openclaw/local-channel-context"].eventId).toBe("9002");
      }
    } finally {
      live = false;
      await runtime.dispose();
      await runtime.joinCleanup?.();
    }
  });
});
