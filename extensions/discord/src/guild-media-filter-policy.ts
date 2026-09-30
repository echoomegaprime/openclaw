import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { inspectDiscordAccount } from "./account-inspect.js";
import { createDiscordActionGate, listDiscordAccountIds } from "./accounts.js";

/** A root binding must not silently authorize another account through config inheritance. */
export function resolveGuildMediaFilterReadBinding(cfg: OpenClawConfig, accountId: string) {
  if (!listDiscordAccountIds(cfg).includes(accountId)) {
    return undefined;
  }
  const account = inspectDiscordAccount({ cfg, accountId });
  const binding = account.config.guildMediaFilter;
  if (
    !account.enabled ||
    !account.configured ||
    !createDiscordActionGate({ cfg, accountId })("guildMediaFilter", false) ||
    !binding ||
    binding.accountId !== accountId ||
    typeof binding.botId !== "string" ||
    !/^\d+$/.test(binding.botId) ||
    !Array.isArray(binding.guildIds) ||
    binding.guildIds.length === 0 ||
    !binding.guildIds.every((id) => typeof id === "string" && /^\d+$/.test(id))
  ) {
    return undefined;
  }
  return binding;
}

/** The fixed write is a separate explicit opt-in; receipt inspection remains readable. */
export function resolveGuildMediaFilterWriteBinding(cfg: OpenClawConfig, accountId: string) {
  const binding = resolveGuildMediaFilterReadBinding(cfg, accountId);
  return binding?.allowSetAllMembers === true ? binding : undefined;
}
