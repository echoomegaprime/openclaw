// Exact local operator inspection. This reads the selected profile through its existing owner;
// it neither grants Gateway operator scope nor opens an arbitrary database path.
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../../runtime.js";

export async function channelsIngressInspectCommand(
  options: {
    channel?: string;
    account?: string;
    eventId?: string;
    laneKey?: string;
    json?: boolean;
  },
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const { channel, account, eventId, laneKey } = options;
  if (
    !channel ||
    !/^[a-z0-9_-]{1,64}$/.test(channel) ||
    !account ||
    !/^[a-z0-9_-]{1,64}$/.test(account) ||
    !eventId?.trim() ||
    eventId.length > 256 ||
    !laneKey?.trim() ||
    laneKey.length > 512 ||
    (eventId + laneKey)
      .split("")
      .some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error("Exact channel, account, event and lane selectors are required");
  }
  const queue = createChannelIngressQueue({
    channelId: channel,
    accountId: account,
    access: "read-only",
  });
  let receipt;
  try {
    if (!queue.inspect) {
      throw new Error("Missing ingress receipt reader");
    }
    receipt = await queue.inspect(eventId, { laneKey });
  } catch {
    if (options.json) {
      writeRuntimeJson(runtime, { kind: "read-refused", downstreamOutcome: "not-established" });
    } else {
      runtime.error("Ingress receipt read refused; no disposition established.");
    }
    runtime.exit(1);
    return;
  }
  if (options.json) {
    writeRuntimeJson(runtime, receipt);
  } else {
    runtime.log(
      `Ingress receipt: ${receipt.kind}${receipt.kind === "found" ? ` (${receipt.status})` : ""}. Ticket and delivery outcome remain unverified; absence is retention-limited.`,
    );
  }
  if (receipt.kind === "scope-mismatch" || receipt.kind === "invalid-record") {
    runtime.exit(1);
  }
}
