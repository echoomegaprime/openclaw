import { createSqliteWorkerWriteAdmission } from "../../infra/sqlite-worker-store.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { ChannelIngressQueueEnqueueResult } from "./ingress-queue.js";
import type { IngressEnqueueInput, IngressPruneInput } from "./ingress-queue.worker-contract.js";

function admission(context: OpenClawStateWorkerContext, assertOwnerCurrent: () => void) {
  const assertCurrent = () => {
    context.admission.assertCurrent();
    assertOwnerCurrent();
  };
  return {
    assertCurrent,
    createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
      context.admission.databasePath,
    ]),
  };
}

export async function enqueueIngress<TPayload, TMetadata, TCompletedMetadata>(
  context: OpenClawStateWorkerContext,
  input: IngressEnqueueInput,
  assertCurrent: () => void,
): Promise<ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata>> {
  return (await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "ingress.enqueue", input }),
    admission(context, assertCurrent),
    // SAFETY: Transport preserves the original caller's JSON contract and type parameters.
  )) as ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata>;
}

export async function pruneIngress(
  context: OpenClawStateWorkerContext,
  input: IngressPruneInput,
  assertCurrent: () => void,
): Promise<number> {
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "ingress.prune", input }),
    admission(context, assertCurrent),
  );
}
