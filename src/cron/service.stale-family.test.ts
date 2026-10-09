/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker channels have no targetOrigin. */
import { once } from "node:events";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextFrame } from "node:timers/promises";
import { BroadcastChannel, Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { openSharedStateSqliteWorkerStore } from "../infra/sqlite-worker-store.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { createPluginRuntimeCapabilityLease } from "../plugins/capability-lease.js";
import { createPluginServiceCronGetter } from "../plugins/service-cron.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import type { FamilyFixtureOperations, FamilyProbe } from "./stale-family.worker.test-support.js";
import { saveCronJobsStoreWithRevisionNative } from "./store.js";
import type { CronStoredJob } from "./types.js";

vi.mock("../infra/runtime-process-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/runtime-process-url.js")>();
  const { resolveRuntimeWorkerUrl } = await import("../infra/runtime-worker-url.js");
  return {
    ...actual,
    resolveRuntimeProcessEntrypointUrl: (
      name: Parameters<typeof actual.resolveRuntimeProcessEntrypointUrl>[0],
    ) =>
      name === "sharedStateStore"
        ? resolveRuntimeWorkerUrl({
            currentModuleUrl: import.meta.url,
            sourceWorkerName: "stale-family.worker.test-support",
            distWorkerPath: "cron/stale-family.worker.test-support.js",
          })
        : actual.resolveRuntimeProcessEntrypointUrl(name),
  };
});

const family = {
  declarationKey: "memory-core:memory-dreaming-promotion",
  name: "Memory Dreaming Promotion",
  ownerPluginTag: "[managed-by=memory-core.short-term-promotion]",
};

function makeJob(id: string, fields: Partial<CronStoredJob> = {}): CronStoredJob {
  return {
    id,
    name: `Operator ${id}`,
    enabled: false,
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "fixture" },
    state: {},
    ...fields,
  };
}

function readDurableRows(db: DatabaseSync) {
  return {
    jobs: db.prepare("SELECT * FROM cron_jobs ORDER BY store_key, job_id").all(),
    scratch: db.prepare("SELECT * FROM cron_job_scratch ORDER BY store_key, job_id").all(),
    authority: db
      .prepare("SELECT * FROM cron_job_runtime_authorities ORDER BY store_key, job_id")
      .all(),
  };
}

async function withFamilyStore(
  workload: { unrelatedCount: number; descriptionBytes: number; schedulerEnabled?: boolean },
  run: (fixture: {
    cron: CronService;
    db: DatabaseSync;
    activeStore: string;
    staleStore: string;
    log: ReturnType<typeof createNoopLogger>;
    configure: (probe: FamilyProbe) => Promise<void>;
    observation: () => Promise<FamilyFixtureOperations["fixture.familyObservation"]["output"]>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "cron-stale-family" }, async (state) => {
    const activeStore = state.statePath("cron", "jobs.json");
    const staleStore = state.statePath("obsolete", "cron", "jobs.json");
    const active = makeJob("active-owned", {
      declarationKey: family.declarationKey,
      name: family.name,
      description: `${family.ownerPluginTag} active`,
    });
    const stale = [
      makeJob("z-declared", {
        declarationKey: family.declarationKey,
        description: "Declared family with a renamed display name",
        runtimeAuthorityRecoveryRequired: true,
      }),
      makeJob("a-legacy", {
        name: family.name,
        description: `${family.ownerPluginTag} legacy`,
        runtimeAuthorityRecoveryRequired: true,
      }),
      makeJob("operator-same-name", {
        name: family.name,
        description: "Operator-owned job, not the managed family",
        runtimeAuthorityRecoveryRequired: true,
      }),
      ...Array.from({ length: workload.unrelatedCount }, (_, index) =>
        makeJob(`unrelated-${index}`, { description: "x".repeat(workload.descriptionBytes) }),
      ),
    ];
    saveCronJobsStoreWithRevisionNative(activeStore, { version: 1, jobs: [active] });
    saveCronJobsStoreWithRevisionNative(staleStore, { version: 1, jobs: stale });
    runOpenClawStateWriteTransaction(({ db }) => {
      const insert = db.prepare(
        "INSERT INTO cron_job_scratch (store_key, job_id, content, revision, updated_at_ms) VALUES (?, ?, ?, 1, 1800000000000)",
      );
      insert.run(activeStore, active.id, "active scratch");
      for (const job of stale) {
        insert.run(staleStore, job.id, `scratch:${job.id}`);
      }
    });
    const log = createNoopLogger();
    const cron = new CronService({
      storePath: activeStore,
      cronEnabled: workload.schedulerEnabled ?? false,
      log,
      nowMs: () => 1_800_000_000_000,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    try {
      expect((await cron.list({ includeDisabled: true })).map((job) => job.id)).toEqual([
        active.id,
      ]);
      const context = captureOpenClawStateWorkerContext();
      const control = await openSharedStateSqliteWorkerStore<FamilyFixtureOperations>(
        {
          moduleUrl: resolveRuntimeProcessEntrypointUrl("sharedStateStore"),
          databasePath: context.admission.databasePath,
        },
        context,
      );
      if (!control) {
        throw new Error("Missing family fixture worker");
      }
      try {
        await run({
          cron,
          db: openOpenClawStateDatabase().db,
          activeStore,
          staleStore,
          log,
          configure: (input) => control.execute({ type: "fixture.configureFamily", input }),
          observation: () =>
            control.execute({ type: "fixture.familyObservation", input: undefined }),
        });
      } finally {
        await control.close();
      }
    } finally {
      cron.stop();
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

function withoutJobs(before: ReturnType<typeof readDurableRows>, store: string, ids: string[]) {
  const keep = (row: Record<string, unknown>) =>
    row.store_key !== store || !ids.includes(String(row.job_id));
  return {
    jobs: before.jobs.filter(keep),
    scratch: before.scratch.filter(keep),
    authority: before.authority.filter(keep),
  };
}

const ordinary = { unrelatedCount: 3, descriptionBytes: 32 };

describe("Cron stale-family cleanup", () => {
  it.each(["debug", "warn"] as const)(
    "preserves the worker outcome when diagnostic callbacks throw: %s",
    async (level) => {
      await withFamilyStore(ordinary, async ({ cron, db, staleStore, configure, log }) => {
        const before = readDurableRows(db);
        if (level === "warn") {
          await configure({ refuseDelete: true });
        }
        const loggingFailure = new Error("synthetic diagnostic failure");
        const diagnostic = vi.spyOn(log, level).mockImplementation(() => {
          throw loggingFailure;
        });
        const run = stateWorker.runOpenClawStateWorkerOperation;
        let attempts = 0;
        let workerFailure: unknown;
        const measured = vi
          .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
          .mockImplementation(async (context, operation, options) => {
            if (options?.createAdmission) {
              attempts++;
            }
            try {
              return await run(context, operation, options);
            } catch (error) {
              workerFailure = error;
              throw error;
            }
          });
        try {
          const result = await cron.removeStaleJobFamily(family).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          expect(diagnostic).toHaveBeenCalledOnce();
          expect(attempts).toBe(1);
          if (level === "debug") {
            expect(result).toEqual({ value: 2 });
            expect(workerFailure).toBeUndefined();
            expect(readDurableRows(db)).toEqual(
              withoutJobs(before, staleStore, ["z-declared", "a-legacy"]),
            );
          } else {
            expect(workerFailure).toBeInstanceOf(Error);
            expect(workerFailure).toHaveProperty("message", expect.stringMatching(/^refused:/));
            expect("error" in result ? result.error : undefined).toBe(workerFailure);
            expect(readDurableRows(db)).toEqual(before);
          }
        } finally {
          measured.mockRestore();
          diagnostic.mockRestore();
        }
      });
    },
  );

  it("retains the committed outcome when plugin authority is revoked after its commit grant", async () => {
    await withFamilyStore(ordinary, async ({ cron, db, staleStore }) => {
      const expected = withoutJobs(readDurableRows(db), staleStore, ["z-declared", "a-legacy"]);
      const lease = createPluginRuntimeCapabilityLease("synthetic family owner");
      const plugin = createPluginServiceCronGetter({
        getCron: () => cron,
        lease,
        isStopping: () => false,
      })();
      if (!plugin) {
        throw new Error("Plugin fixture was not admitted");
      }
      const create = workerAdmission.createSqliteWorkerOperationAdmission;
      let committed = false;
      const revoke = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          create((request, grant) => {
            admit(request, grant);
            if (request.stage === "commit") {
              committed = true;
              lease.revoke();
            }
          }, attachment),
        );
      try {
        await expect(plugin.removeStaleJobFamily(family)).resolves.toBe(2);
        expect(committed).toBe(true);
        expect(lease.isActive()).toBe(false);
        expect(readDurableRows(db)).toEqual(expected);
      } finally {
        revoke.mockRestore();
      }
    });
  });

  it("never replays a completed deletion when the host loses its result", async () => {
    await withFamilyStore(ordinary, async ({ cron, db, staleStore }) => {
      const expected = withoutJobs(readDurableRows(db), staleStore, ["z-declared", "a-legacy"]);
      const run = stateWorker.runOpenClawStateWorkerOperation;
      const unknown = new SqliteWorkerError("synthetic lost result", "outcome-unknown");
      let attempts = 0;
      const lost = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementation(async (context, operation, options) => {
          const value = await run(context, operation, options);
          if (options?.createAdmission) {
            attempts++;
            throw unknown;
          }
          return value;
        });
      try {
        await expect(cron.removeStaleJobFamily(family)).rejects.toBe(unknown);
        expect(attempts).toBe(1);
        expect(readDurableRows(db)).toEqual(expected);
      } finally {
        lost.mockRestore();
      }
    });
  });

  it.each(["transaction", "commit"] as const)(
    "rolls back when plugin or scheduler authority is revoked at %s admission",
    async (stage) => {
      await withFamilyStore(ordinary, async ({ cron, db }) => {
        for (const authority of ["plugin", "scheduler", "stopping"] as const) {
          const before = readDurableRows(db);
          const lease = createPluginRuntimeCapabilityLease("synthetic family owner");
          let current: CronService | null = cron;
          let stopping = false;
          const plugin = createPluginServiceCronGetter({
            getCron: () => current,
            lease,
            isStopping: () => stopping,
          })();
          if (!plugin) {
            throw new Error("Plugin fixture was not admitted");
          }
          let requested = false;
          const create = workerAdmission.createSqliteWorkerOperationAdmission;
          const revoke = vi
            .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
            .mockImplementation((admit, attachment) =>
              create((request, grant) => {
                if (request.stage === stage) {
                  requested = true;
                  if (authority === "plugin") {
                    lease.revoke();
                  }
                  if (authority === "scheduler") {
                    current = null;
                  }
                  if (authority === "stopping") {
                    stopping = true;
                  }
                }
                // The real write-admission state machine performs the grant/refusal.
                admit(request, grant);
              }, attachment),
            );
          try {
            await expect(plugin.removeStaleJobFamily(family)).rejects.toThrow(
              /no longer active|replaced|stopping/,
            );
            expect(requested).toBe(true);
          } finally {
            revoke.mockRestore();
          }
          expect(readDurableRows(db)).toEqual(before);
        }
      });
    },
  );

  it("performs family queries only on the worker and executes sibling requests in FIFO order", async () => {
    await withFamilyStore(ordinary, async ({ cron, db, activeStore, observation }) => {
      const sibling = new CronService({
        storePath: activeStore,
        cronEnabled: false,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      await sibling.list({ includeDisabled: true });
      const query = vi.spyOn(DatabaseSync.prototype, "prepare");
      try {
        const results = await Promise.all([
          cron.removeStaleJobFamily(family),
          sibling.removeStaleJobFamily(family),
        ]);
        expect(results).toEqual([2, 0]);
        expect(query.mock.calls.filter(([sql]) => /\bcron_jobs\b/.test(sql))).toEqual([]);
      } finally {
        query.mockRestore();
        sibling.stop();
      }
      expect((await observation()).threadId).toBeGreaterThan(0);
      expect(readDurableRows(db).jobs.some((row) => row.job_id === "active-owned")).toBe(true);
    });
  });

  it.each([false, true])(
    "keeps the main thread responsive after real coordinator contention begins, revoked=%s",
    async (revokeWhileWaiting) => {
      await withFamilyStore(
        { ...ordinary, schedulerEnabled: true },
        async ({ cron, db, staleStore }) => {
          const before = readDurableRows(db);
          const expected = withoutJobs(before, staleStore, ["z-declared", "a-legacy"]);
          const coordinator = acquireStateDatabaseCoordinator({
            databasePath: openOpenClawStateDatabase().path,
          });
          const coordinatorPath = coordinator.path;
          coordinator.release();
          const coordinatorIdentity = statSync(coordinatorPath, { bigint: true });
          const held = new Int32Array(new SharedArrayBuffer(4));
          const attempted = new Int32Array(new SharedArrayBuffer(8));
          const channel = new BroadcastChannel(
            `cron-family-probe:${openOpenClawStateDatabase().path}`,
          );
          const armed = new Promise<void>((resolve) => {
            channel.addEventListener("message", () => resolve(), { once: true });
          });
          channel.postMessage({ attempted, coordinatorPath });
          await armed;
          const holder = new Worker(
            `const { parentPort, workerData } = require("node:worker_threads");
         const { DatabaseSync } = require("node:sqlite");
         const db = new DatabaseSync(workerData.path);
         db.exec("BEGIN EXCLUSIVE");
         Atomics.store(workerData.held, 0, 1);
         parentPort.on("message", () => {
           db.exec("ROLLBACK"); db.close();
           Atomics.store(workerData.held, 0, 0); parentPort.close();
         });
         parentPort.postMessage("held");`,
            { eval: true, execArgv: [], env: {}, workerData: { path: coordinatorPath, held } },
          );
          const exited = once(holder, "exit");
          // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the captured native receiver.
          const exec = DatabaseSync.prototype.exec;
          const probe = vi
            .spyOn(DatabaseSync.prototype, "exec")
            .mockImplementation(function (this: DatabaseSync, sql) {
              // Observe, without replacing, the real native acquisition on the contender.
              if (sql.includes("BEGIN EXCLUSIVE")) {
                const location = this.location();
                const actual = location && statSync(location, { bigint: true });
                if (
                  actual &&
                  actual.dev === coordinatorIdentity.dev &&
                  actual.ino === coordinatorIdentity.ino
                ) {
                  Atomics.store(attempted, 0, 1);
                  Atomics.notify(attempted, 0);
                }
              }
              return exec.call(this, sql);
            });
          let pending: Promise<number> | undefined;
          let completed = false;
          let current = true;
          try {
            expect(await once(holder, "message")).toEqual(["held"]);
            pending = cron.removeStaleJobFamily(family, {
              commitGuard: () => {
                if (!current) {
                  throw new Error("family owner retired during native wait");
                }
              },
            });
            void pending.then(
              () => {
                completed = true;
              },
              () => {
                completed = true;
              },
            );
            await Promise.race([
              Promise.resolve(Atomics.waitAsync(attempted, 0, 0).value),
              pending,
            ]);
            await nextFrame();
            expect(Atomics.load(held, 0)).toBe(1);
            expect(completed).toBe(false);
            expect(Atomics.load(attempted, 1)).toBeGreaterThan(0);
            expect(readDurableRows(db)).not.toEqual(expected);
            if (revokeWhileWaiting) {
              current = false;
            }
            holder.postMessage("release");
            await exited;
            if (revokeWhileWaiting) {
              await expect(pending).rejects.toThrow("family owner retired during native wait");
              expect(readDurableRows(db)).toEqual(before);
            } else {
              await expect(pending).resolves.toBe(2);
              expect(readDurableRows(db)).toEqual(expected);
            }
          } finally {
            probe.mockRestore();
            channel.close();
            if (Atomics.load(held, 0) === 1) {
              holder.postMessage("release");
            }
            await exited;
            await pending?.catch(() => undefined);
          }
        },
      );
    },
  );

  it.each([
    { label: "ordinary", ...ordinary },
    { label: "description-rich", unrelatedCount: 32, descriptionBytes: 128 * 1024 },
  ])("preserves unrelated $label jobs without fetching their descriptions", async (workload) => {
    await withFamilyStore(workload, async ({ cron, db, staleStore, observation }) => {
      const expected = withoutJobs(readDurableRows(db), staleStore, ["z-declared", "a-legacy"]);
      const commitGuard = vi.fn();
      await expect(cron.removeStaleJobFamily(family, { commitGuard })).resolves.toBe(2);
      expect(commitGuard).toHaveBeenCalled();
      const counter = await observation();
      expect(counter.threadId).toBeGreaterThan(0);
      expect(readDurableRows(db)).toEqual(expected);
      await closeOpenClawStateDatabaseAsync();
      expect(readDurableRows(openOpenClawStateDatabase().db)).toEqual(expected);
      await expect(cron.removeStaleJobFamily(family)).resolves.toBe(0);
      expect(readDurableRows(openOpenClawStateDatabase().db)).toEqual(expected);
      expect(counter.queries).toBeGreaterThan(0);
      expect(counter.rows).toBeGreaterThan(0);
      expect(counter.textBytes).toBeLessThan(16 * 1024);
    });
  });

  it("preserves decoded Unicode, malformed TEXT, and embedded NUL identities", async () => {
    await withFamilyStore(ordinary, async ({ cron, db, staleStore }) => {
      db.prepare("UPDATE cron_jobs SET name = CAST(x'80' AS TEXT) WHERE job_id = 'a-legacy'").run();
      db.prepare(
        "UPDATE cron_jobs SET declaration_key = CAST(x'80' AS TEXT) WHERE job_id = 'z-declared'",
      ).run();
      db.prepare("UPDATE cron_jobs SET name = ?, description = ? WHERE job_id = 'unrelated-0'").run(
        "ASCII\0tail",
        family.ownerPluginTag,
      );
      db.prepare(
        "UPDATE cron_jobs SET name = 'ASCII', description = CAST(x'80' AS TEXT) WHERE job_id = 'unrelated-1'",
      ).run();
      db.prepare(
        "UPDATE cron_jobs SET name = CAST(x'415343494980' AS TEXT) WHERE job_id = 'unrelated-2'",
      ).run();
      const before = readDurableRows(db);
      await expect(
        cron.removeStaleJobFamily({ ...family, declarationKey: "absent", name: "\ud800" }),
      ).resolves.toBe(0);
      expect(readDurableRows(db)).toEqual(before);
      await expect(
        cron.removeStaleJobFamily({ ...family, declarationKey: "absent", name: "\ufffd" }),
      ).resolves.toBe(1);
      await expect(
        cron.removeStaleJobFamily({ ...family, declarationKey: "\ufffd", name: "absent" }),
      ).resolves.toBe(1);
      await expect(
        cron.removeStaleJobFamily({ ...family, declarationKey: "absent", name: "ASCII\0tail" }),
      ).resolves.toBe(1);
      await expect(
        cron.removeStaleJobFamily({
          declarationKey: "absent",
          name: "ASCII",
          ownerPluginTag: "\ufffd",
        }),
      ).resolves.toBe(1);
      const expected = withoutJobs(before, staleStore, [
        "a-legacy",
        "z-declared",
        "unrelated-0",
        "unrelated-1",
      ]);
      expect(readDurableRows(db)).toEqual(expected);
      await closeOpenClawStateDatabaseAsync();
      expect(readDurableRows(openOpenClawStateDatabase().db)).toEqual(expected);
    });
  });

  it("preserves the first deletion error and scratch rollback with extra indexes", async () => {
    await withFamilyStore(ordinary, async ({ cron, db, configure, observation }) => {
      const before = readDurableRows(db);
      for (const indexes of ["canonical", "separate", "covering"]) {
        if (indexes === "separate") {
          db.exec(`CREATE INDEX family_name ON cron_jobs(name);
            CREATE INDEX family_declaration ON cron_jobs(declaration_key);`);
        } else if (indexes === "covering") {
          db.exec(
            "CREATE INDEX family_covering ON cron_jobs(name, description, store_key, job_id, declaration_key)",
          );
        }
        db.exec("ANALYZE cron_jobs");
        for (const reversed of [false, true]) {
          await configure({ reverse: reversed, refuseDelete: true });
          const failed = await cron.removeStaleJobFamily(family).catch((error: unknown) => error);
          const observed = await observation();
          expect(observed.threadId).toBeGreaterThan(0);
          expect(observed.first).toBeDefined();
          expect(failed).toHaveProperty("message", `refused:${observed.first}`);
          expect(readDurableRows(db)).toEqual(before);
        }
      }
      db.exec("PRAGMA reverse_unordered_selects = OFF");
      await closeOpenClawStateDatabaseAsync();
      expect(readDurableRows(openOpenClawStateDatabase().db)).toEqual(before);
    });
  });

  it("retains column authorization and needs no SQL function authorization", async () => {
    await withFamilyStore(ordinary, async ({ cron, db, staleStore, configure }) => {
      const before = readDurableRows(db);
      for (const column of ["store_key", "job_id", "declaration_key", "name", "description"]) {
        await configure({ denyColumn: column });
        await expect(cron.removeStaleJobFamily(family)).rejects.toThrow(
          /prohibited|not authorized/i,
        );
        expect(readDurableRows(db)).toEqual(before);
      }
      await configure({ ignoreDescription: true });
      await expect(cron.removeStaleJobFamily(family)).resolves.toBe(1);
      expect(readDurableRows(db)).toEqual(withoutJobs(before, staleStore, ["z-declared"]));
      await configure({ denyFunctions: true });
      await expect(cron.removeStaleJobFamily(family)).resolves.toBe(1);
      expect(readDurableRows(db)).toEqual(
        withoutJobs(before, staleStore, ["z-declared", "a-legacy"]),
      );
    });
  });

  it("rechecks live authority after waiting for the service lock", async () => {
    await withFamilyStore(ordinary, async ({ cron, db }) => {
      const entered = createDeferred();
      const release = createDeferred();
      const blocker = cron.updateWithPrecondition("active-owned", {}, async () => {
        entered.resolve();
        await release.promise;
      });
      let pruning: Promise<number> | undefined;
      let rejected: Promise<void> | undefined;
      try {
        await Promise.race([entered.promise, blocker]);
        let active = true;
        const guard = vi.fn(() => {
          if (!active) {
            throw new Error("family owner retired");
          }
        });
        pruning = cron.removeStaleJobFamily(family, { commitGuard: guard });
        rejected = expect(pruning).rejects.toThrow("family owner retired");
        expect(guard).not.toHaveBeenCalled();
        active = false;
        release.resolve();
        await blocker;
        const before = readDurableRows(db);
        await rejected;
        expect(guard).toHaveBeenCalledOnce();
        expect(readDurableRows(db)).toEqual(before);
      } finally {
        release.resolve();
        await Promise.allSettled([
          blocker,
          ...(pruning ? [pruning] : []),
          ...(rejected ? [rejected] : []),
        ]);
      }
    });
  });

  it("refuses a captured store generation closed while waiting in the service FIFO", async () => {
    await withFamilyStore(ordinary, async ({ cron, db }) => {
      const before = readDurableRows(db);
      const entered = createDeferred();
      const release = createDeferred();
      const blocker = cron.updateWithPrecondition("active-owned", {}, async () => {
        entered.resolve();
        await release.promise;
      });
      await Promise.race([entered.promise, blocker]);
      const pruning = cron.removeStaleJobFamily(family);
      const result = pruning.then(
        () => "unexpected success",
        (error: unknown) => error,
      );
      try {
        await closeOpenClawStateDatabaseAsync();
        release.resolve();
        await blocker.catch(() => undefined);
        expect(await result).toBeInstanceOf(Error);
        expect(readDurableRows(openOpenClawStateDatabase().db)).toEqual(before);
      } finally {
        release.resolve();
        await Promise.allSettled([blocker, pruning]);
      }
    });
  });
});
