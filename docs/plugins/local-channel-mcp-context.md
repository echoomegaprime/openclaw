---
summary: "Opt-in host-owned local stdio context for native public channel requests"
read_when:
  - Integrating a local stdio consumer with native channel identity
title: "Local channel MCP context"
---

# Local channel MCP context

An operator can designate a local stdio consumer with `mcp.servers.<name>.localChannelContext` version `1` and exact scopes containing `agentId`, `provider`, `accountId`, `spaceId` and `channelId`. The configured launch requires explicit `transport: "stdio"`, absolute executable and working-directory paths, and a literal argument array. Existing enabled and tool filters still apply. Bundles and lookalike server names cannot designate themselves.

The first supported producer is a native Discord user event in a guild room. Bots, proxy identities, direct messages, unsupported providers, restarted/serialized requests and collected multi-event requests do not supply this capability. The actual channel owner, current configured launch, original event, exact followup and live admitted run bind the materialized tool. Protected single-event requests disable collect batching; ordinary traffic keeps its prior behavior.

The host supplies a reserved sibling request header on its exact owned pipe. The original account, guild, room, sender and event are separate from model arguments. The consumer may use that provenance to perform its own business authorization. Metadata shape, PID, client name, session or run identifiers are not credentials. The operator configuration and local OS principal with direct business-state access are trusted. No protection against that principal intentionally launching the privileged integration is claimed.

Retained tools recheck current ownership after asynchronous work and immediately before write. Observed revocation does not revive an old principal. A possible write with no result has an uncertain outcome; the transport does not retry it. Cancellation after write does not guarantee rollback. Preserve the original event and original business arguments for authorized reconciliation rather than generating another submission.

The Discord public `api.ts` exports the existing `createDiscordComponentModal` factory for owning integrations. It preserves existing form/member/room checks. The submitted interaction ID is the event identity; the shared form message is only a reply reference. Importing the factory alone does not supply current host ownership or authority.

Consumers must explicitly opt into accepting host context on their owned local pipe, fail closed on ordinary/default launches, validate business arguments, and return only their approved public projection. Activation must separately verify current tool policy, denied untrusted process/pipe access, installed source identity, exact launch and channel routing. Source tests and public API declarations do not establish live activation or certification.
