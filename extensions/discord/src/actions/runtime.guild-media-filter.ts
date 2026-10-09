import { GuildExplicitContentFilter, PermissionFlagsBits } from "discord-api-types/v10";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { resolveGuildMediaFilterReadBinding } from "../guild-media-filter-policy.js";
import { captureDiscordRequestAuthority } from "../internal/request-authority.js";
import { fetchGuildInfoDiscord, verifyGuildMediaFilterBotDiscord } from "../send.guild.js";
import { hasAnyGuildPermissionDiscord } from "../send.permissions.js";
import { createDiscordActionOptions } from "./runtime.shared.js";

const log = createSubsystemLogger("discord/guild-media-filter");

/** Read-only inspection. The caller supplies the existing provider-owned guild read gate. */
export async function readGuildMediaFilter(params: {
  values: Record<string, unknown>;
  cfg: OpenClawConfig;
  assertGuildReadAllowed: (guildId: string) => Promise<void>;
}) {
  const startedAt = Date.now();
  const accountId = readStringParam(params.values, "accountId", { required: true });
  const guildId = readStringParam(params.values, "guildId", { required: true });
  const expectedBotId = readStringParam(params.values, "expectedBotId", { required: true });
  const binding = resolveGuildMediaFilterReadBinding(params.cfg, accountId);
  if (!binding || binding.botId !== expectedBotId || !binding.guildIds.includes(guildId)) {
    log.debug("Guild media-filter read denied", {
      action: "guild-media-filter-get",
      reason: "binding",
    });
    throw new Error("Discord media-filter read is disabled or its binding does not match.");
  }
  const opts = createDiscordActionOptions({ cfg: params.cfg, accountId });
  const assertCurrent = captureDiscordRequestAuthority();
  const botId = await verifyGuildMediaFilterBotDiscord(expectedBotId, opts);
  assertCurrent?.();
  await params.assertGuildReadAllowed(guildId);
  assertCurrent?.();
  const canManage = (userId: string) =>
    hasAnyGuildPermissionDiscord(guildId, userId, [PermissionFlagsBits.ManageGuild], opts);
  if (!(await canManage(botId))) {
    throw new Error("Discord media-filter bot lacks required guild permissions.");
  }
  assertCurrent?.();
  const senderUserId = readStringParam(params.values, "senderUserId");
  if (senderUserId && !(await canManage(senderUserId))) {
    throw new Error("Discord media-filter sender lacks required guild permissions.");
  }
  assertCurrent?.();
  // Fetch the value independently after authorization; never return the broad guild object.
  const guild = await fetchGuildInfoDiscord(guildId, opts);
  assertCurrent?.();
  if (guild.id !== guildId) {
    throw new Error("Discord media-filter guild identity does not match the requested guild.");
  }
  const value = guild.explicit_content_filter;
  if (
    value !== GuildExplicitContentFilter.Disabled &&
    value !== GuildExplicitContentFilter.MembersWithoutRoles &&
    value !== GuildExplicitContentFilter.AllMembers
  ) {
    throw new Error("Discord media-filter response has an invalid filter value.");
  }
  log.debug("Guild media-filter read verified", {
    action: "guild-media-filter-get",
    accountId,
    botId,
    guildId,
    explicitContentFilter: value,
    elapsedMs: Date.now() - startedAt,
  });
  return jsonResult({ ok: true, accountId, botId, guildId, explicitContentFilter: value });
}
