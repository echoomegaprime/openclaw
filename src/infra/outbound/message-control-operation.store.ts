import { createHash } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { createSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-admission.js";
import type { MessageControlLocator } from "./message-control-operation.types.js";
import type { MessageControlWorkerOperations } from "./message-control-operation.worker-contract.js";

const log = createSubsystemLogger("outbound/message-control");
type Operation = keyof MessageControlWorkerOperations;
export function messageControlDiagnostic(event: {
  operationId?: string;
  attemptId?: string;
  operation: string;
  disposition: string;
}) {
  // Diagnostics cannot replace a committed result or grant admission.
  try {
    log.debug("Message-control boundary", event);
  } catch {
    /* optional telemetry */
  }
}
export function createMessageControlStore(options: {
  stateOptions?: OpenClawStateDatabaseOptions;
  assertCurrent: () => void;
}) {
  const context = captureOpenClawStateWorkerContext(options.stateOptions);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent();
  };
  const execute = async <Key extends Operation>(
    type: Key,
    input: MessageControlWorkerOperations[Key]["input"],
    settle = false,
  ): Promise<MessageControlWorkerOperations[Key]["output"]> => {
    const captured = structuredClone(input);
    // Original execution may publish only its own settlement after revocation.
    // Physical store custody stays mandatory; no new provider I/O is authorized.
    const assert = settle ? context.admission.assertCurrent : assertCurrent;
    try {
      const result = await runOpenClawStateWorkerOperation(
        context,
        (scope) => scope.execute({ type, input: captured }),
        {
          assertCurrent: assert,
          createAdmission: () => ({
            nativeLocations: [context.admission.databasePath],
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              if (request.stage !== "transaction" && request.stage !== "commit") {
                throw new Error("Message-control transaction admission required");
              }
              assert();
              grant();
            }),
          }),
        },
      );
      messageControlDiagnostic({
        operation: type,
        operationId: captured.operationId,
        attemptId: "attemptId" in captured ? captured.attemptId : undefined,
        disposition: "completed",
      });
      return result;
    } catch (error) {
      messageControlDiagnostic({
        operation: type,
        operationId: captured.operationId,
        disposition: "native_outcome_unconfirmed",
      });
      throw error;
    }
  };
  return {
    databaseIdentityFingerprint: createHash("sha256")
      .update(context.admission.identity.key)
      .digest("hex"),
    assertCurrent,
    admit: (input: MessageControlWorkerOperations["messageControl.admit"]["input"]) =>
      execute("messageControl.admit", input),
    dispatch: (input: MessageControlWorkerOperations["messageControl.dispatch"]["input"]) =>
      execute("messageControl.dispatch", input),
    settle: (input: MessageControlWorkerOperations["messageControl.settle"]["input"]) =>
      execute("messageControl.settle", input, true),
    observe: (input: MessageControlWorkerOperations["messageControl.observe"]["input"]) =>
      execute("messageControl.observe", input),
    cancel: (input: MessageControlWorkerOperations["messageControl.cancel"]["input"]) =>
      execute("messageControl.cancel", input),
    read: async (input: MessageControlLocator) => {
      assertCurrent();
      const result = await executeExistingOpenClawStateRead(
        { path: context.admission.databasePath, env: context.environment },
        { type: "messageControl.read", input: structuredClone(input) },
        { context, current: true },
      );
      assertCurrent();
      if (!result) {
        return null;
      }
      if (!result.ok || result.type !== "messageControl.read") {
        throw new Error("Message-control receipt read unavailable");
      }
      return result.record;
    },
  };
}
