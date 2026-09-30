import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { createMessageControlStore } from "./message-control-operation.store.js";
import type { MessageControlAdmission } from "./message-control-operation.types.js";

const oldPackage = process.env.OPENCLAW_CONTROL_OLD_PACKAGE;
const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
function rows(file: string) {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare("SELECT * FROM channel_control_operations ORDER BY operation_id").all();
  } finally {
    database.close();
  }
}
// Release owners supply an isolated copy of the exact pre-setter package and
// its verified dependency installation. This test never installs or contacts a provider.
it.skipIf(!oldPackage)(
  "preserves exact held/settled row bytes through the pinned 36cea old binary's ordinary state write",
  async () => {
    const packageRoot = path.resolve(oldPackage!);
    const build = JSON.parse(readFileSync(path.join(packageRoot, "dist/build-info.json"), "utf8"));
    expect(build.commit).toBe("36cea698c2f9f035d48b6657a022afba0e20e21c");
    const ownerPath = path.join(packageRoot, "dist/user-preferences-DdrP3G5o.mjs");
    expect(createHash("sha256").update(readFileSync(ownerPath)).digest("hex")).toBe(
      "d914fcbef13be98c646943e105d540d03105605b5b284cfc212d38dfb60ccf07",
    );
    const root = temps.make("message-control-old-binary-");
    const home = path.join(root, "home");
    const cache = path.join(root, "cache");
    mkdirSync(home);
    mkdirSync(cache);
    const options = { path: path.join(root, "state.sqlite"), env: { OPENCLAW_STATE_DIR: root } };
    const store = createMessageControlStore({ stateOptions: options, assertCurrent() {} });
    const input: MessageControlAdmission = {
      key: "retained",
      operationId: "unknown-op",
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
    const locator = { namespace: '[1,"gateway-system-owner"]', operationId: input.operationId };
    await store.admit(input);
    await store.dispatch({ ...locator, attemptId: input.attemptId, now: 2 });
    await store.settle({ ...locator, attemptId: input.attemptId, now: 3, disposition: "unknown" });
    await store.admit({
      ...input,
      key: "prepared",
      operationId: "prepared-op",
      stable: { ...input.stable, intent: { ...input.stable.intent, guildId: "333" } },
    });
    await store.admit({
      ...input,
      key: "settled",
      operationId: "settled-op",
      stable: {
        ...input.stable,
        intent: { ...input.stable.intent, guildId: "444", expectedCurrent: 2 },
      },
    });
    await store.settle({
      ...locator,
      operationId: "settled-op",
      attemptId: input.attemptId,
      now: 3,
      disposition: "noop",
    });
    await closeOpenClawStateDatabaseAsync();
    const before = rows(options.path);
    const oldScript = `
    const owner = await import(process.argv[1]);
    const options = {path:process.argv[2],env:process.env};
    const written = owner.i("compatibility-fixture", { ordinaryOldWrite: "retained" }, options);
    if (!written.ok) throw new Error("Old preference write refused");
    const read = owner.n("compatibility-fixture", undefined, options);
    if (read.ordinaryOldWrite !== "retained") throw new Error("Old preference read mismatch");
    console.log(JSON.stringify({oldOwnerWrite:true,oldOwnerRead:true}));
  `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", oldScript, pathToFileURL(ownerPath).href, options.path],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: cache,
          TMP: cache,
          HOME: home,
          USERPROFILE: home,
          XDG_CACHE_HOME: cache,
          XDG_CONFIG_HOME: path.join(home, "config"),
          OPENCLAW_HOME: home,
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_CONFIG_PATH: path.join(root, "unused-config.json"),
        },
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    );
    expect({
      status: result.status,
      error: result.error?.message,
      stderr: result.stderr,
    }).toMatchObject({ status: 0, error: undefined });
    expect(JSON.parse(result.stdout.trim())).toEqual({ oldOwnerWrite: true, oldOwnerRead: true });
    expect(rows(options.path)).toEqual(before);
    const reopened = createMessageControlStore({ stateOptions: options, assertCurrent() {} });
    expect(await reopened.read(locator)).toMatchObject({ phase: "unknown", held: true });
    expect(await reopened.admit({ ...input, key: "cannot-replay", operationId: "new-op" })).toEqual(
      { disposition: "held" },
    );
  },
  60_000,
);
