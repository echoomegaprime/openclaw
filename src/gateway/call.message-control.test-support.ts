import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClientOptions } from "./client.js";

type ScopeCallHarness = {
  callGateway: typeof import("./call.js").callGateway;
  callGatewayCli: typeof import("./call.js").callGatewayCli;
  callGatewayLeastPrivilege: typeof import("./call.js").callGatewayLeastPrivilege;
  setLocalLoopbackGatewayConfig: () => void;
  clientOptions: () => GatewayClientOptions | null;
  startCalls: () => number;
  rejectRequests: (error: Error) => void;
};

/** Reuse the call suite's real stub transport and per-case reset lifecycle. */
export function registerMessageControlGatewayCallTests({
  callGateway,
  callGatewayCli,
  callGatewayLeastPrivilege,
  setLocalLoopbackGatewayConfig,
  clientOptions,
  startCalls,
  rejectRequests,
}: ScopeCallHarness) {
  it.each([
    {
      label: "uses least-privilege scopes by default for non-CLI callers",
      call: () => callGateway({ method: "health" }),
      expectedScopes: ["operator.read"],
    },
    {
      label: "uses least-privilege scopes by default for explicit CLI callers",
      call: () => callGatewayCli({ method: "health" }),
      expectedScopes: ["operator.read"],
    },
  ])("scope selection: $label", async ({ call, expectedScopes }) => {
    setLocalLoopbackGatewayConfig();
    await call();
    expect(clientOptions()?.scopes).toEqual(expectedScopes);
  });

  describe("fixed guild control client scope projection", () => {
    const params = {
      channel: "discord",
      action: "guild-media-filter-set-all-members",
      params: {},
    };

    it.each([
      ["explicit CLI entry", () => callGatewayCli({ method: "message.action", params })],
      [
        "runner CLI name",
        () =>
          callGatewayLeastPrivilege({
            method: "message.action",
            params,
            clientName: GATEWAY_CLIENT_NAMES.CLI,
          }),
      ],
      [
        "runner CLI mode",
        () =>
          callGatewayLeastPrivilege({
            method: "message.action",
            params,
            mode: GATEWAY_CLIENT_MODES.CLI,
          }),
      ],
    ] as const)("requests admin for %s", async (_label, invoke) => {
      setLocalLoopbackGatewayConfig();
      await expect(invoke()).resolves.toEqual({ ok: true });
      expect(clientOptions()?.scopes).toEqual(["operator.admin"]);
      expect(startCalls()).toBe(1);
    });

    it.each(["", "fixture-agent-token"])(
      "preserves an agent-bearing CLI request (%j)",
      async (agentRuntimeIdentityToken) => {
        setLocalLoopbackGatewayConfig();
        await callGatewayCli({ method: "message.action", params, agentRuntimeIdentityToken });
        expect(clientOptions()?.scopes).toEqual(["operator.write"]);
      },
    );

    it("leaves backend scope selection unchanged", async () => {
      setLocalLoopbackGatewayConfig();
      await callGatewayLeastPrivilege({ method: "message.action", params });
      expect(clientOptions()?.scopes).toEqual(["operator.write"]);
    });

    it("does not override explicit caller scopes", async () => {
      setLocalLoopbackGatewayConfig();
      await callGatewayCli({ method: "message.action", params, scopes: ["operator.write"] });
      expect(clientOptions()?.scopes).toEqual(["operator.write"]);
    });

    it("does not retry a refused fixed control request with another grant", async () => {
      setLocalLoopbackGatewayConfig();
      const denied = new Error("fixed control requires an existing admin grant");
      rejectRequests(denied);
      await expect(callGatewayCli({ method: "message.action", params })).rejects.toThrow(
        "existing admin grant",
      );
      expect(clientOptions()?.scopes).toEqual(["operator.admin"]);
      expect(startCalls()).toBe(1);
    });
  });
}
