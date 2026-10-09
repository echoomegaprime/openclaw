import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextAsyncParams,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
} from "../channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../channels/inbound-event/host-context-builder.js";
import type { ChannelIngressHostOwner } from "../channels/message-access/ingress-host-owner.js";

/** Preserve the native builder's sync/async overloads at the isolated plugin fixture boundary. */
export function createOwnedContextBuilder(owner: ChannelIngressHostOwner) {
  const build = createHostChannelInboundEventContextBuilder(buildChannelInboundEventContext, owner);
  function buildOwnedContext(
    params: BuildChannelInboundEventContextAsyncParams,
  ): Promise<BuiltChannelInboundEventContext>;
  function buildOwnedContext(
    params: BuildChannelInboundEventContextParams,
  ): BuiltChannelInboundEventContext;
  function buildOwnedContext(
    params: BuildChannelInboundEventContextParams,
  ): BuiltChannelInboundEventContext | Promise<BuiltChannelInboundEventContext> {
    return build(params);
  }
  return buildOwnedContext;
}
