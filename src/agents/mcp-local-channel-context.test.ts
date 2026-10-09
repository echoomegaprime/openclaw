import path from "node:path";
import type { CallToolRequest, JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import {
  assertMcpLocalChannelWrite,
  bindMcpLocalChannelPrincipal,
  bindMcpLocalChannelTransport,
  callMcpLocalChannelTool,
  captureMcpLocalChannelPrincipal,
} from "./mcp-local-channel-context.js";

const scope = {
  agentId: "desk",
  provider: "discord",
  accountId: "fixture",
  spaceId: "100",
  channelId: "101",
};
const facts = {
  ...scope,
  senderId: "42",
  eventId: "9001",
  eventKind: "user_request" as const,
  sessionKey: "fixture-key",
};
const server = {
  command: process.execPath,
  args: ["fixture.mjs"],
  cwd: path.resolve("."),
  transport: "stdio" as const,
  localChannelContext: { version: 1 as const, scopes: [scope] },
};

async function setup(designatedScope = scope) {
  let live = true;
  const configuredServer = structuredClone(server);
  configuredServer.localChannelContext.scopes = [{ ...designatedScope }];
  const cfg = { mcp: { servers: { owned: configuredServer } } };
  const transport = {};
  bindMcpLocalChannelTransport({
    transport,
    serverName: "owned",
    rawServer: cfg.mcp.servers.owned,
    cfg,
  });
  const admission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId: "fixture-run",
      agentId: "desk",
      ingress: { kind: "channel", boundary: "test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef("fixture-run"),
  });
  const context = await admission.admit("embedded");
  bindMcpLocalChannelPrincipal({
    context,
    facts,
    sessionId: "fixture-session",
    assertSourceCurrent: () => {
      if (!live) {
        throw new Error("PRIVATE_CAUSE");
      }
    },
  });
  const run = captureMcpLocalChannelPrincipal(context, {
    agentId: "desk",
    sessionId: "fixture-session",
    sessionKey: "fixture-key",
  });
  const toolRequest = { name: "file", arguments: { summary: "PRIVATE_BODY" } };
  const authorize = async <T>(send: (request: CallToolRequest["params"]) => T) => {
    const completed: { outcome?: { value: Awaited<T> } } = {};
    const toolResult = { content: [] };
    const result = await callMcpLocalChannelTool({
      session: {
        transport,
        client: {
          callTool: async (request) => {
            completed.outcome = { value: await send(request) };
            return toolResult;
          },
        },
        requestTimeoutMs: 1000,
        retiring: false,
      },
      toolName: toolRequest.name,
      input: toolRequest.arguments,
      runtime: { sessionId: "fixture-session", sessionKey: "fixture-key" },
      failIfDisposed: () => {},
      isCurrent: () => true,
      runGuarded: (request) => request(new AbortController().signal),
    });
    expect(result).toBe(toolResult);
    if (!completed.outcome) {
      throw new Error("Expected the authorized client call to complete");
    }
    return completed.outcome.value;
  };
  const write = (params: CallToolRequest["params"]) =>
    assertMcpLocalChannelWrite(transport, { jsonrpc: "2.0", id: 1, method: "tools/call", params });
  return {
    cfg,
    transport,
    admission,
    context,
    run,
    authorize,
    write,
    retire: () => {
      live = false;
    },
  };
}

async function expectRefusal(request: () => unknown, category: string) {
  let refusal: unknown;
  try {
    await request();
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(Error);
  if (!(refusal instanceof Error)) {
    throw new Error("Expected a local-channel refusal Error");
  }
  expect(refusal.constructor.name).toBe("McpLocalChannelRefused");
  expect(Object.getPrototypeOf(refusal.constructor)).toBe(Error);
  expect(Object.getPrototypeOf(Object.getPrototypeOf(refusal))).toBe(Error.prototype);
  expect(refusal.name).toBe("McpLocalChannelRefused");
  expect(refusal).toHaveProperty("category", category);
  expect(refusal.message).toBe(`local_channel_context:${category}`);
  expect(String(refusal)).toBe(`McpLocalChannelRefused: local_channel_context:${category}`);
  return refusal;
}

describe("protected local stdio context", () => {
  it.each([
    ["matching", {}],
    ["agent", { agentId: "another-agent" }],
    ["provider", { provider: "telegram" }],
    ["account", { accountId: "another-account" }],
    ["guild", { spaceId: "200" }],
    ["room", { channelId: "201" }],
  ] as const)("requires the exact configured %s tuple before sending", async (name, change) => {
    // Each launch is designated with its own immutable tuple before principal capture.
    const f = await setup({ ...scope, ...change });
    let sends = 0;
    let writes = 0;
    const send = (request: CallToolRequest["params"]) => {
      sends += 1;
      f.write(request);
      writes += 1;
      return "written";
    };
    try {
      if (name === "matching") {
        expect(await f.run(() => f.authorize(send))).toBe("written");
        expect({ sends, writes }).toEqual({ sends: 1, writes: 1 });
      } else {
        await expectRefusal(() => f.run(() => f.authorize(send)), "scope_mismatch");
        expect({ sends, writes }).toEqual({ sends: 0, writes: 0 });
      }
    } finally {
      f.admission.close();
    }
  });

  it("keeps context out of arguments and admits one exact pipe write", async () => {
    const f = await setup();
    try {
      await f.run(() =>
        f.authorize((request) => {
          expect(request.arguments).toEqual({ summary: "PRIVATE_BODY" });
          expect(request._meta?.["io.openclaw/local-channel-context"]).toMatchObject(facts);
          f.write(request);
          expect(() => f.write(request)).toThrow("write_not_authorized");
        }),
      );
    } finally {
      f.admission.close();
    }
  });

  it.each(["source", "admission", "configuration"] as const)(
    "rechecks %s after asynchronous preparation",
    async (reason) => {
      const f = await setup();
      try {
        await f.run(() =>
          f.authorize(async (request) => {
            await Promise.resolve();
            if (reason === "source") {
              f.retire();
            }
            if (reason === "admission") {
              f.admission.close();
            }
            if (reason === "configuration") {
              f.cfg.mcp.servers.owned.args = ["changed.mjs"];
            }
            expect(() => f.write(request)).toThrow("authority_expired");
          }),
        );
        if (reason === "configuration") {
          f.cfg.mcp.servers.owned.args = [...server.args];
          await expectRefusal(() => f.run(() => f.authorize(f.write)), "authority_expired");
        }
      } finally {
        f.admission.close();
      }
    },
  );

  it("refuses a direct caller and a nested route without its own principal", async () => {
    const f = await setup();
    try {
      await expectRefusal(() => f.authorize(f.write), "principal_required");
      const direct = captureMcpLocalChannelPrincipal(undefined, { sessionId: "fixture-session" });
      await f.run(() =>
        expectRefusal(() => direct(() => f.authorize(f.write)), "principal_required"),
      );
      expect(() =>
        f.write({
          name: "file",
          arguments: {},
          _meta: { "io.openclaw/local-channel-context": facts },
        }),
      ).toThrow("write_not_authorized");
    } finally {
      f.admission.close();
    }
  });

  it("refuses different arguments, retained tools and another pipe without private diagnostics", async () => {
    const f = await setup();
    try {
      await f.run(() =>
        f.authorize((request) => {
          expect(() => f.write({ ...request, arguments: { summary: "PRIVATE_CHANGED" } })).toThrow(
            "write_not_authorized",
          );
          const another = {};
          bindMcpLocalChannelTransport({
            transport: another,
            serverName: "owned",
            rawServer: server,
            cfg: f.cfg,
          });
          const message: JSONRPCRequest = {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: request,
          };
          expect(() => assertMcpLocalChannelWrite(another, message)).toThrow(
            "write_not_authorized",
          );
        }),
      );
      f.retire();
      const refusal = await expectRefusal(
        () => f.run(() => f.authorize(f.write)),
        "authority_expired",
      );
      expect(String(refusal)).toBe(
        "McpLocalChannelRefused: local_channel_context:authority_expired",
      );
    } finally {
      f.admission.close();
    }
  });

  it.each(["bundle-only", "alias", "changed-launch"])("cannot opt in through %s", (kind) => {
    const cfg = { mcp: { servers: { owned: server } } };
    expect(() =>
      bindMcpLocalChannelTransport({
        transport: {},
        serverName: kind === "alias" ? "lookalike" : "owned",
        rawServer: kind === "changed-launch" ? { ...server, args: ["other"] } : server,
        cfg: kind === "bundle-only" ? {} : cfg,
      }),
    ).toThrow("designation_required");
  });
});
