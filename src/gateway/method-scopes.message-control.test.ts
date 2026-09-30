import { describe, expect, it } from "vitest";
import {
  projectOperatorScopesForMethod,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./method-scopes.js";

describe("fixed guild control client scope selector", () => {
  const exact = { channel: "discord", action: "guild-media-filter-set-all-members" };
  const operator = { operatorCli: true, hasAgentRuntimeIdentity: false };

  it.each(["apply", "read", "reconcile", "cancel"])(
    "requests admin for exact operator control mode %s",
    (controlMode) => {
      expect(
        resolveLeastPrivilegeOperatorScopesForMethod(
          "message.action",
          { ...exact, params: { controlMode } },
          operator,
        ),
      ).toEqual(["operator.admin"]);
    },
  );

  it.each([
    ["missing params", undefined],
    ["null params", null],
    ["array params", []],
    ["missing action", { channel: "discord" }],
    ["missing channel", { action: exact.action }],
    ["ordinary action", { ...exact, action: "channel-info" }],
    ["other provider", { ...exact, channel: "telegram" }],
    ["channel casing", { ...exact, channel: "Discord" }],
    ["action whitespace", { ...exact, action: `${exact.action} ` }],
    ["nested action", { channel: "discord", params: { action: exact.action } }],
  ])("preserves existing policy for %s", (_label, params) => {
    expect(
      resolveLeastPrivilegeOperatorScopesForMethod("message.action", params, operator),
    ).toEqual(["operator.write"]);
  });

  it("does not affect another method", () => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("health", exact, operator)).toEqual([
      "operator.read",
    ]);
  });

  it.each([
    undefined,
    { operatorCli: false, hasAgentRuntimeIdentity: false },
    { operatorCli: true, hasAgentRuntimeIdentity: true },
  ])("preserves inbound or agent policy %j", (caller) => {
    expect(resolveLeastPrivilegeOperatorScopesForMethod("message.action", exact, caller)).toEqual([
      "operator.write",
    ]);
  });

  it.each([
    [["operator.write"], []],
    [["operator.admin"], ["operator.admin"]],
  ])("never manufactures admin from existing grant %j", (allowedScopes, expected) => {
    expect(
      projectOperatorScopesForMethod({
        method: "message.action",
        requestParams: exact,
        requestedScopes: ["operator.admin"],
        allowedScopes,
      }),
    ).toEqual(expected);
  });
});
