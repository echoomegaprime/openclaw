import { afterEach, expect, it, vi } from "vitest";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createRuntimeBuilder } from "./registry-runtime.channel-ingress.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.each(["transaction", "commit"])(
  "rejects a real retired plugin registry before ingress %s",
  async (stage) => {
    await withOpenClawTestState({ label: `ingress-plugin-${stage}` }, async (state) => {
      const channel = createRuntimeBuilder({ origin: "bundled", id: "discord" });
      if (!channel.instance) {
        throw new Error("Missing fixture plugin instance");
      }
      try {
        const queue = channel.instance.run(() =>
          channel.api.runtime.state.openChannelIngressQueue({
            accountId: "default",
            stateDir: state.stateDir,
          }),
        );
        await queue.enqueue("original", { source: "fixture" });
        const database = openOpenClawStateDatabase();
        const original = operationAdmission.createSqliteWorkerOperationAdmission;
        vi.spyOn(operationAdmission, "createSqliteWorkerOperationAdmission").mockImplementation(
          (handler) =>
            original((request, grant) => {
              if (request.stage === stage) {
                markPluginRegistryRetired(channel.registryBuilder.registry);
              }
              return handler(request, grant);
            }),
        );
        await expect(queue.enqueue("revoked", { source: "fixture" })).rejects.toThrow(
          "no longer active",
        );
        expect(
          database.db
            .prepare("SELECT event_id FROM channel_ingress_events ORDER BY event_id")
            .all(),
        ).toEqual([{ event_id: "original" }]);
      } finally {
        markPluginRegistryRetired(channel.registryBuilder.registry);
        await channel.instance.dispose();
      }
    });
  },
);
