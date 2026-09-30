// Channel action schemas describe plugin-declared actions available through channel UIs.
import type {
  ChannelControlOperationV1,
  ChannelControlAdapter,
} from "../infra/outbound/message-control-operation.runtime.js";

export type {
  ChannelControlOperationV1,
  ChannelControlAdapter,
  ChannelControlPhysicalHandoff,
  ChannelControlPhysicalRequest,
  ChannelControlResult,
} from "../infra/outbound/message-control-operation.runtime.js";

/** Consume only a capability supplied by the current host invocation. */
export async function executeChannelControlOperation(
  capability: ChannelControlOperationV1,
  adapter: ChannelControlAdapter,
) {
  const owner = await import("../infra/outbound/message-control-operation.runtime.js");
  return await owner.executeChannelControlOperation(capability, adapter);
}

export {
  createUnionActionGate,
  listTokenSourcedAccounts,
} from "../channels/plugins/actions/shared.js";
export { resolveReactionMessageId } from "../channels/plugins/actions/reaction-message-id.js";
export {
  createActionGate,
  imageResultFromFile,
  jsonResult,
  readNonNegativeIntegerParam,
  parseAvailableTags,
  readNumberParam,
  readPositiveIntegerParam,
  readReactionParams,
  readStringArrayParam,
  readStringOrNumberParam,
  readToolStringParam as readStringParam,
  ToolAuthorizationError,
} from "../agents/tools/common.js";
export type { ActionGate } from "../agents/tools/common.js";
export { withNormalizedTimestamp } from "../agents/date-time.js";
export { assertMediaNotDataUrl } from "../agents/sandbox-paths.js";
export { resolvePollMaxSelections } from "../polls.js";
export {
  optionalFiniteNumberSchema,
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
  optionalStringEnum,
  stringEnum,
} from "../agents/schema/typebox.js";
