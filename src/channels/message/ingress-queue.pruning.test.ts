// Pruning keeps durable ingress retention bounded without loading retained rows.
import { once } from "node:events";
import { BroadcastChannel } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createTestIngressQueue, withTempState } from "./ingress-drain.test-helpers.js";

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

type ChannelIngressTestDatabase = Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">;

describe("channel ingress pruning", () => {
  it("can bound pending scans and prune stale pending rows", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue(stateDir, { now: () => clock++ });

      await queue.enqueue("0002", { text: "second" });
      await queue.enqueue("0001", { text: "first" });
      await queue.enqueue("0003", { text: "third" });

      expect(
        (await queue.listPending({ limit: 2, orderBy: "id" })).map((record) => record.id),
      ).toEqual(["0001", "0002"]);
      expect(await queue.prune({ pendingTtlMs: 3, pendingMaxEntries: 1, now: 7 })).toBe(2);
      expect((await queue.listPending({ limit: "all" })).map((record) => record.id)).toEqual([
        "0003",
      ]);
    });
  });

  it("does not prune protected rows while enforcing max-entry limits", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10 });

      await queue.enqueue("z", { text: "first" });
      await queue.enqueue("a", { text: "second" });

      expect(await queue.prune({ pendingMaxEntries: 1, protectIds: ["a"] })).toBe(0);
      expect(
        (await queue.listPending({ limit: "all", orderBy: "id" })).map((row) => row.id),
      ).toEqual(["a", "z"]);
    });
  });

  it.each(["pending", "completed", "failed"] as const)(
    "prunes %s overflow without materializing the retained prefix",
    async (status) => {
      await withTempState(async (stateDir) => {
        let clock = 1;
        const queue = createTestIngressQueue(stateDir, { now: () => clock++ });

        for (let index = 0; index < 520; index += 1) {
          const id = String(index).padStart(4, "0");
          await queue.enqueue(id, { text: String(index) });
          if (status === "completed") {
            await queue.complete(id);
          } else if (status === "failed") {
            await queue.fail(id, { reason: "fixture" });
          }
        }

        const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
        const { db } = database;
        const rowCounts = new Int32Array(new SharedArrayBuffer(4));
        const observation = new BroadcastChannel(`ingress-admission-probe:${database.path}`);
        const armed = once(observation, "message");
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker channel.
        observation.postMessage({ rowCounts });
        await armed;
        try {
          const pruneOptions = { [`${status}MaxEntries`]: 2 };
          expect(await queue.prune(pruneOptions)).toBe(518);
          expect(Atomics.load(rowCounts, 0)).toBe(518);
          expect(await queue.prune(pruneOptions)).toBe(0);
          expect(Atomics.load(rowCounts, 0)).toBe(518);
        } finally {
          observation.close();
        }
        expect(
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<ChannelIngressTestDatabase>(db)
              .selectFrom("channel_ingress_events")
              .select("event_id")
              .orderBy("event_id", "asc"),
          ).rows.map((row) => row.event_id),
        ).toEqual(["0518", "0519"]);
      });
    },
  );
});
