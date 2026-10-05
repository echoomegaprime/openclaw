import { resolveMemoryDeepDreamingConfig } from "openclaw/plugin-sdk/memory-core-host-status";
import { describe, expect, it, vi } from "vitest";
import { type CronServiceLike, reconcileShortTermDreamingCronJob } from "./dreaming-cron.js";

type ManagedJob = Awaited<ReturnType<CronServiceLike["list"]>>[number];
type StoredJob = ManagedJob & {
  state: {
    consecutiveErrors: number;
    scheduleErrorCount: number;
    lastRunAtMs: number;
    lastStatus: "error";
    lastError: string;
    autoDisabled?: {
      reason: "consecutive-failures" | "schedule-errors";
      atMs: number;
      consecutiveErrors: number;
    };
  };
};

function createHarness() {
  const jobs: ManagedJob[] = [];
  const updates: Array<Parameters<CronServiceLike["update"]>[1]> = [];
  const cron: CronServiceLike = {
    list: async () => structuredClone(jobs),
    add: async (input) => {
      jobs.push({ ...structuredClone(input), id: "dreaming-test" });
    },
    update: async (id, patch) => {
      const job = jobs.find((entry) => entry.id === id);
      if (!job) {
        throw new Error("missing test job");
      }
      updates.push(structuredClone(patch));
      Object.assign(job, structuredClone(patch));
    },
    remove: async () => ({ removed: false }),
    removeStaleJobFamily: async () => 0,
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const reconcile = (frequency = "0 3 * * *") =>
    reconcileShortTermDreamingCronJob({
      cron,
      logger,
      config: resolveMemoryDeepDreamingConfig({
        pluginConfig: { dreaming: { enabled: true, frequency, timezone: "UTC" } },
      }),
    });
  const firstJob = () => {
    const job = jobs[0];
    if (!job) {
      throw new Error("managed job was not created");
    }
    return job;
  };
  return { jobs, updates, reconcile, firstJob };
}

describe("managed dreaming cron enable ownership", () => {
  it.each([
    { label: "run failure cutoff", reason: "consecutive-failures", count: 10 },
    { label: "schedule failure cutoff", reason: "schedule-errors", count: 3 },
    { label: "operator pause", reason: undefined, count: 0 },
  ] as const)(
    "preserves $label across reconciliation and metadata changes",
    async ({ reason, count }) => {
      const harness = createHarness();
      await harness.reconcile();
      const stopped: StoredJob = {
        ...harness.firstJob(),
        enabled: false,
        state: {
          consecutiveErrors: reason === "consecutive-failures" ? count : 0,
          scheduleErrorCount: reason === "schedule-errors" ? count : 0,
          lastRunAtMs: 1_785_558_600_000,
          lastStatus: "error",
          lastError: "retained test failure",
          ...(reason
            ? { autoDisabled: { reason, atMs: 1_785_558_600_100, consecutiveErrors: count } }
            : {}),
        },
      };
      harness.jobs[0] = stopped;
      const retainedState = structuredClone(stopped.state);

      for (let pass = 0; pass < 3; pass++) {
        expect(await harness.reconcile()).toEqual({ status: "noop", removed: 0 });
        expect(stopped.enabled).toBe(false);
        expect(stopped.state).toEqual(retainedState);
      }
      expect(harness.updates).toEqual([]);

      expect(await harness.reconcile("15 4 * * *")).toEqual({ status: "updated", removed: 0 });
      expect(harness.updates).toEqual([
        { schedule: { kind: "cron", expr: "15 4 * * *", tz: "UTC" } },
      ]);
      expect(stopped.enabled).toBe(false);
      expect(stopped.state).toEqual(retainedState);
      expect(await harness.reconcile("15 4 * * *")).toEqual({ status: "noop", removed: 0 });
      expect(stopped.enabled).toBe(false);
      expect(stopped.state).toEqual(retainedState);
    },
  );

  it("creates a new managed job enabled and leaves it enabled", async () => {
    const harness = createHarness();
    expect(await harness.reconcile()).toEqual({ status: "added", removed: 0 });
    expect(harness.firstJob().enabled).toBe(true);
    expect(await harness.reconcile()).toEqual({ status: "noop", removed: 0 });
    expect(harness.firstJob().enabled).toBe(true);
    expect(harness.updates).toEqual([]);
  });
});
