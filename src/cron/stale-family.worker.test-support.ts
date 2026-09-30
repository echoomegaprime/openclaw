/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker channels have no targetOrigin. */
/* oxlint-disable typescript/unbound-method -- Native prototypes are restored and invoked with their captured receiver. */
import { statSync } from "node:fs";
import { constants, DatabaseSync, StatementSync } from "node:sqlite";
import { BroadcastChannel, threadId } from "node:worker_threads";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync-cache-state.js";
import {
  SQLITE_WORKER_PREPARE_COMMAND,
  type SqliteWorkerPreparedBackend,
} from "../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import { createSqliteWorkerBackend as createOwner } from "../state/openclaw-state.worker.js";

export type FamilyProbe = {
  denyColumn?: string;
  ignoreDescription?: boolean;
  denyFunctions?: boolean;
  refuseDelete?: boolean;
  reverse?: boolean;
};
type Observation = {
  threadId: number;
  queries: number;
  rows: number;
  textBytes: number;
  first?: string;
};
export type FamilyFixtureOperations = {
  "fixture.configureFamily": { input: FamilyProbe; output: void };
  "fixture.familyObservation": { input: undefined; output: Observation };
};

/** Faults and observations belong to the actual production worker connection. */
export function createSqliteWorkerBackend(
  input: undefined,
  context: { databasePath: string },
): SqliteWorkerPreparedBackend<OpenClawStateWorkerOperations & FamilyFixtureOperations> {
  const owner = createOwner(input, context);
  const channel = new BroadcastChannel(`cron-family-probe:${context.databasePath}`);
  channel.unref();
  const nativeExec = DatabaseSync.prototype.exec;
  let watching = false;
  channel.addEventListener("message", ({ data }: { data: unknown }) => {
    if (
      !data ||
      typeof data !== "object" ||
      !("attempted" in data) ||
      !(data.attempted instanceof Int32Array) ||
      !(data.attempted.buffer instanceof SharedArrayBuffer) ||
      !("coordinatorPath" in data) ||
      typeof data.coordinatorPath !== "string"
    ) {
      return;
    }
    const attempted = data.attempted;
    const expected = statSync(data.coordinatorPath, { bigint: true });
    watching = true;
    DatabaseSync.prototype.exec = function (sql) {
      if (sql.includes("BEGIN EXCLUSIVE")) {
        const location = this.location();
        const actual = location && statSync(location, { bigint: true });
        if (actual && actual.dev === expected.dev && actual.ino === expected.ino) {
          Atomics.store(attempted, 1, threadId);
          Atomics.store(attempted, 0, 1);
          Atomics.notify(attempted, 0);
        }
      }
      return nativeExec.call(this, sql);
    };
    channel.postMessage("armed");
  });
  const db = openOpenClawStateDatabase({
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  }).db;
  let probe: FamilyProbe = {};
  let observed: Observation = { threadId, queries: 0, rows: 0, textBytes: 0 };
  return {
    [SQLITE_WORKER_PREPARE_COMMAND](type) {
      if (type === "fixture.configureFamily" || type === "fixture.familyObservation") {
        return;
      }
      return owner[SQLITE_WORKER_PREPARE_COMMAND]?.(type);
    },
    execute(command) {
      if (command.type === "fixture.configureFamily") {
        probe = command.input;
        return undefined;
      }
      if (command.type === "fixture.familyObservation") {
        return observed;
      }
      if (command.type !== "cron.removeStaleFamily") {
        return owner.execute(command);
      }
      observed = { threadId, queries: 0, rows: 0, textBytes: 0 };
      const all = StatementSync.prototype.all;
      const iterate = StatementSync.prototype.iterate;
      const familySelect = (sql: string) => /^select\b/i.test(sql) && sql.includes('"cron_jobs"');
      const observe = (row: Record<string, unknown>) => {
        observed.rows++;
        for (const value of Object.values(row)) {
          if (typeof value === "string") {
            observed.textBytes += Buffer.byteLength(value);
          }
        }
      };
      StatementSync.prototype.all = function (...args) {
        const rows: ReturnType<typeof all> = Reflect.apply(all, this, args);
        if (familySelect(this.sourceSQL)) {
          observed.queries++;
          rows.forEach(observe);
        }
        return rows;
      };
      StatementSync.prototype.iterate = function* (...args) {
        const counted = familySelect(this.sourceSQL);
        if (counted) {
          observed.queries++;
        }
        const rows: ReturnType<typeof iterate> = Reflect.apply(iterate, this, args);
        for (const row of rows) {
          if (counted) {
            observe(row);
          }
          yield row;
        }
        return undefined;
      };
      try {
        clearNodeSqliteKyselyCacheForDatabase(db);
        db.exec(`PRAGMA reverse_unordered_selects = ${probe.reverse ? "ON" : "OFF"}`);
        if (probe.refuseDelete) {
          const first = db
            .prepare(
              "SELECT store_key, job_id, declaration_key, name, description FROM cron_jobs WHERE store_key != ?",
            )
            .all(command.input.storeKey)
            .find(
              (row) =>
                row.declaration_key === command.input.family.declarationKey ||
                (row.name === command.input.family.name &&
                  typeof row.description === "string" &&
                  row.description.includes(command.input.family.ownerPluginTag)),
            );
          observed.first = String(first?.job_id);
          db.exec(
            "CREATE TEMP TRIGGER refuse_family_delete BEFORE DELETE ON main.cron_jobs BEGIN SELECT RAISE(ABORT, 'refused:' || OLD.job_id); END",
          );
        }
        db.setAuthorizer((action, table, column) => {
          if (action === constants.SQLITE_FUNCTION && probe.denyFunctions) {
            return constants.SQLITE_DENY;
          }
          if (action === constants.SQLITE_READ && table === "cron_jobs") {
            if (column === probe.denyColumn) {
              return constants.SQLITE_DENY;
            }
            if (column === "description" && probe.ignoreDescription) {
              return constants.SQLITE_IGNORE;
            }
          }
          return constants.SQLITE_OK;
        });
        return owner.execute(command);
      } finally {
        db.setAuthorizer(null);
        db.exec("DROP TRIGGER IF EXISTS temp.refuse_family_delete");
        db.exec("PRAGMA reverse_unordered_selects = OFF");
        clearNodeSqliteKyselyCacheForDatabase(db);
        StatementSync.prototype.all = all;
        StatementSync.prototype.iterate = iterate;
      }
    },
    assertSettled: () => owner.assertSettled?.(),
    close: () => {
      channel.close();
      if (watching) {
        DatabaseSync.prototype.exec = nativeExec;
      }
      return owner.close();
    },
  };
}
