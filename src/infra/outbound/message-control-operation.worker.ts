import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { createOpenClawStateSchemaEnsurer } from "../../state/openclaw-state-feature-schema.js";
import type { SqliteWorkerCommand } from "../sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-admission.js";
import * as kernel from "./message-control-operation.kernel.js";
import type { MessageControlWorkerOperations } from "./message-control-operation.worker-contract.js";

export function isMessageControlCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<MessageControlWorkerOperations> {
  return [
    "messageControl.admit",
    "messageControl.dispatch",
    "messageControl.settle",
    "messageControl.observe",
    "messageControl.cancel",
  ].includes(command.type);
}
export function executeMessageControlCommand(
  command: SqliteWorkerCommand<MessageControlWorkerOperations>,
  options: OpenClawStateDatabaseOptions,
): MessageControlWorkerOperations[keyof MessageControlWorkerOperations]["output"] {
  return runOpenClawStateWriteTransaction(
    (database) => {
      requestSqliteWorkerOperationAdmission({
        stage: "transaction",
        facts: { operation: command.type },
      });
      if (command.type === "messageControl.admit") {
        // No ensure cache survives an outer rollback. First-use DDL and intent
        // commit atomically under the same managed shared-state owner.
        createOpenClawStateSchemaEnsurer({
          table: "channel_control_operations",
          endMarker: "-- END channel_control_operations",
          operationLabel: "message-control.ensure",
        })({ ...options, database });
      }
      const result = (() => {
        switch (command.type) {
          case "messageControl.admit":
            return kernel.admitMessageControlOperation(database.db, command.input);
          case "messageControl.dispatch":
            return kernel.markMessageControlDispatched(database.db, command.input);
          case "messageControl.settle":
            return kernel.settleMessageControlOperation(database.db, command.input);
          case "messageControl.observe":
            return kernel.observeMessageControlOperation(database.db, command.input);
          case "messageControl.cancel":
            return kernel.cancelMessageControlOperation(database.db, command.input);
        }
        return command satisfies never;
      })();
      requestSqliteWorkerOperationAdmission({
        stage: "commit",
        facts: { operation: command.type },
      });
      return result;
    },
    options,
    { operationLabel: command.type },
  );
}
