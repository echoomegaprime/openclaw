import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { createMessageActionSourceReply } from "./message-action-source-reply.js";

const mocks = vi.hoisted(() => ({
  begin:
    vi.fn<
      typeof import("../../infra/outbound/source-reply-mirror.js").beginTerminalSourceReplyDelivery
    >(),
  cancel:
    vi.fn<
      typeof import("../../infra/outbound/source-reply-mirror.js").cancelTerminalSourceReplyDelivery
    >(),
  reconcile:
    vi.fn<
      typeof import("../../infra/outbound/source-reply-mirror.js").reconcileTerminalSourceReplyDelivery
    >(),
  mirror:
    vi.fn<
      typeof import("./message-operation-result.js").scheduleDeliveredSourceReplyTranscriptMirror
    >(),
}));
vi.mock("../../infra/outbound/source-reply-mirror.js", async (original) => ({
  ...(await original<typeof import("../../infra/outbound/source-reply-mirror.js")>()),
  beginTerminalSourceReplyDelivery: mocks.begin,
  cancelTerminalSourceReplyDelivery: mocks.cancel,
  reconcileTerminalSourceReplyDelivery: mocks.reconcile,
}));
vi.mock("./message-operation-result.js", async (original) => ({
  ...(await original<typeof import("./message-operation-result.js")>()),
  scheduleDeliveredSourceReplyTranscriptMirror: mocks.mirror,
}));

const receipt = {
  sessionId: "session-one",
  sessionKey: "agent:main:discord:channel:111",
  sourceTurnId: "turn-one",
  storePath: "/fixture/main/agent.sqlite",
  toolCallId: "tool-one",
};

function fixture(enabled = true) {
  const context = createGatewayRequestContext(makeContextParams());
  const mirror = {
    action: "send",
    channel: "discord",
    actionParams: { message: "fixture message" },
    cfg: {},
    sessionKey: receipt.sessionKey,
    sourceReplyFinal: true,
  };
  const lifecycle = createMessageActionSourceReply({
    context,
    mirror,
    sessionKey: "execution-session",
    enabled,
  });
  return { context, mirror, lifecycle };
}

beforeEach(() => {
  mocks.begin.mockReset().mockResolvedValue(receipt);
  mocks.cancel.mockReset().mockResolvedValue(undefined);
  mocks.reconcile.mockReset().mockResolvedValue("delivered");
  mocks.mirror.mockReset().mockResolvedValue(undefined);
});

describe("message-action source reply lifecycle", () => {
  it("retains the actual owner receipt and reconciles before mirroring", async () => {
    const f = fixture();
    const order: string[] = [];
    mocks.reconcile.mockImplementation(async () => {
      order.push("reconcile");
      return "delivered";
    });
    mocks.mirror.mockImplementation(async () => {
      order.push("mirror");
    });
    expect(await f.lifecycle.begin()).toBeUndefined();
    expect(mocks.begin).toHaveBeenCalledWith(f.mirror);
    await f.lifecycle.cancel();
    expect(mocks.cancel).toHaveBeenCalledWith(receipt);
    const payload = { ok: true };
    await f.lifecycle.settle(payload);
    expect(mocks.reconcile).toHaveBeenCalledWith({
      receipt,
      mirror: f.mirror,
      deliveredPayload: payload,
    });
    expect(mocks.mirror).toHaveBeenCalledWith({
      context: f.context,
      mirror: { ...f.mirror, deliveredPayload: payload },
    });
    expect(order).toEqual(["reconcile", "mirror"]);
  });

  it("returns the owner's prior-outcome receipt unchanged", async () => {
    const result = {
      outcome: "already_delivered" as const,
      result: {
        status: "already_delivered",
        delivered: false as const,
        message: "fixture prior receipt",
      },
    };
    mocks.begin.mockResolvedValue(result);
    expect(await fixture().lifecycle.begin()).toBe(result);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.mirror).not.toHaveBeenCalled();
  });

  it("settles partial-delivery evidence without mirroring it", async () => {
    const f = fixture();
    await f.lifecycle.begin();
    await f.lifecycle.settle({ partial: true }, false);
    expect(mocks.reconcile).toHaveBeenCalledOnce();
    expect(mocks.mirror).not.toHaveBeenCalled();
  });

  it("preserves ordinary reconciliation diagnostics and subsequent mirroring", async () => {
    const f = fixture();
    mocks.reconcile.mockRejectedValue(new Error("fixture persistence unavailable"));
    await f.lifecycle.begin();
    await f.lifecycle.settle({ ok: true });
    expect(f.context.logGateway.warn).toHaveBeenCalledWith(
      "Terminal source reply receipt reconciliation failed.",
      expect.objectContaining({ channel: "discord", sessionKey: "execution-session" }),
    );
    expect(mocks.mirror).toHaveBeenCalledOnce();
  });

  it("preserves ordinary mirror failure propagation", async () => {
    const failure = new Error("fixture mirror failed");
    mocks.mirror.mockRejectedValue(failure);
    await expect(fixture().lifecycle.settle({ ok: true })).rejects.toBe(failure);
  });

  it("does not call message owners when disabled for a fixed control", async () => {
    const failure = new Error("message owner must not run");
    mocks.begin.mockRejectedValue(failure);
    mocks.cancel.mockRejectedValue(failure);
    mocks.reconcile.mockRejectedValue(failure);
    mocks.mirror.mockRejectedValue(failure);
    const f = fixture(false);
    expect(await f.lifecycle.begin()).toBeUndefined();
    await f.lifecycle.cancel();
    await f.lifecycle.settle({ status: "applied" });
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.mirror).not.toHaveBeenCalled();
  });

  it("propagates a failed pre-dispatch intent without settling or mirroring", async () => {
    const failure = new Error("fixture intent failed");
    mocks.begin.mockRejectedValue(failure);
    await expect(fixture().lifecycle.begin()).rejects.toBe(failure);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.mirror).not.toHaveBeenCalled();
  });
});
