import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { beforeEach, expect, it, vi } from "vitest";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import {
  readSessionEntriesFromStoreInWorker,
  withSessionEntriesFromStoresInWorker,
} from "./session-entry-read-runtime.js";
import { createSessionHistoryWorkerReaders } from "./session-transcript-worker-readers.js";
import type { SessionExactEntriesWorkerResult } from "./session-transcript-worker.types.js";

const fixture = vi.hoisted(() => ({
  direct: true,
  current: true,
  afterReply: undefined as (() => void) | undefined,
  sent: [] as unknown[],
  ownerEnvs: [] as NodeJS.ProcessEnv[],
  result: {
    kind: "session-exact-entries",
    entries: [],
    lifecycleTimestamps: {},
  } satisfies SessionExactEntriesWorkerResult,
}));

// Database owners are synthetic; native ports still enforce the real wire contract.
function transfer(input: unknown): void {
  const { port1, port2 } = new MessageChannel();
  try {
    port1.postMessage(input);
    const received = receiveMessageOnPort(port2);
    expect(received).toBeDefined();
    fixture.sent.push(received?.message);
  } finally {
    port1.close();
    port2.close();
  }
}

vi.mock("../../state/openclaw-agent-db-registry-listing.js", () => ({
  prepareOpenClawAgentDatabaseRegistrySnapshotRead: () => ({
    read: () => {
      throw new Error("unexpected registry read");
    },
  }),
}));
vi.mock("../../state/openclaw-agent-db.js", () => ({
  retainOpenClawAgentDatabaseReadCandidates: () => {
    throw new Error("unexpected database retention");
  },
}));
vi.mock("../future-version-guard.js", () => ({
  ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV: "OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS",
}));
vi.mock("../state-dir.js", () => ({ resolveStateDir: () => "C:/synthetic/state" }));
vi.mock("./session-accessor.sqlite-scope.js", () => ({
  resolveSqliteAgentId: () => "fixture",
}));
vi.mock("./session-canonical-key.js", () => ({
  captureCanonicalSessionReaderContinuation: () => {
    throw new Error("unexpected database continuation");
  },
}));
vi.mock("./session-sqlite-target.js", () => ({
  resolveUnsuffixedSqliteTargetFromSessionStorePath: (pathname: string) => ({
    path: pathname,
    agentId: fixture.direct ? "fixture" : undefined,
  }),
}));
vi.mock("./session-store-read-candidates.js", () => ({
  captureSessionStoreReadCandidate: (pathname: string) => ({
    path: pathname,
    physicalPath: pathname,
  }),
  assertSessionStoreReadCandidate: (pathname: string) => pathname,
}));
vi.mock("./session-store-target-inventory.js", () => ({
  captureSessionStoreReadCandidates: (pathname: string) => [
    { path: pathname, physicalPath: pathname },
  ],
}));
vi.mock("./session-transcript-worker-resources.js", () => ({
  withSessionHistoryWorkerReadCandidates: async (
    _candidates: unknown,
    consume: (owner: {
      assertCurrent: () => void;
      readStoreTarget: (request: { storePath: string }) => Promise<unknown>;
    }) => Promise<unknown>,
  ) =>
    consume({
      assertCurrent: () => {},
      readStoreTarget: async (request) => {
        transfer({ kind: "session-store-target", request });
        return {
          kind: "session-store-target",
          sourcePath: request.storePath,
          database: { agentId: "fixture", path: request.storePath },
        };
      },
    }),
}));
vi.mock("./session-transcript-worker-runtime.js", () => ({
  withSessionHistoryWorkerDatabase: async (
    database: { agentId: string; path: string; env: NodeJS.ProcessEnv },
    consume: (
      owner: ReturnType<typeof createSessionHistoryWorkerReaders> & {
        assertCurrent: () => void;
      },
    ) => Promise<unknown>,
  ) => {
    fixture.ownerEnvs.push(database.env);
    return consume({
      assertCurrent: () => {
        if (!fixture.current) {
          throw new Error("synthetic reader revoked");
        }
      },
      ...createSessionHistoryWorkerReaders(async (prepare, _bytes, receive) => {
        transfer({ ...prepare(), database: { agentId: database.agentId, path: database.path } });
        fixture.afterReply?.();
        return receive(fixture.result);
      }),
    });
  },
}));

beforeEach(() => {
  fixture.direct = true;
  fixture.current = true;
  fixture.afterReply = undefined;
  fixture.sent.length = 0;
  fixture.ownerEnvs.length = 0;
});

const input = {
  agentId: "fixture",
  storePath: "C:/synthetic/fixture.sqlite",
  sessionKeys: ["agent:fixture:cron:synthetic"],
};

it.each([true, false])(
  "transfers Windows environment for direct=%s without losing local lookup",
  async (direct) => {
    fixture.direct = direct;
    await withMockedPlatform("win32", async () => {
      const env = cloneEnvWithPlatformSemantics({
        OpenClaw_State_Dir: "old",
        Path: "synthetic-bin",
      });
      expect(() => structuredClone(env)).toThrow();
      await expect(readSessionEntriesFromStoreInWorker({ ...input, env })).resolves.toEqual(
        fixture.result,
      );
      expect(fixture.sent).toHaveLength(direct ? 1 : 2);
      expect(fixture.sent.at(-1)).toMatchObject({
        kind: "session-exact-entries",
        env: {
          OpenClaw_State_Dir: "C:/synthetic/state",
          OPENCLAW_STATE_DIR: "C:/synthetic/state",
          Path: "synthetic-bin",
        },
        sessionKeys: input.sessionKeys,
      });
      if (!direct) {
        expect(fixture.sent[0]).toMatchObject({
          kind: "session-store-target",
          request: {
            env: {
              OpenClaw_State_Dir: "C:/synthetic/state",
              OPENCLAW_STATE_DIR: "C:/synthetic/state",
              Path: "synthetic-bin",
            },
          },
        });
      }
      expect(fixture.ownerEnvs[0]?.PATH).toBe("synthetic-bin");
      expect(fixture.ownerEnvs[0]?.OPENCLAW_STATE_DIR).toBe("C:/synthetic/state");
      expect(env.OPENCLAW_STATE_DIR).toBe("old");
    });
  },
);

it.each([true, false])("preserves ordinary environment values for direct=%s", async (direct) => {
  fixture.direct = direct;
  await withMockedPlatform("linux", async () => {
    const env = { OPENCLAW_STATE_DIR: "old", PATH: "synthetic-bin" };
    await expect(readSessionEntriesFromStoreInWorker({ ...input, env })).resolves.toEqual(
      fixture.result,
    );
    expect(fixture.sent).toHaveLength(direct ? 1 : 2);
    expect(fixture.sent.at(-1)).toMatchObject({
      env: { OPENCLAW_STATE_DIR: "C:/synthetic/state", PATH: "synthetic-bin" },
    });
    expect(env.OPENCLAW_STATE_DIR).toBe("old");
  });
});

it("refuses a revoked owner before the consumer and does not replay a completed read", async () => {
  fixture.afterReply = () => {
    fixture.current = false;
  };
  const consume = vi.fn(() => true);
  await expect(
    withSessionEntriesFromStoresInWorker([{ ...input, env: {} }], consume),
  ).rejects.toThrow("synthetic reader revoked");
  expect(consume).not.toHaveBeenCalled();
  expect(fixture.sent).toHaveLength(1);
});

it("releases consumer authority without adding fields to the returned exact-read data", async () => {
  let retained: (() => void) | undefined;
  await withSessionEntriesFromStoresInWorker([{ ...input, env: {} }], ([read]) => {
    expect(read).toBeDefined();
    read?.assertCurrent();
    retained = read?.assertCurrent;
    expect(Object.keys(read?.result ?? {}).toSorted()).toEqual([
      "entries",
      "kind",
      "lifecycleTimestamps",
    ]);
    return true;
  });
  expect(retained).toBeDefined();
  expect(() => retained?.()).toThrow("consumer is no longer active");
  expect(fixture.sent).toHaveLength(1);
});
