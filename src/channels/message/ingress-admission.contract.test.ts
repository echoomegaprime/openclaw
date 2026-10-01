import { afterEach, expect, it, vi } from "vitest";
import {
  hasUnknownSqliteWorkerOutcome,
  isSqliteWorkerError,
  retainSqliteWorkerErrorCode,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createMonitor } from "./ingress-monitor.test-harness.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

afterEach(() => vi.restoreAllMocks());

it("recognizes only retained canonical uncertainty without changing aggregate retry eligibility", () => {
  const unknown = new SqliteWorkerError("fixture", "outcome-unknown");
  const aggregate = retainSqliteWorkerErrorCode(new AggregateError([unknown], "fixture"), unknown);
  expect(hasUnknownSqliteWorkerOutcome(unknown)).toBe(true);
  expect(hasUnknownSqliteWorkerOutcome(aggregate)).toBe(true);
  expect(isSqliteWorkerError(aggregate, "outcome-unknown")).toBe(false);
  expect(isSqliteWorkerError(unknown, "outcome-unknown")).toBe(true);
  for (const unmarked of [
    new AggregateError([unknown], "outcome-unknown"),
    Object.assign(new AggregateError([], "fixture"), {
      code: "outcome-unknown",
      name: "SqliteWorkerError",
    }),
    Object.assign(new Error("outcome-unknown"), { code: "outcome-unknown" }),
    retainSqliteWorkerErrorCode(
      new AggregateError([], "fixture"),
      new SqliteWorkerError("fixture", "unavailable"),
    ),
  ]) {
    expect(hasUnknownSqliteWorkerOutcome(unmarked)).toBe(false);
  }
});

it("keeps no-op pruning noncreating and snapshots admitted payload before yielding", async () => {
  await withOpenClawTestState({ label: "ingress-snapshot" }, async () => {
    const worker = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
    const queue = createChannelIngressQueue({ channelId: "test" });
    await expect(queue.prune()).resolves.toBe(0);
    expect(worker).not.toHaveBeenCalled();
    const payload = { original: "Unicode 原文" };
    const pending = queue.enqueue("snapshot", payload);
    payload.original = "changed after admission";
    await expect(pending).resolves.toMatchObject({
      kind: "accepted",
      record: { payload: { original: "Unicode 原文" } },
    });
  });
});

it.each([
  new Error("known append refusal"),
  new SqliteWorkerError("known broker refusal", "unavailable"),
])("retains existing retry policy for known pre-admission refusal", async (failure) => {
  await withOpenClawTestState({ label: "ingress-known-retry" }, async () => {
    const queue = createChannelIngressQueue<{ version: 1; rawEvent: string }>({
      channelId: "test",
    });
    const enqueue = vi.spyOn(queue, "enqueue").mockRejectedValueOnce(failure);
    const monitor = createMonitor(queue, async () => ({ kind: "completed" }), {
      appendRetryDelaysMs: [0, 0],
    });
    try {
      await expect(
        monitor.admit({ id: "known", lane: "same", text: "fixture" }),
      ).resolves.toMatchObject({ kind: "durable", queueResult: { kind: "accepted" } });
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT COUNT(*) AS n FROM channel_ingress_events WHERE event_id='known'")
          .get()?.n,
      ).toBe(1);
    } finally {
      await monitor.stop();
    }
  });
});

it.each(["transaction", "commit"])(
  "rolls back enqueue and prune when retained owner is revoked at %s",
  async (stage) => {
    await withOpenClawTestState({ label: `ingress-revoke-${stage}` }, async () => {
      let current = true;
      const queue = createChannelIngressQueue({ channelId: "test" }, () => {
        if (!current) {
          throw new Error("fixture owner revoked");
        }
      });
      await queue.enqueue("retained", { original: true }, { receivedAt: 1 });
      const db = openOpenClawStateDatabase().db;
      db.prepare(
        "UPDATE channel_ingress_events SET status='completed',completed_at=1 WHERE event_id='retained'",
      ).run();
      const original = operationAdmission.createSqliteWorkerOperationAdmission;
      const stages: string[] = [];
      vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (handler) =>
          original((request, grant) => {
            stages.push(request.stage);
            if (request.stage === stage) {
              current = false;
            }
            return handler(request, grant);
          }),
      );
      await expect(queue.enqueue("new", {})).rejects.toThrow("fixture owner revoked");
      expect(stages).toEqual(stage === "commit" ? ["transaction", "commit"] : ["transaction"]);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM channel_ingress_events WHERE event_id='new'").get()
          ?.n,
      ).toBe(0);
      current = true;
      stages.length = 0;
      await expect(queue.prune({ now: 100, completedTtlMs: 1 })).rejects.toThrow(
        "fixture owner revoked",
      );
      expect(stages).toEqual(stage === "commit" ? ["transaction", "commit"] : ["transaction"]);
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM channel_ingress_events WHERE event_id='retained'")
          .get()?.n,
      ).toBe(1);
    });
  },
);

it("preserves a successful committed outcome when owner revokes after its commit grant", async () => {
  await withOpenClawTestState({ label: "ingress-postcommit" }, async () => {
    let current = true;
    const queue = createChannelIngressQueue({ channelId: "test" }, () => {
      if (!current) {
        throw new Error("fixture revoked");
      }
    });
    const original = operationAdmission.createSqliteWorkerOperationAdmission;
    vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (handler) =>
        original((request, grant) =>
          handler(request, () => {
            const granted = grant();
            if (request.stage === "commit" && granted) {
              current = false;
            }
            return granted;
          }),
        ),
    );
    await expect(queue.enqueue("committed", {})).resolves.toMatchObject({ kind: "accepted" });
    expect(
      openOpenClawStateDatabase()
        .db.prepare("SELECT COUNT(*) AS n FROM channel_ingress_events WHERE event_id='committed'")
        .get()?.n,
    ).toBe(1);
    await expect(queue.enqueue("stale", {})).rejects.toThrow("fixture revoked");
  });
});

it.each([false, true])(
  "does not replay a committed append after its worker reply is lost (cleanup aggregate=%s)",
  async (cleanupAggregate) => {
    await withOpenClawTestState({ label: "ingress-lost-reply" }, async () => {
      const queue = createChannelIngressQueue<{ version: 1; rawEvent: string }>({
        channelId: "test",
      });
      const enqueue = vi.spyOn(queue, "enqueue");
      const run = stateWorker.runOpenClawStateWorkerOperation;
      const originalFailure = new SqliteWorkerError("fixture response lost", "outcome-unknown");
      const failure = cleanupAggregate
        ? retainSqliteWorkerErrorCode(
            new AggregateError(
              [originalFailure, new Error("fixture cleanup failed")],
              "fixture aggregate",
            ),
            originalFailure,
          )
        : originalFailure;
      vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
        async (...args) => {
          const result = await run(...args);
          if (
            result &&
            typeof result === "object" &&
            "kind" in result &&
            result.kind === "accepted"
          ) {
            throw failure;
          }
          return result;
        },
      );
      const dispatch = vi.fn(async () => ({ kind: "completed" as const }));
      const monitor = createMonitor(queue, dispatch, { appendRetryDelaysMs: [0, 0, 0] });
      try {
        await expect(monitor.admit({ id: "once", lane: "same", text: "private" })).rejects.toBe(
          failure,
        );
        expect(enqueue).toHaveBeenCalledOnce();
        expect(dispatch).not.toHaveBeenCalled();
        expect(
          openOpenClawStateDatabase()
            .db.prepare("SELECT COUNT(*) AS n FROM channel_ingress_events WHERE event_id='once'")
            .get()?.n,
        ).toBe(1);
      } finally {
        await monitor.stop();
      }
    });
  },
);

it("preserves duplicate dispositions and original Unicode bytes across concurrent appends", async () => {
  await withOpenClawTestState({ label: "ingress-duplicates" }, async () => {
    const queue = createChannelIngressQueue({ channelId: "test" });
    for (const status of ["pending", "claimed", "completed", "failed"]) {
      await queue.enqueue(
        status,
        { text: "原文\uFEFF", nested: ["\u0085"] },
        { receivedAt: 7, laneKey: "original", metadata: { source: "original" } },
      );
      const db = openOpenClawStateDatabase().db;
      db.prepare(
        "UPDATE channel_ingress_events SET status=?,claim_token='original-token',claim_owner='original-owner',claimed_at=7,last_error='original-error',attempts=3 WHERE event_id=?",
      ).run(status, status);
      const before = db
        .prepare("SELECT * FROM channel_ingress_events WHERE event_id=?")
        .get(status);
      await Promise.all([
        queue.enqueue(status, { changed: 1 }, { laneKey: "changed" }),
        queue.enqueue(status, { changed: 2 }),
      ]);
      expect(
        db.prepare("SELECT * FROM channel_ingress_events WHERE event_id=?").get(status),
      ).toEqual(before);
    }
  });
});
