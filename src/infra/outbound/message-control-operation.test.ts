import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type {
  MessageControlStableBinding,
  MessageControlExecution,
} from "./message-control-operation.types.js";

const temps = useAutoCleanupTempDirTracker(afterAll);
const stable: MessageControlStableBinding = {
  version: 1,
  principal: { kind: "gateway-profile", profileId: "profile-1" },
  session: { kind: "sessionless" },
  intent: {
    action: "guild-media-filter-set-all-members",
    channelId: "discord",
    accountId: "default",
    expectedBotId: "1385881607952404640",
    guildId: "1476211213699514509",
    expectedCurrent: 0,
    desired: 2,
  },
};
const execution: MessageControlExecution = {
  version: 1,
  requestId: "request-1",
  connectionId: "connection-1",
  gatewayInstanceId: "instance-1",
  run: null,
  policyFingerprint: "a".repeat(64),
  providerRegistrationFingerprint: "b".repeat(64),
  databaseIdentityFingerprint: "c".repeat(64),
  databaseGeneration: { kind: "process-local", captured: true },
  admittedAtMs: 100,
};

// Dynamic loading makes the missing owner an explicit contract failure on the baseline.
async function owner() {
  const module = await import("./message-control-operation.kernel.js").catch(() => undefined);
  expect(module, "the durable message-control owner must exist").toBeDefined();
  return module!;
}
function openFixture(file: string) {
  const db = new DatabaseSync(file);
  const sql = readFileSync(
    new URL("../../state/openclaw-state-schema.sql", import.meta.url),
    "utf8",
  );
  const start = sql.indexOf("\nCREATE TABLE IF NOT EXISTS channel_control_operations (\n");
  expect(start, "canonical state owns the control-operation table").toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("-- END channel_control_operations", start);
  expect(end).toBeGreaterThan(start);
  db.exec(sql.slice(start, end));
  return db;
}
function transaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

describe("durable fixed message-control operations", () => {
  it("refuses new admission at capacity while preserving an existing receipt and every held record", async () => {
    const api = await owner();
    const db = openFixture(":memory:");
    const input = (index: number) => ({
      key: `capacity-${index}`,
      operationId: `operation-${index}`,
      attemptId: `attempt-${index}`,
      stable: { ...stable, intent: { ...stable.intent, guildId: String(1000 + index) } },
      execution,
    });
    try {
      transaction(db, () => {
        for (let index = 0; index < 4096; index++) {
          expect(api.admitMessageControlOperation(db, input(index)).disposition).toBe("admitted");
        }
      });
      expect(transaction(db, () => api.admitMessageControlOperation(db, input(4096)))).toEqual({
        disposition: "capacity",
      });
      expect(transaction(db, () => api.admitMessageControlOperation(db, input(0)))).toMatchObject({
        disposition: "receipt",
        record: { operationId: "operation-0", held: true },
      });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM channel_control_operations WHERE held = 1").get(),
      ).toEqual({ count: 4096 });
    } finally {
      db.close();
    }
  }, 30_000);
  it.each([
    { result: { disposition: "invented", at: 101, atomicCas: false }, observation: null },
    { result: { disposition: "noop", at: 99, atomicCas: false }, observation: null },
    { result: { disposition: "noop", at: 101, atomicCas: true }, observation: null },
    {
      result: { disposition: "noop", at: 101, atomicCas: false, extra: "not-allowed" },
      observation: null,
    },
    {
      result: { disposition: "noop", at: 101, atomicCas: false },
      observation: { value: 3, at: 102 },
    },
    { result: { disposition: "unknown", at: 101, atomicCas: false }, observation: null },
  ])("rejects corrupted retained result/observation data: %j", async ({ result, observation }) => {
    const api = await owner();
    const db = openFixture(":memory:");
    try {
      transaction(db, () =>
        api.admitMessageControlOperation(db, {
          key: "corrupt",
          operationId: "op",
          attemptId: "attempt",
          stable,
          execution,
        }),
      );
      db.prepare(
        "UPDATE channel_control_operations SET phase='settled', held=0, result_json=?, observation_json=?, updated_at_ms=102",
      ).run(JSON.stringify(result), observation ? JSON.stringify(observation) : null);
      expect(() =>
        api.readMessageControlOperation(db, {
          namespace: '[1,"gateway-profile","profile-1"]',
          operationId: "op",
        }),
      ).toThrow(/invalid/i);
    } finally {
      db.close();
    }
  });
  it("retains uncertain handoff across reopening and never admits a replay or another account", async () => {
    const api = await owner();
    const file = path.join(temps.make("message-control-"), "state.sqlite");
    let db = openFixture(file);
    const input = { key: "once", operationId: "op-1", attemptId: "attempt-1", stable, execution };
    try {
      const admitted = transaction(db, () => api.admitMessageControlOperation(db, input));
      expect(admitted.disposition).toBe("admitted");
      if (!("record" in admitted)) {
        throw new Error("Fixture admission missing");
      }
      transaction(db, () =>
        api.markMessageControlDispatched(db, {
          operationId: "op-1",
          attemptId: "attempt-1",
          namespace: admitted.record.namespace,
          now: 101,
        }),
      );
      db.close();
      db = openFixture(file);
      const replay = transaction(db, () =>
        api.admitMessageControlOperation(db, {
          ...input,
          operationId: "op-2",
          attemptId: "attempt-2",
          execution: { ...execution, connectionId: "reconnected" },
        }),
      );
      expect(replay.disposition).toBe("receipt");
      if (!("record" in replay)) {
        throw new Error("Fixture receipt missing");
      }
      expect(replay.record.phase).toBe("dispatching");
      expect(replay.record.execution.connectionId).toBe("connection-1");
      expect(
        transaction(db, () =>
          api.admitMessageControlOperation(db, {
            ...input,
            key: "another",
            operationId: "op-3",
            stable: { ...stable, intent: { ...stable.intent, accountId: "another" } },
          }),
        ).disposition,
      ).toBe("held");
      const observed = transaction(db, () =>
        api.observeMessageControlOperation(db, {
          operationId: "op-1",
          namespace: admitted.record.namespace,
          now: 102,
          value: 2,
        }),
      );
      expect(observed?.held).toBe(true);
      expect(observed?.result).toBeNull();
    } finally {
      db.close();
    }
  });

  it("isolates receipt namespaces, preserves expected zero, and rejects changed stable intent", async () => {
    const api = await owner();
    const db = openFixture(":memory:");
    try {
      const input = { key: "request", operationId: "op", attemptId: "attempt", stable, execution };
      const first = transaction(db, () => api.admitMessageControlOperation(db, input));
      if (!("record" in first)) {
        throw new Error("Fixture admission missing");
      }
      expect(first.record.stable.intent.expectedCurrent).toBe(0);
      expect(
        api.readMessageControlOperation(db, {
          operationId: "op",
          namespace: '[1,"gateway-profile","other"]',
        }),
      ).toBeNull();
      expect(
        transaction(db, () =>
          api.admitMessageControlOperation(db, {
            ...input,
            stable: { ...stable, intent: { ...stable.intent, expectedCurrent: 1 } },
          }),
        ).disposition,
      ).toBe("conflict");
      expect(() =>
        transaction(db, () =>
          api.admitMessageControlOperation(db, {
            ...input,
            stable: Object.assign({}, stable, { extra: true }),
          }),
        ),
      ).toThrow(/invalid/i);
      expect(() =>
        transaction(db, () =>
          api.admitMessageControlOperation(db, {
            ...input,
            stable: {
              ...stable,
              principal: { kind: "gateway-profile", profileId: "é".repeat(129) },
            },
          }),
        ),
      ).toThrow(/invalid/i);
    } finally {
      db.close();
    }
  });

  it("permits exact original settlement only and retains unknown fences", async () => {
    const api = await owner();
    const db = openFixture(":memory:");
    try {
      const first = transaction(db, () =>
        api.admitMessageControlOperation(db, {
          key: "settle",
          operationId: "op",
          attemptId: "attempt",
          stable,
          execution,
        }),
      );
      if (!("record" in first)) {
        throw new Error("Fixture admission missing");
      }
      const identity = {
        operationId: "op",
        attemptId: "attempt",
        namespace: first.record.namespace,
        now: 101,
      };
      expect(() =>
        transaction(db, () =>
          api.settleMessageControlOperation(db, {
            ...identity,
            attemptId: "wrong",
            disposition: "not_entered",
          }),
        ),
      ).toThrow(/identity/i);
      transaction(db, () => api.markMessageControlDispatched(db, identity));
      transaction(db, () =>
        api.settleMessageControlOperation(db, { ...identity, disposition: "unknown" }),
      );
      const record = api.readMessageControlOperation(db, identity);
      expect(record?.held).toBe(true);
      expect(record?.phase).toBe("unknown");
      expect(() =>
        transaction(db, () =>
          api.settleMessageControlOperation(db, { ...identity, disposition: "not_entered" }),
        ),
      ).toThrow(/transition/i);
    } finally {
      db.close();
    }
  });
});
