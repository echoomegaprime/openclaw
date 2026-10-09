/* oxlint-disable unicorn/require-post-message-target-origin -- Node worker channels have no targetOrigin. */
import { once } from "node:events";
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextFrame } from "node:timers/promises";
import { BroadcastChannel, Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import { openSharedStateSqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import { acquireStateDatabaseCoordinator } from "../../infra/state-database-coordinator.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

vi.mock("../../infra/runtime-process-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/runtime-process-url.js")>();
  const { resolveRuntimeWorkerUrl } = await import("../../infra/runtime-worker-url.js");
  return {
    ...actual,
    resolveRuntimeProcessEntrypointUrl: (
      name: Parameters<typeof actual.resolveRuntimeProcessEntrypointUrl>[0],
    ) =>
      name === "sharedStateStore"
        ? resolveRuntimeWorkerUrl({
            currentModuleUrl: import.meta.url,
            sourceWorkerName: "ingress-admission.worker.test-support",
            distWorkerPath: "channels/message/ingress-admission.worker.test-support.js",
          })
        : actual.resolveRuntimeProcessEntrypointUrl(name),
  };
});

it("keeps admission responsive after exact coordinator acquisition starts and dispatches once", async () => {
  await withOpenClawTestState({ label: "ingress-real-contention" }, async (state) => {
    const queue = createChannelIngressQueue<{ version: number; id: string }>({
      channelId: "discord",
      stateDir: state.stateDir,
    });
    const db = openOpenClawStateDatabase();
    const context = captureOpenClawStateWorkerContext();
    const control = await openSharedStateSqliteWorkerStore(
      {
        moduleUrl: resolveRuntimeProcessEntrypointUrl("sharedStateStore"),
        databasePath: context.admission.databasePath,
      },
      context,
    );
    if (!control) {
      throw new Error("fixture worker absent");
    }
    const coordinator = acquireStateDatabaseCoordinator({ databasePath: db.path });
    const coordinatorPath = coordinator.path;
    coordinator.release();
    const identity = statSync(coordinatorPath, { bigint: true });
    const held = new Int32Array(new SharedArrayBuffer(4));
    const attempted = new Int32Array(new SharedArrayBuffer(8));
    const channel = new BroadcastChannel(`ingress-admission-probe:${db.path}`);
    const armed = once(channel, "message");
    channel.postMessage({ attempted, coordinatorPath });
    await armed;
    const holder = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads'); const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(workerData.path); db.exec('BEGIN EXCLUSIVE'); Atomics.store(workerData.held,0,1); parentPort.on('message',()=>{db.exec('ROLLBACK');db.close();Atomics.store(workerData.held,0,0);parentPort.close()});parentPort.postMessage('held');`,
      { eval: true, execArgv: [], env: {}, workerData: { path: coordinatorPath, held } },
    );
    const exited = once(holder, "exit");
    // oxlint-disable-next-line typescript/unbound-method -- Native receiver is preserved.
    const exec = DatabaseSync.prototype.exec;
    const probe = vi
      .spyOn(DatabaseSync.prototype, "exec")
      .mockImplementation(function (this: DatabaseSync, sql) {
        if (sql.includes("BEGIN EXCLUSIVE")) {
          const location = this.location();
          const physical = location && statSync(location, { bigint: true });
          if (physical && physical.dev === identity.dev && physical.ino === identity.ino) {
            Atomics.store(attempted, 0, 1);
            Atomics.notify(attempted, 0);
          }
        }
        return exec.call(this, sql);
      });
    const dispatch = vi.fn(async () => ({ kind: "completed" as const }));
    const monitor = createChannelIngressMonitor<
      { id: string },
      { id: string },
      { version: number; id: string }
    >({
      queue,
      inspect: (raw) => ({ eventId: raw.id, laneKey: "channel:2001" }),
      payload: {
        version: 1,
        serialize: (raw) => raw,
        deserialize: (body) => body,
        encode: ({ body }) => ({ version: 1, ...body }),
        decode: (stored) => ({ version: stored.version, body: { id: stored.id } }),
        createClaimError: () => new Error("invalid fixture"),
      },
      deliver: dispatch,
      pollIntervalMs: 60_000,
      retention: { pruneIntervalMs: 0 },
      appendRetryDelaysMs: [0],
    });
    let pending: Promise<unknown> | undefined;
    let completed = false;
    try {
      await once(holder, "message");
      monitor.start();
      pending = monitor.admit({ id: "1001" });
      void pending.then(
        () => {
          completed = true;
        },
        () => {
          completed = true;
        },
      );
      await Promise.race([Promise.resolve(Atomics.waitAsync(attempted, 0, 0).value), pending]);
      await nextFrame();
      expect(Atomics.load(held, 0)).toBe(1);
      expect(completed).toBe(false);
      expect(Atomics.load(attempted, 1)).toBeGreaterThan(0);
      expect(
        db.db
          .prepare("SELECT COUNT(*) AS n FROM channel_ingress_events WHERE event_id='1001'")
          .get()?.n,
      ).toBe(0);
      expect(dispatch).not.toHaveBeenCalled();
      holder.postMessage("release");
      await exited;
      await pending;
      await monitor.waitForIdle();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(
        db.db
          .prepare("SELECT COUNT(*) AS n FROM channel_ingress_events WHERE event_id='1001'")
          .get()?.n,
      ).toBe(1);
    } finally {
      probe.mockRestore();
      channel.close();
      if (Atomics.load(held, 0) === 1) {
        holder.postMessage("release");
      }
      await exited;
      await pending?.catch(() => {});
      await monitor.stop();
      await control.close();
      await closeOpenClawStateDatabaseAsync();
    }
  });
});
