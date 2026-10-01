import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpServerSchema } from "./zod-schema.mcp-server.js";

const scope = {
  agentId: "public-desk",
  provider: "discord",
  accountId: "test-account",
  spaceId: "100",
  channelId: "101",
};
const designation = { version: 1, scopes: [scope] };
const server = {
  transport: "stdio",
  command: process.execPath,
  args: [path.resolve("test/fixture-server.mjs")],
  cwd: path.resolve("."),
  localChannelContext: designation,
};

describe("operator-designated local channel context", () => {
  it("accepts an explicit launch and exact scope without changing tool filters", () => {
    const configured = { ...server, toolFilter: { include: ["file"], exclude: ["admin"] } };
    expect(McpServerSchema.parse(configured)).toEqual(configured);
  });

  it.each([
    ["implicit transport", { ...server, transport: undefined }],
    ["relative executable", { ...server, command: "python" }],
    ["relative working directory", { ...server, cwd: "relative" }],
    ["absent argv", { ...server, args: undefined }],
    ["absent working directory", { ...server, cwd: undefined }],
    ["HTTP peer", { ...server, transport: "streamable-http", url: "https://example.test/mcp" }],
    ["ambiguous HTTP alias", { ...server, url: "https://example.test/mcp" }],
    ["unknown protocol", { ...server, localChannelContext: { ...designation, version: 2 } }],
    ["empty scope list", { ...server, localChannelContext: { ...designation, scopes: [] } }],
    [
      "missing scope field",
      {
        ...server,
        localChannelContext: { ...designation, scopes: [{ ...scope, accountId: undefined }] },
      },
    ],
    [
      "wildcard room",
      {
        ...server,
        localChannelContext: { ...designation, scopes: [{ ...scope, channelId: "*" }] },
      },
    ],
    [
      "silently trimmed account",
      {
        ...server,
        localChannelContext: {
          ...designation,
          scopes: [{ ...scope, accountId: " test-account " }],
        },
      },
    ],
    [
      "unexpected privilege field",
      { ...server, localChannelContext: { ...designation, scopes: [{ ...scope, admin: true }] } },
    ],
    [
      "duplicate scope",
      { ...server, localChannelContext: { ...designation, scopes: [scope, scope] } },
    ],
    ["control character argv", { ...server, args: ["bad\u0000arg"] }],
  ])("rejects %s", (_label, input) => {
    expect(McpServerSchema.safeParse(input).success).toBe(false);
  });

  it("preserves ordinary stdio and HTTP configuration", () => {
    for (const ordinary of [
      { command: "python", args: ["-m", "server"] },
      { url: "https://example.test/mcp" },
    ]) {
      expect(McpServerSchema.parse(ordinary)).toEqual(ordinary);
    }
  });
});
