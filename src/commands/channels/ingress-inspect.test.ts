import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { channelsIngressInspectCommand } from "./ingress-inspect.js";

afterEach(() => vi.restoreAllMocks());

describe("local exact ingress inspection", () => {
  it("distinguishes owner read refusal from absence without exposing its error", async () => {
    await withOpenClawTestState({ label: "ingress-read-refusal" }, async () => {
      vi.spyOn(stateDatabase, "openExistingOpenClawStateDatabaseReadOnly").mockRejectedValue(
        new Error("private path credential and report"),
      );
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await channelsIngressInspectCommand(
        {
          channel: "discord",
          account: "default",
          eventId: "1001",
          laneKey: "channel:2001",
          json: true,
        },
        runtime as never,
      );
      const output = runtime.log.mock.calls[0]?.[0];
      if (typeof output !== "string") {
        throw new Error("Missing JSON fixture output");
      }
      expect(JSON.parse(output)).toEqual({
        kind: "read-refused",
        downstreamOutcome: "not-established",
      });
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(JSON.stringify(runtime.log.mock.calls)).not.toContain("private");
    });
  });
  it("returns only the selected metadata and refuses the wrong lane", async () => {
    await withOpenClawTestState({ label: "ingress-inspect-command" }, async () => {
      await createChannelIngressQueue({ channelId: "discord", accountId: "default" }).enqueue(
        "1001",
        { private: "report" },
        { laneKey: "channel:2001" },
      );
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await channelsIngressInspectCommand(
        {
          channel: "discord",
          account: "default",
          eventId: "1001",
          laneKey: "channel:2001",
          json: true,
        },
        runtime as never,
      );
      const output = JSON.stringify(runtime.log.mock.calls);
      expect(output).toContain("pending");
      expect(output).not.toContain("report");
      expect(output).not.toContain("payload");
      await channelsIngressInspectCommand(
        {
          channel: "discord",
          account: "default",
          eventId: "1001",
          laneKey: "channel:other",
          json: true,
        },
        runtime as never,
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });
  });
  it.each([
    { channel: "discord", eventId: "1001", laneKey: "channel:2001" },
    { channel: "discord", account: "default", eventId: "1001" },
    { channel: "../other", account: "default", eventId: "1001", laneKey: "channel:2001" },
  ])("refuses incomplete/unbounded selectors before state access", async (options) => {
    await expect(
      channelsIngressInspectCommand(options, {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      } as never),
    ).rejects.toThrow("selectors are required");
  });
});
