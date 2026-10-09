import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import * as admissionOwner from "../sqlite-worker-operation-admission.js";
import { createMessageControlStore } from "./message-control-operation.store.js";
import type { MessageControlAdmission } from "./message-control-operation.types.js";

const diagnostics = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (...args: Parameters<typeof original.createSubsystemLogger>) => {
      const logger = original.createSubsystemLogger(...args);
      if (args[0] !== "outbound/message-control") {
        return logger;
      }
      return {
        ...logger,
        debug: () => {
          diagnostics.calls++;
          if (diagnostics.fail) {
            throw new Error("Optional log sink unavailable");
          }
        },
      };
    },
  };
});

const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    diagnostics.fail = false;
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
function fixture(assertCurrent: () => void = () => {}) {
  const root = temps.make("message-control-worker-");
  const options = { path: path.join(root, "state.sqlite"), env: { OPENCLAW_STATE_DIR: root } };
  const store = createMessageControlStore({ stateOptions: options, assertCurrent });
  const admission: MessageControlAdmission = {
    key: "first",
    operationId: "operation",
    attemptId: "attempt",
    stable: {
      version: 1,
      principal: { kind: "gateway-system-owner" },
      session: { kind: "sessionless" },
      intent: {
        action: "guild-media-filter-set-all-members",
        channelId: "discord",
        accountId: "default",
        expectedBotId: "111",
        guildId: "222",
        expectedCurrent: 0,
        desired: 2,
      },
    },
    execution: {
      version: 1,
      requestId: "request",
      connectionId: "connection",
      gatewayInstanceId: "boot",
      run: null,
      policyFingerprint: "a".repeat(64),
      providerRegistrationFingerprint: "b".repeat(64),
      databaseIdentityFingerprint: store.databaseIdentityFingerprint,
      databaseGeneration: { kind: "process-local", captured: true },
      admittedAtMs: 1,
    },
  };
  return {
    store,
    admission,
    options,
    locator: { namespace: '[1,"gateway-system-owner"]', operationId: "operation" },
  };
}
describe("message-control managed worker custody", () => {
  it("preserves committed admission and settlement when optional diagnostics throw", async () => {
    const f = fixture();
    const before = diagnostics.calls;
    diagnostics.fail = true;
    expect(await f.store.admit(f.admission)).toMatchObject({ disposition: "admitted" });
    const result = await f.store.settle({
      ...f.locator,
      attemptId: "attempt",
      now: 2,
      disposition: "not_entered",
    });
    expect(result).toMatchObject({
      phase: "settled",
      held: false,
      result: { disposition: "not_entered" },
    });
    expect(await f.store.read(f.locator)).toEqual(result);
    expect(diagnostics.calls - before).toBe(2);
  });
  it("does not create an absent database on receipt read and rejects a revoked caller", async () => {
    let current = true;
    const f = fixture(() => {
      if (!current) {
        throw new Error("revoked");
      }
    });
    expect(await f.store.read(f.locator)).toBeNull();
    expect(existsSync(f.options.path)).toBe(false);
    current = false;
    await expect(f.store.admit(f.admission)).rejects.toThrow(/revoked/);
    expect(existsSync(f.options.path)).toBe(false);
  });
  it("commits immutable intent through typed native admission and retains unknown after reopen", async () => {
    const f = fixture();
    const stages: string[] = [];
    const create = admissionOwner.createSqliteWorkerOperationAdmission;
    vi.spyOn(admissionOwner, "createSqliteWorkerOperationAdmission").mockImplementation((admit) =>
      create((request, grant) => {
        stages.push(request.stage);
        admit(request, grant);
      }),
    );
    const pending = f.store.admit(f.admission);
    f.admission.stable.intent.guildId = "333";
    const admitted = await pending;
    expect(admitted).toMatchObject({
      disposition: "admitted",
      record: { stable: { intent: { guildId: "222", expectedCurrent: 0 } } },
    });
    expect(stages).toEqual(["transaction", "commit"]);
    await f.store.dispatch({ ...f.locator, attemptId: "attempt", now: 2 });
    await f.store.settle({ ...f.locator, attemptId: "attempt", now: 3, disposition: "unknown" });
    await closeOpenClawStateDatabaseAsync();
    const reopened = createMessageControlStore({ stateOptions: f.options, assertCurrent() {} });
    expect(await reopened.read(f.locator)).toMatchObject({ phase: "unknown", held: true });
    expect(await reopened.observe({ ...f.locator, now: 4, value: 2 })).toMatchObject({
      phase: "unknown",
      held: true,
      observation: { value: 2 },
    });
    expect(await reopened.cancel(f.locator)).toMatchObject({
      phase: "unknown",
      held: true,
      cancelRequested: true,
    });
    expect(
      await reopened.read({ ...f.locator, namespace: '[1,"gateway-profile","elsewhere"]' }),
    ).toBeNull();
  });
  it.each(["transaction", "commit"])(
    "denial at %s rolls back first-use intent without a false receipt",
    async (deniedStage) => {
      let current = true;
      const f = fixture(() => {
        if (!current) {
          throw new Error("revoked before commit");
        }
      });
      const create = admissionOwner.createSqliteWorkerOperationAdmission;
      const spy = vi
        .spyOn(admissionOwner, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit) =>
          create((request, grant) => {
            if (request.stage === deniedStage) {
              current = false;
            }
            admit(request, grant);
          }),
        );
      await expect(f.store.admit(f.admission)).rejects.toThrow();
      spy.mockRestore();
      current = true;
      const fresh = createMessageControlStore({ stateOptions: f.options, assertCurrent() {} });
      expect(await fresh.read(f.locator)).toBeNull();
      // A rolled-back first-use ensure must not survive in a process-local cache.
      expect(await fresh.admit(f.admission)).toMatchObject({ disposition: "admitted" });
    },
  );
  it("permits original fact settlement after caller revocation but refuses new dispatch and disclosure", async () => {
    let current = true;
    const f = fixture(() => {
      if (!current) {
        throw new Error("revoked");
      }
    });
    await f.store.admit(f.admission);
    await f.store.dispatch({ ...f.locator, attemptId: "attempt", now: 2 });
    current = false;
    expect(
      await f.store.settle({ ...f.locator, attemptId: "attempt", now: 3, disposition: "unknown" }),
    ).toMatchObject({ held: true });
    await expect(f.store.read(f.locator)).rejects.toThrow(/revoked/);
    await expect(f.store.dispatch({ ...f.locator, attemptId: "attempt", now: 4 })).rejects.toThrow(
      /revoked/,
    );
  });
});
