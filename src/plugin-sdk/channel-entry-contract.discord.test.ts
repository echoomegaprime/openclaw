import fs from "node:fs";
import path from "node:path";
import { transformSync } from "esbuild";
import type {
  BundledChannelEntryContract,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { getPluginSetupModuleLoader } from "../plugins/plugin-setup-module.js";
import { resolveBundledPluginPublicModulePath } from "../test-utils/bundled-plugin-public-surface.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const caches: ReturnType<typeof createPluginCache>[] = [];
const events: string[] = [];
afterEach(async () => {
  for (const cache of caches.splice(0)) {
    await retirePluginCache(cache);
  }
  for (const event of events.splice(0)) {
    process.removeAllListeners(event);
  }
});

function fixture(activities?: string) {
  const rootDir = temp.make("discord-entry-");
  const source = path.join(rootDir, "index.js");
  const event = `discord-activities:${rootDir}`;
  events.push(event);
  // Execute the authored entry against small companions; the emitted-package
  // acceptance run separately exercises the full Activities implementation.
  fs.writeFileSync(
    source,
    transformSync(
      fs.readFileSync(
        resolveBundledPluginPublicModulePath({ pluginId: "discord", artifactBasename: "index" }),
        "utf8",
      ),
      {
        loader: "ts",
        format: "esm",
        target: "esnext",
      },
    ).code,
  );
  const companions = {
    "package.json": '{"name":"discord-entry-fixture","type":"module"}',
    "channel-plugin-api.js": 'export const discordPlugin = { id: "discord" };',
    "runtime-setter-api.js": "export function setDiscordRuntime() {}",
    "transcripts-source-api.js":
      'export function registerDiscordTranscriptSourceProvider(api) { api.registerTranscriptSourceProvider({ id: "discord-voice" }); }',
    "subagent-hooks-api.js":
      'export function registerDiscordSubagentHooks(api) { api.on("subagent_ended", () => {}); }',
    "activities-api.js":
      activities ??
      `
      process.on(${JSON.stringify(event)}, () => {});
      export const identity = {};
      export function registerDiscordActivities(api) { api.registerHttpRoute({ path: "/activity-fixture" }); }
    `,
  };
  for (const [name, content] of Object.entries(companions)) {
    fs.writeFileSync(path.join(rootDir, name), content);
  }
  function load() {
    const cache = createPluginCache();
    caches.push(cache);
    const loader = withPluginCache(cache, () =>
      getPluginSetupModuleLoader(
        {
          id: "discord",
          origin: "global",
          rootDir,
          source,
          manifestPath: path.join(rootDir, "openclaw.plugin.json"),
          channels: ["discord"],
          providers: [],
          cliBackends: [],
          hooks: [],
          skills: [],
        },
        source,
        rootDir,
      ),
    );
    return { loader, entry: (loader(source) as { default: BundledChannelEntryContract }).default };
  }
  return { rootDir, event, load };
}

function apiFor(mode: OpenClawPluginApi["registrationMode"]) {
  const calls: string[] = [];
  const api = createTestPluginApi({
    registrationMode: mode,
    registerChannel: () => {
      calls.push("channel");
    },
    registerHttpRoute: (route) => {
      calls.push(route.path);
    },
    on: (name) => {
      calls.push(name);
    },
    registerTranscriptSourceProvider: (provider) => {
      calls.push(provider.id);
    },
  });
  return { api, calls };
}

it("defers activities through discovery and keeps full registration in its captured generation", () => {
  const { event, rootDir, load } = fixture();
  const first = load();
  expect(process.listenerCount(event)).toBe(0);
  const discovery = apiFor("discovery");
  first.loader.initialize(() => first.entry.register(discovery.api));
  expect(discovery.calls).toEqual(["channel", "discord-voice"]);
  expect(process.listenerCount(event)).toBe(0);
  const activityPath = path.join(rootDir, "activities-api.js");
  fs.writeFileSync(
    activityPath,
    fs.readFileSync(activityPath, "utf8").replace("/activity-fixture", "/replacement-fixture"),
  );

  for (const mode of ["full", "tool-discovery"] as const) {
    const registration = apiFor(mode);
    expect(first.entry.register(registration.api)).toBeUndefined();
    expect(registration.calls).toEqual([
      ...(mode === "full" ? ["channel"] : []),
      "/activity-fixture",
      "subagent_ended",
      "discord-voice",
    ]);
    expect(process.listenerCount(event)).toBe(1);
  }
  const original = first.loader(activityPath);
  expect(first.loader(activityPath)).toBe(original);
  const second = load();
  const replacement = apiFor("tool-discovery");
  second.loader.initialize(() => second.entry.register(replacement.api));
  expect(replacement.calls).toEqual(["/replacement-fixture", "subagent_ended", "discord-voice"]);
  expect(second.loader(activityPath)).not.toBe(original);
  expect(process.listenerCount(event)).toBe(2);
});

it.each([
  ["export const other = true;", /missing export "registerDiscordActivities"/],
  ['throw new Error("activities companion failed");', /activities companion failed/],
])("defers and propagates an invalid activities companion: %s", (activities, error) => {
  const { entry, loader } = fixture(activities).load();
  const discovery = apiFor("discovery");
  loader.initialize(() => entry.register(discovery.api));
  expect(discovery.calls).toEqual(["channel", "discord-voice"]);
  const full = apiFor("full");
  expect(() => entry.register(full.api)).toThrow(error);
  expect(full.calls).toEqual(["channel"]);
});
