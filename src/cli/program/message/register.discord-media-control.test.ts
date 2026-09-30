import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createMessageCliHelpers } from "./helpers.js";
import type { MessageCliHelpers } from "./helpers.js";
import { registerMessageDiscordAdminCommands } from "./register.discord-admin.js";

function setup() {
  const command = new Command()
    .name("message")
    .exitOverride()
    .configureOutput({ writeErr() {}, writeOut() {} });
  const runMessageAction = vi.fn<MessageCliHelpers["runMessageAction"]>(async () => {});
  registerMessageDiscordAdminCommands(command, {
    ...createMessageCliHelpers("discord"),
    runMessageAction,
  });
  return { command, runMessageAction };
}
const bound = [
  "--channel",
  "discord",
  "--account",
  "default",
  "--guild-id",
  "222",
  "--expected-bot-id",
  "111",
];
describe("fixed Discord media control CLI", () => {
  it.each(["--account", "--idempotency-key"])("requires %s before dispatch", async (missing) => {
    const f = setup();
    const args = [
      "guild",
      "media-filter",
      "set-all-members",
      ...bound,
      "--expected-current",
      "0",
      "--idempotency-key",
      "key",
    ];
    args.splice(args.indexOf(missing), 2);
    await expect(f.command.parseAsync(args, { from: "user" })).rejects.toMatchObject({
      code: "commander.missingMandatoryOptionValue",
    });
    expect(f.runMessageAction).not.toHaveBeenCalled();
  });
  it("requires an explicit durable key and forwards numeric expected zero", async () => {
    const f = setup();
    await f.command.parseAsync(
      [
        "guild",
        "media-filter",
        "set-all-members",
        ...bound,
        "--expected-current",
        "0",
        "--idempotency-key",
        "one-change",
      ],
      { from: "user" },
    );
    expect(f.runMessageAction).toHaveBeenCalledWith(
      "guild-media-filter-set-all-members",
      expect.objectContaining({
        account: "default",
        guildId: "222",
        expectedBotId: "111",
        expectedCurrent: 0,
        controlMode: "apply",
        idempotencyKey: "one-change",
      }),
    );
  });
  it.each(["read", "reconcile", "cancel"])(
    "%s forwards an existing operation identifier without an apply flag",
    async (mode) => {
      const f = setup();
      await f.command.parseAsync(
        [
          "guild",
          "media-filter",
          mode === "read" ? "receipt" : mode,
          ...bound,
          "--operation-id",
          "operation-1",
        ],
        { from: "user" },
      );
      expect(f.runMessageAction).toHaveBeenCalledWith(
        "guild-media-filter-set-all-members",
        expect.objectContaining({ controlMode: mode, operationId: "operation-1" }),
      );
      expect(f.runMessageAction.mock.calls[0]?.[1]).not.toHaveProperty("expectedCurrent");
    },
  );
  it.each(["-1", "3", "0junk", "", "1.5"])(
    "rejects invalid expected value %j before dispatch",
    async (value) => {
      const f = setup();
      await expect(
        f.command.parseAsync(
          [
            "guild",
            "media-filter",
            "set-all-members",
            ...bound,
            "--expected-current",
            value,
            "--idempotency-key",
            "key",
          ],
          { from: "user" },
        ),
      ).rejects.toMatchObject({ code: "commander.invalidArgument" });
      expect(f.runMessageAction).not.toHaveBeenCalled();
    },
  );
});
