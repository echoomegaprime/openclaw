import { encodeMessageControlAdmission } from "./message-control-operation.identity.js";
import type { createMessageControlStore } from "./message-control-operation.store.js";
import type {
  MessageControlAdmission,
  MessageControlDisposition,
  MessageControlRecord,
} from "./message-control-operation.types.js";

/** Opaque host-owned capability. Its wire shape alone never establishes custody. */
export type ChannelControlOperationV1 = Readonly<{ version: 1 }>;
export type ChannelControlPhysicalRequest = Readonly<{
  method: "PATCH";
  path: string;
  body: string;
}>;
export type ChannelControlPhysicalHandoff = Readonly<{
  assertCurrent(): void;
  consumePhysicalHandoff(request: ChannelControlPhysicalRequest): void;
}>;
export type ChannelControlAdapter = {
  binding: Readonly<{
    accountId: string;
    botId: string;
    guildId: string;
    requesterSenderId?: string;
  }>;
  /** Provider-owned identity/permission checks, after authentic host capability. */
  assertAuthorized(assertCurrent: () => void): Promise<void>;
  getCurrentValue(assertCurrent: () => void): Promise<0 | 1 | 2>;
  patch(handoff: ChannelControlPhysicalHandoff): Promise<"acknowledged" | "rejected">;
};
type Store = Pick<
  ReturnType<typeof createMessageControlStore>,
  "assertCurrent" | "admit" | "dispatch" | "settle" | "read" | "observe" | "cancel"
>;
export type MessageControlMode =
  | { mode: "apply" }
  | { mode: "read" | "reconcile" | "cancel"; operationId: string };
type Owner = {
  admission: MessageControlAdmission;
  namespace: string;
  mode: MessageControlMode;
  store: Store;
  assertCurrent(): void;
  clock(): number;
  closed: boolean;
  used: boolean;
};
const owners = new WeakMap<ChannelControlOperationV1, Owner>();
export type ChannelControlResult = {
  disposition: "receipt" | "conflict" | "held" | "capacity" | "not_found";
  record: MessageControlRecord | null;
  atomicCas: false;
};

/** Host only: do not export this factory from the plugin SDK. */
export function createMessageControlCapability(options: {
  admission: MessageControlAdmission;
  store: Store;
  assertCurrent(): void;
  mode?: MessageControlMode;
  clock?: () => number;
}) {
  const admission = structuredClone(options.admission);
  const { namespace } = encodeMessageControlAdmission(admission);
  const mode = structuredClone(options.mode ?? { mode: "apply" as const });
  if (
    !["apply", "read", "reconcile", "cancel"].includes(mode.mode) ||
    (mode.mode !== "apply" &&
      (typeof mode.operationId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(mode.operationId)))
  ) {
    throw new Error("Invalid message-control mode");
  }
  let denied = false;
  let denial: unknown;
  const owner: Owner = {
    admission,
    namespace,
    mode,
    store: options.store,
    closed: false,
    used: false,
    clock: () => {
      const now = (options.clock ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < admission.execution.admittedAtMs) {
        throw new Error("Invalid message-control clock");
      }
      return now;
    },
    assertCurrent() {
      if (denied) {
        throw denial;
      }
      if (owner.closed) {
        throw new Error("Message-control capability expired");
      }
      try {
        options.assertCurrent();
        owner.store.assertCurrent();
      } catch (error) {
        denied = true;
        denial = error;
        throw error;
      }
    },
  };
  owner.assertCurrent();
  const capability: ChannelControlOperationV1 = Object.freeze({ version: 1 });
  owners.set(capability, owner);
  return {
    capability,
    close: () => {
      owner.closed = true;
    },
  };
}

function matches(owner: Owner, binding: ChannelControlAdapter["binding"]) {
  const intent = owner.admission.stable.intent;
  const principal = owner.admission.stable.principal;
  const requester =
    principal.kind === "discord-linked-admin" ? principal.requesterSenderId : undefined;
  return (
    binding.accountId === intent.accountId &&
    binding.botId === intent.expectedBotId &&
    binding.guildId === intent.guildId &&
    binding.requesterSenderId === requester
  );
}
function value(input: unknown): 0 | 1 | 2 {
  if (input !== 0 && input !== 1 && input !== 2) {
    throw new Error("Invalid message-control provider observation");
  }
  return input;
}

/** Plugins may consume an existing host capability; they cannot mint one. */
export async function executeChannelControlOperation(
  capability: ChannelControlOperationV1,
  adapter: ChannelControlAdapter,
): Promise<ChannelControlResult> {
  const owner = owners.get(capability);
  if (!owner) {
    throw new Error("A host message-control capability is required");
  }
  if (owner.used) {
    throw new Error("Message-control capability already consumed");
  }
  owner.used = true;
  owner.assertCurrent();
  if (!matches(owner, adapter.binding)) {
    throw new Error("Message-control adapter binding mismatch");
  }
  const { store, admission, namespace } = owner;
  const current = () => {
    owner.assertCurrent();
    if (!matches(owner, adapter.binding)) {
      throw new Error("Message-control adapter binding changed");
    }
  };
  const receipt = (record: MessageControlRecord | null): ChannelControlResult => {
    current();
    return { disposition: record ? "receipt" : "not_found", record, atomicCas: false };
  };
  const read = async () => {
    current();
    const observed = value(await adapter.getCurrentValue(current));
    current();
    return observed;
  };
  await adapter.assertAuthorized(current);
  current();
  if (owner.mode.mode !== "apply") {
    const locator = { namespace, operationId: owner.mode.operationId };
    const record = await store.read(locator);
    current();
    if (!record) {
      return receipt(null);
    }
    // Namespace predicates are enforced by the durable owner as well. A later
    // session may inspect its principal's record without adopting its execution.
    if (
      record.namespace !== namespace ||
      !matches(owner, {
        accountId: record.stable.intent.accountId,
        botId: record.stable.intent.expectedBotId,
        guildId: record.stable.intent.guildId,
        requesterSenderId:
          record.stable.principal.kind === "discord-linked-admin"
            ? record.stable.principal.requesterSenderId
            : undefined,
      })
    ) {
      throw new Error("Message-control receipt binding mismatch");
    }
    if (owner.mode.mode === "reconcile") {
      const observed = await read();
      return receipt(await store.observe({ ...locator, value: observed, now: owner.clock() }));
    }
    if (owner.mode.mode === "cancel") {
      return receipt(await store.cancel(locator));
    }
    return receipt(record);
  }
  current();
  const admitted = await store.admit(admission);
  current();
  if (admitted.disposition === "receipt") {
    return receipt(admitted.record);
  }
  if (admitted.disposition !== "admitted") {
    return { disposition: admitted.disposition, record: null, atomicCas: false };
  }
  const attempt = () => ({
    namespace,
    operationId: admission.operationId,
    attemptId: admission.attemptId,
    now: owner.clock(),
  });
  // This closure only settles this original, admitted execution. It does not
  // authorize provider I/O or expose facts after the caller loses authority.
  const settle = (disposition: MessageControlDisposition) =>
    store.settle({ ...attempt(), disposition });
  let before: 0 | 1 | 2;
  try {
    before = await read();
  } catch (error) {
    await settle("not_entered");
    throw error;
  }
  if (before !== admission.stable.intent.expectedCurrent) {
    return receipt(await settle("conflict"));
  }
  if (before === 2) {
    return receipt(await settle("noop"));
  }
  current();
  // If native completion is lost, leave the durable marker held. Never infer
  // rollback and never give the provider a permit on an unconfirmed commit.
  await store.dispatch(attempt());
  let consumed = false;
  let physicalClosed = false;
  const physicalCurrent = () => {
    if (physicalClosed) {
      throw new Error("Message-control physical handoff closed");
    }
    current();
  };
  const handoff: ChannelControlPhysicalHandoff = Object.freeze({
    assertCurrent: physicalCurrent,
    consumePhysicalHandoff(request: ChannelControlPhysicalRequest) {
      physicalCurrent();
      if (consumed) {
        throw new Error("Message-control physical handoff already consumed");
      }
      if (
        request.method !== "PATCH" ||
        request.path !== `/guilds/${admission.stable.intent.guildId}` ||
        request.body !== '{"explicit_content_filter":2}'
      ) {
        throw new Error("Message-control physical request binding mismatch");
      }
      consumed = true;
    },
  });
  let disposition: MessageControlDisposition;
  try {
    current();
    const outcome = await adapter.patch(handoff);
    physicalClosed = true;
    if (!consumed) {
      disposition = "not_entered";
    } else if (outcome === "rejected") {
      disposition = "rejected";
    } else if (outcome === "acknowledged") {
      disposition = (await read()) === 2 ? "verified_updated" : "unknown";
    } else {
      disposition = "unknown";
    }
  } catch {
    disposition = consumed ? "unknown" : "not_entered";
  } finally {
    physicalClosed = true;
  }
  return receipt(await settle(disposition));
}
