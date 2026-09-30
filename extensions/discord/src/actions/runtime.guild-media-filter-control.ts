import { GuildExplicitContentFilter, PermissionFlagsBits } from "discord-api-types/v10";
import {
  executeChannelControlOperation,
  jsonResult,
  readStringParam,
} from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveGuildMediaFilterReadBinding,
  resolveGuildMediaFilterWriteBinding,
} from "../guild-media-filter-policy.js";
import {
  captureDiscordRequestAuthority,
  withDiscordRequestAuthority,
} from "../internal/request-authority.js";
import {
  fetchGuildInfoDiscord,
  setGuildMediaFilterAllMembersDiscord,
  verifyGuildMediaFilterBotDiscord,
} from "../send.guild.js";
import { hasAnyGuildPermissionDiscord } from "../send.permissions.js";
import { resolveDiscordRest } from "../send.shared.js";
import type { DiscordReactOpts } from "../send.types.js";
import type { DiscordMessagingActionOptions } from "./runtime.messaging.shared.js";
import { createDiscordActionOptions } from "./runtime.shared.js";

/** Only the core owner admits or reconciles operations; this adapter owns provider checks. */
export async function controlGuildMediaFilter(params: {
  values: Record<string, unknown>;
  cfg: OpenClawConfig;
  options?: DiscordMessagingActionOptions;
  assertGuildReadAllowed: (guildId: string) => Promise<void>;
}) {
  const accountId = readStringParam(params.values, "accountId", { required: true });
  const guildId = readStringParam(params.values, "guildId", { required: true });
  const botId = readStringParam(params.values, "expectedBotId", { required: true });
  const controlMode = params.values.controlMode === undefined ? "apply" : params.values.controlMode;
  if (
    controlMode !== "apply" &&
    controlMode !== "read" &&
    controlMode !== "reconcile" &&
    controlMode !== "cancel"
  ) {
    throw new Error("Discord media-filter control mode is invalid.");
  }
  if (controlMode !== "apply") {
    const operationId = readStringParam(params.values, "operationId", { required: true });
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(operationId)) {
      throw new Error("Discord media-filter receipt operation ID is invalid.");
    }
  }
  const binding = resolveGuildMediaFilterReadBinding(params.cfg, accountId);
  if (!binding || binding.botId !== botId || !binding.guildIds.includes(guildId)) {
    throw new Error("Discord media-filter control binding is disabled or does not match.");
  }
  const assertWriteEnabled = () => {
    const current = resolveGuildMediaFilterWriteBinding(params.cfg, accountId);
    if (!current || current.botId !== botId || !current.guildIds.includes(guildId)) {
      throw new Error("Discord media-filter all-members writes are disabled.");
    }
  };
  if (controlMode === "apply") {
    assertWriteEnabled();
  }
  const capability = params.options?.controlOperation;
  if (!capability) {
    throw new Error("Discord media-filter control requires a host capability.");
  }
  const requesterSenderId = params.options?.controlRequesterSenderId;
  const baseOpts = createDiscordActionOptions({ cfg: params.cfg, accountId });
  let authorizedOpts: DiscordReactOpts | undefined;
  const requestOpts = () => {
    if (!authorizedOpts) {
      throw new Error("Discord media-filter provider is not authorized.");
    }
    return authorizedOpts;
  };
  const inheritedAuthority = captureDiscordRequestAuthority();
  const composeAuthority = (assertCoreCurrent: () => void) => () => {
    inheritedAuthority?.();
    assertCoreCurrent();
  };
  const readGuild = async (assertCurrent: () => void) => {
    assertCurrent();
    const guild = await fetchGuildInfoDiscord(guildId, requestOpts());
    assertCurrent();
    if (guild.id !== guildId) {
      throw new Error("Discord media-filter guild identity does not match.");
    }
    return guild;
  };
  return jsonResult(
    await executeChannelControlOperation(capability, {
      binding: { accountId, botId, guildId, ...(requesterSenderId ? { requesterSenderId } : {}) },
      async assertAuthorized(assertCoreCurrent) {
        const assertCurrent = composeAuthority(assertCoreCurrent);
        await withDiscordRequestAuthority(assertCurrent, async () => {
          assertCurrent();
          await params.assertGuildReadAllowed(guildId);
          assertCurrent();
          const opts = { ...baseOpts, rest: resolveDiscordRest(baseOpts) };
          authorizedOpts = opts;
          await verifyGuildMediaFilterBotDiscord(botId, opts);
          assertCurrent();
          const canManage = (userId: string) =>
            hasAnyGuildPermissionDiscord(guildId, userId, [PermissionFlagsBits.ManageGuild], opts);
          const botCanManage = await canManage(botId);
          assertCurrent();
          if (!botCanManage) {
            throw new Error("Discord media-filter bot lacks required guild permissions.");
          }
          if (requesterSenderId) {
            const senderCanManage = await canManage(requesterSenderId);
            assertCurrent();
            if (!senderCanManage) {
              throw new Error("Discord media-filter sender lacks required guild permissions.");
            }
          }
          // Receipt-only inspection also verifies actual guild identity. This broad
          // metadata is discarded, never returned as the operation's media readback.
          await readGuild(assertCurrent);
        });
      },
      async getCurrentValue(assertCoreCurrent) {
        const assertCurrent = composeAuthority(assertCoreCurrent);
        return await withDiscordRequestAuthority(assertCurrent, async () => {
          const guild = await readGuild(assertCurrent);
          const value = guild.explicit_content_filter;
          if (
            value !== GuildExplicitContentFilter.Disabled &&
            value !== GuildExplicitContentFilter.MembersWithoutRoles &&
            value !== GuildExplicitContentFilter.AllMembers
          ) {
            throw new Error("Discord media-filter response has an invalid filter value.");
          }
          return value;
        });
      },
      async patch(handoff) {
        const assertCurrent = composeAuthority(() => handoff.assertCurrent());
        return await withDiscordRequestAuthority(assertCurrent, async () => {
          assertCurrent();
          assertWriteEnabled();
          const result = await setGuildMediaFilterAllMembersDiscord(
            guildId,
            requestOpts(),
            handoff,
          );
          assertCurrent();
          return result;
        });
      },
    }),
  );
}
