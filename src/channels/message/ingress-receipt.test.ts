import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

afterEach(() => vi.restoreAllMocks());

describe("exact ingress receipt", () => {
  it("refuses a replaced physical database across its asynchronous read opening", async () => {
    await withOpenClawTestState({ label: "ingress-read-replaced" }, async (state) => {
      const queue = createChannelIngressQueue({ channelId: "discord" });
      await queue.enqueue("1001", { private: "report" }, { laneKey: "channel:2001" });
      const database = openOpenClawStateDatabase();
      database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const pathname = database.path;
      await stateDatabase.closeOpenClawStateDatabaseAsync();
      const original = stateDatabase.openExistingOpenClawStateDatabaseReadOnly;
      vi.spyOn(stateDatabase, "openExistingOpenClawStateDatabaseReadOnly").mockImplementation(
        async (options) => {
          const archived = state.statePath("original.sqlite");
          await fs.rename(pathname, archived);
          await fs.copyFile(archived, pathname);
          return original(options);
        },
      );
      await expect(queue.inspect?.("1001", { laneKey: "channel:2001" })).rejects.toThrow();
    });
  });
  it.each(["owner", "shared-generation"])(
    "refuses a retained read invalidated during open: %s",
    async (kind) => {
      await withOpenClawTestState({ label: `ingress-read-revoked-${kind}` }, async () => {
        let current = true;
        const queue = createChannelIngressQueue({ channelId: "discord" }, () => {
          if (!current) {
            throw new Error("fixture owner revoked");
          }
        });
        await queue.enqueue("1001", { private: "report" }, { laneKey: "channel:2001" });
        const open = stateDatabase.openExistingOpenClawStateDatabaseReadOnly;
        let opened: Awaited<ReturnType<typeof open>>;
        vi.spyOn(stateDatabase, "openExistingOpenClawStateDatabaseReadOnly").mockImplementation(
          async (options) => {
            if (kind === "owner") {
              current = false;
            } else {
              await stateDatabase.closeOpenClawStateDatabaseAsync();
            }
            opened = await open(options);
            return opened;
          },
        );
        await expect(queue.inspect?.("1001", { laneKey: "channel:2001" })).rejects.toThrow();
        expect(opened?.db.isOpen).toBe(false);
      });
    },
  );
  it("distinguishes an absent store without creating it", async () => {
    await withOpenClawTestState({ label: "ingress-receipt-absent" }, async (state) => {
      const reader = createChannelIngressQueue({
        channelId: "discord",
        accountId: "default",
        stateDir: state.stateDir,
        access: "read-only",
      });
      expect(await reader.inspect?.("1001", { laneKey: "channel:2001" })).toEqual({
        kind: "store-absent",
        retentionLimited: true,
      });
      await expect(fs.access(state.statePath("state", "openclaw.sqlite"))).rejects.toThrow();
    });
  });

  it("reads every disposition without private payloads, errors or claim tokens", async () => {
    await withOpenClawTestState({ label: "ingress-receipt-status" }, async (state) => {
      const queue = createChannelIngressQueue({
        channelId: "discord",
        accountId: "default",
        stateDir: state.stateDir,
      });
      for (const [index, status] of ["pending", "claimed", "completed", "failed"].entries()) {
        const id = String(1001 + index);
        await queue.enqueue(
          id,
          { private: "private fixture payload" },
          { laneKey: "channel:2001", metadata: { private: "private fixture metadata" } },
        );
        runOpenClawStateWriteTransaction(({ db }) => {
          db.prepare(
            "UPDATE channel_ingress_events SET status=?, claim_token='private-token', claim_owner='private-owner', last_error='private-error', completed_metadata_json='private-metadata' WHERE event_id=?",
          ).run(status, id);
        });
        const result = await queue.inspect?.(id, { laneKey: "channel:2001" });
        expect(result).toMatchObject({
          kind: "found",
          status,
          id,
          channelId: "discord",
          accountId: "default",
          laneKey: "channel:2001",
          downstreamOutcome: "not-established",
        });
        expect(JSON.stringify(result)).not.toContain("private");
      }
      expect(await queue.inspect?.("9999", { laneKey: "channel:2001" })).toEqual({
        kind: "not-found",
        retentionLimited: true,
      });
      expect(await queue.inspect?.("1001", { laneKey: "channel:other" })).toEqual({
        kind: "scope-mismatch",
      });
      const other = createChannelIngressQueue({
        channelId: "discord",
        accountId: "other",
        stateDir: state.stateDir,
      });
      expect(await other.inspect?.("1001", { laneKey: "channel:2001" })).toEqual({
        kind: "not-found",
        retentionLimited: true,
      });
    });
  });

  it("refuses malformed status or numeric metadata without outputting private fields", async () => {
    await withOpenClawTestState({ label: "ingress-receipt-malformed" }, async (state) => {
      const queue = createChannelIngressQueue({ channelId: "discord", stateDir: state.stateDir });
      await queue.enqueue("1001", "private", { laneKey: "channel:2001" });
      openOpenClawStateDatabase()
        .db.prepare("UPDATE channel_ingress_events SET attempts=-1 WHERE event_id='1001'")
        .run();
      expect(await queue.inspect?.("1001", { laneKey: "channel:2001" })).toEqual({
        kind: "invalid-record",
      });
      await expect(queue.inspect?.("", { laneKey: "channel:2001" })).rejects.toThrow();
      await expect(queue.inspect?.("1001", { laneKey: "" })).rejects.toThrow();
    });
  });
});
