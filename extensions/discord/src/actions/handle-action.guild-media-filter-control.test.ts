import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleDiscordMessageAction } from "./handle-action.js";

const runtime = vi.hoisted(() =>
  vi.fn(async (_params: Record<string, unknown>, _cfg: unknown, _options?: unknown) => ({
    content: [],
    details: { ok: true },
  })),
);
vi.mock("../../action-runtime-api.js", () => ({ handleDiscordAction: runtime }));
const cap = Object.freeze({ version: 1 as const });
const cfg = { channels: { discord: { token: "synthetic-token" } } };
const params = {
  accountId: "default",
  expectedBotId: "222222222222222222",
  guildId: "111111111111111111",
  controlMode: "read",
  operationId: "existing-operation",
};
type Context = Parameters<typeof handleDiscordMessageAction>[0];
function invoke(overrides: Partial<Context> = {}) {
  return handleDiscordMessageAction({
    action: "guild-media-filter-set-all-members",
    params,
    cfg,
    accountId: "default",
    controlOperation: cap,
    senderIsOwner: false,
    ...overrides,
  });
}

beforeEach(() => vi.clearAllMocks());

describe("Discord media-filter host capability routing", () => {
  it("forwards a source-less operator capability only through private options", async () => {
    await invoke();
    expect(runtime).toHaveBeenCalledWith(
      { ...params, action: "guildMediaFilterSetAllMembers" },
      cfg,
      expect.objectContaining({ controlOperation: cap }),
    );
    expect(runtime.mock.calls[0]?.[0]).not.toHaveProperty("controlOperation");
  });

  it("does not accept wire capability or senderIsOwner as a substitute", async () => {
    await expect(
      invoke({
        controlOperation: undefined,
        senderIsOwner: true,
        params: { ...params, controlOperation: cap },
      }),
    ).rejects.toThrow("capability");
    expect(runtime).not.toHaveBeenCalled();
  });

  it("takes Discord member identity only from the matching host context", async () => {
    await invoke({
      requesterAccountId: "default",
      requesterSenderId: "333333333333333333",
      toolContext: { currentChannelProvider: "discord" },
      params: { ...params, senderUserId: "wire-user" },
    });
    expect(runtime).toHaveBeenCalledWith(
      expect.not.objectContaining({ senderUserId: expect.anything() }),
      cfg,
      expect.objectContaining({ controlRequesterSenderId: "333333333333333333" }),
    );
  });

  it.each([
    { requesterAccountId: "default" },
    { requesterAccountId: "austin", requesterSenderId: "333333333333333333" },
  ])("rejects incomplete/mismatched Discord requester context %o", async (requester) => {
    await expect(
      invoke({ ...requester, toolContext: { currentChannelProvider: "discord" } }),
    ).rejects.toThrow("requester");
    expect(runtime).not.toHaveBeenCalled();
  });

  it("rejects a wire account different from the selected account", async () => {
    await expect(invoke({ params: { ...params, accountId: "austin" } })).rejects.toThrow("binding");
    expect(runtime).not.toHaveBeenCalled();
  });

  it("preserves expectedCurrent zero instead of treating it as absent", async () => {
    await invoke({ params: { ...params, controlMode: "apply", expectedCurrent: 0 } });
    expect(runtime.mock.calls[0]?.[0]).toMatchObject({ expectedCurrent: 0 });
  });
});
