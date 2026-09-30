import {
  beginTerminalSourceReplyDelivery,
  cancelTerminalSourceReplyDelivery,
  reconcileTerminalSourceReplyDelivery,
} from "../../infra/outbound/source-reply-mirror.js";
import { formatForLog } from "../ws-log.js";
import { scheduleDeliveredSourceReplyTranscriptMirror } from "./message-operation-result.js";
import type { GatewayRequestContext } from "./types.js";

/** Retain the existing message-delivery owner while excluding non-message controls. */
export function createMessageActionSourceReply(params: {
  context: GatewayRequestContext;
  mirror: Parameters<typeof beginTerminalSourceReplyDelivery>[0];
  sessionKey?: string;
  enabled: boolean;
}) {
  let receipt: Parameters<typeof cancelTerminalSourceReplyDelivery>[0];
  return {
    async begin() {
      if (!params.enabled) {
        return undefined;
      }
      const start = await beginTerminalSourceReplyDelivery(params.mirror);
      if (start && "outcome" in start) {
        return start;
      }
      receipt = start;
      return undefined;
    },
    async cancel() {
      if (params.enabled) {
        await cancelTerminalSourceReplyDelivery(receipt);
      }
    },
    async settle(deliveredPayload: unknown, mirrorTranscript = true) {
      if (!params.enabled) {
        return;
      }
      try {
        await reconcileTerminalSourceReplyDelivery({
          deliveredPayload,
          mirror: params.mirror,
          receipt,
        });
      } catch (err) {
        // Preserve the existing ordinary-message reconciliation and diagnostic
        // contract. Fixed guild controls never enter this delivery lifecycle.
        params.context.logGateway?.warn?.("Terminal source reply receipt reconciliation failed.", {
          error: formatForLog(err),
          channel: params.mirror.channel,
          sessionKey: params.sessionKey,
        });
      }
      if (mirrorTranscript) {
        await scheduleDeliveredSourceReplyTranscriptMirror({
          context: params.context,
          mirror: { ...params.mirror, deliveredPayload },
        });
      }
    },
  };
}
