import path from "node:path";
import { isHttpsUrl, isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { z } from "zod";
import { sensitive } from "./zod-schema.sensitive.js";

const HttpUrlSchema = z.string().url().refine(isHttpUrl, "Expected http:// or https:// URL");

// Exact owner-configured tuples, never wildcard grants or model-selected destinations.
const LocalChannelScopeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]*$/);
const McpLocalChannelContextSchema = z.strictObject({
  version: z.literal(1),
  scopes: z
    .array(
      z.strictObject({
        agentId: LocalChannelScopeIdSchema,
        provider: LocalChannelScopeIdSchema,
        accountId: LocalChannelScopeIdSchema,
        spaceId: LocalChannelScopeIdSchema,
        channelId: LocalChannelScopeIdSchema,
      }),
    )
    .min(1)
    .max(64)
    .refine(
      (scopes) => new Set(scopes.map((scope) => JSON.stringify(scope))).size === scopes.length,
      "Local channel scopes must be unique",
    ),
});

const McpOAuthClientMetadataUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return isHttpsUrl(url) && url.pathname !== "/";
  }, "Expected https:// URL with a non-root pathname");

export const McpServerSchema = z
  .object({
    enabled: z.boolean().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z
      .record(
        z.string(),
        z.union([z.string().register(sensitive), z.number(), z.boolean()]).register(sensitive),
      )
      .optional(),
    cwd: z.string().optional(),
    url: HttpUrlSchema.optional(),
    transport: z
      .union([z.literal("stdio"), z.literal("sse"), z.literal("streamable-http")])
      .optional(),
    headers: z
      .record(
        z.string(),
        z.union([z.string().register(sensitive), z.number(), z.boolean()]).register(sensitive),
      )
      .optional(),
    connectionTimeoutMs: z.number().finite().positive().optional(),
    requestTimeoutMs: z.number().finite().positive().optional(),
    supportsParallelToolCalls: z.boolean().optional(),
    localChannelContext: McpLocalChannelContextSchema.optional(),
    auth: z.literal("oauth").optional(),
    oauth: z
      .strictObject({
        identity: z.enum(["shared", "per-requester"]).optional(),
        authProfileId: z.string().trim().min(1).optional(),
        scope: z.string().trim().min(1).optional(),
        redirectUrl: HttpUrlSchema.optional(),
        clientMetadataUrl: McpOAuthClientMetadataUrlSchema.optional(),
      })
      .optional(),
    sslVerify: z.boolean().optional(),
    clientCert: z.string().optional(),
    clientKey: z.string().optional(),
    toolFilter: z
      .strictObject({
        include: z.array(z.string().trim().min(1)).min(1).optional(),
        exclude: z.array(z.string().trim().min(1)).min(1).optional(),
      })
      .optional(),
    codex: z
      .strictObject({
        agents: z
          .array(
            z
              .string()
              .trim()
              .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
          )
          .min(1)
          .optional(),
        defaultToolsApprovalMode: z.enum(["auto", "prompt", "approve"]).optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.localChannelContext &&
      (data.transport !== "stdio" ||
        typeof data.command !== "string" ||
        !path.isAbsolute(data.command) ||
        data.command.includes("\0") ||
        !Array.isArray(data.args) ||
        data.args.some((arg) => arg.includes("\0")) ||
        typeof data.cwd !== "string" ||
        !path.isAbsolute(data.cwd) ||
        data.cwd.includes("\0") ||
        data.url !== undefined ||
        data.auth !== undefined ||
        data.oauth !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["localChannelContext"],
        message:
          "Local channel context requires explicit stdio, absolute command/cwd and literal args",
      });
    }
    // This schema is .catchall(z.unknown()) (open-world server options), so
    // unknown keys survive into this refine; retired aliases are rejected here.
    for (const key of [
      "connectTimeout",
      "connect_timeout",
      "timeout",
      "workingDirectory",
      "supports_parallel_tool_calls",
      "ssl_verify",
      "client_cert",
      "client_key",
    ] as const) {
      if (Object.hasOwn(data, key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unrecognized key: "${key}"`,
        });
      }
    }
    const codex = data.codex;
    if (codex && Object.hasOwn(codex, "default_tools_approval_mode")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["codex", "default_tools_approval_mode"],
        message: 'Unrecognized key: "default_tools_approval_mode"',
      });
    }
    if (Object.hasOwn(data, "disabled")) {
      const disabled = Reflect.get(data, "disabled") as unknown;
      const replacement =
        typeof disabled === "boolean"
          ? `"enabled: ${!disabled}" instead, then run "openclaw doctor --fix" to migrate existing config`
          : 'the canonical "enabled" boolean instead';
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unsupported key "disabled"; use ${replacement}`,
        path: ["disabled"],
      });
    }
    if (data.oauth?.identity === "per-requester") {
      if (data.auth !== "oauth") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'oauth.identity "per-requester" requires auth: "oauth"',
          path: ["oauth", "identity"],
        });
      }
      if (data.oauth.authProfileId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'oauth.authProfileId cannot be used with oauth.identity "per-requester"',
          path: ["oauth", "authProfileId"],
        });
      }
      if (!data.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'oauth.identity "per-requester" requires an HTTP server URL',
          path: ["oauth", "identity"],
        });
      }
      // Command precedence would resolve stdio and strand the server: partitioned
      // out of the static runtime with no requester sign-in path.
      if (data.command !== undefined || data.transport === "stdio") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'oauth.identity "per-requester" cannot be combined with a command or "stdio" transport',
          path: ["oauth", "identity"],
        });
      }
    }
    if (
      data.transport === "stdio" &&
      (typeof data.command !== "string" || data.command.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"stdio" transport requires a non-empty command',
        path: ["transport"],
      });
    }
  })
  .catchall(z.unknown());

export type McpServerConfigInput = z.input<typeof McpServerSchema>;
