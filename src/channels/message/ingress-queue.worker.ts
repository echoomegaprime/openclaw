import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { enqueueIngressInDatabase, pruneIngressInDatabase } from "./ingress-queue.js";
import type { IngressWorkerOperations } from "./ingress-queue.worker-contract.js";

export function executeIngressWorkerCommand(
  database: OpenClawStateDatabase,
  command: SqliteWorkerCommand<IngressWorkerOperations>,
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result =
        command.type === "ingress.enqueue"
          ? enqueueIngressInDatabase(db, command.input)
          : pruneIngressInDatabase(db, command.input);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    },
    { database, path: database.path, env: getSqliteWorkerStateContext().environment },
    { operationLabel: command.type },
  );
}
