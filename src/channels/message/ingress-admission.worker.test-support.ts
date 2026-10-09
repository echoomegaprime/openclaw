/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker channels have no targetOrigin. */
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BroadcastChannel, threadId } from "node:worker_threads";
import { createSqliteWorkerBackend as createOwner } from "../../state/openclaw-state.worker.js";

/** Observe the exact physical coordinator without replacing native acquisition. */
export function createSqliteWorkerBackend(input: undefined, context: { databasePath: string }) {
  const owner = createOwner(input, context);
  const channel = new BroadcastChannel(`ingress-admission-probe:${context.databasePath}`);
  channel.unref();
  // oxlint-disable-next-line typescript/unbound-method -- Invoked with captured native receiver.
  const exec = DatabaseSync.prototype.exec;
  let rowCounts: Int32Array | undefined;
  // Installed before any statement cache is populated; execution remains native.
  // oxlint-disable-next-line typescript/unbound-method -- Native receiver is preserved.
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith("select") && sql.includes('from "channel_ingress_events"')) {
      const all = statement.all.bind(statement);
      statement.all = new Proxy(all, {
        apply(target, receiver, args) {
          const rows = Reflect.apply(target, receiver, args) as ReturnType<typeof all>;
          if (rowCounts) {
            Atomics.add(rowCounts, 0, rows.length);
          }
          return rows;
        },
      });
      const get = statement.get.bind(statement);
      statement.get = new Proxy(get, {
        apply(target, receiver, args) {
          const row = Reflect.apply(target, receiver, args) as ReturnType<typeof get>;
          if (rowCounts && row) {
            Atomics.add(rowCounts, 0, 1);
          }
          return row;
        },
      });
      const iterate = statement.iterate.bind(statement);
      statement.iterate = new Proxy(iterate, {
        apply(target, receiver, args) {
          const rows = Reflect.apply(target, receiver, args) as ReturnType<typeof iterate>;
          return (function* () {
            for (const row of rows) {
              if (rowCounts) {
                Atomics.add(rowCounts, 0, 1);
              }
              yield row;
            }
          })();
        },
      });
    }
    return statement;
  };
  channel.addEventListener("message", ({ data }: { data: unknown }) => {
    if (
      data &&
      typeof data === "object" &&
      "rowCounts" in data &&
      data.rowCounts instanceof Int32Array
    ) {
      rowCounts = data.rowCounts;
      channel.postMessage("counting");
      return;
    }
    if (
      !data ||
      typeof data !== "object" ||
      !("attempted" in data) ||
      !(data.attempted instanceof Int32Array) ||
      !("coordinatorPath" in data) ||
      typeof data.coordinatorPath !== "string"
    ) {
      return;
    }
    const attempted = data.attempted;
    const expected = statSync(data.coordinatorPath, { bigint: true });
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
      return exec.call(this, sql);
    };
    channel.postMessage("armed");
  });
  return {
    ...owner,
    close() {
      channel.close();
      DatabaseSync.prototype.exec = exec;
      DatabaseSync.prototype.prepare = prepare;
      return owner.close();
    },
  };
}
