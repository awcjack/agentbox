import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const [extensionPath, piRoot] = process.argv.slice(2);
assert.ok(extensionPath && piRoot, "usage: pi-agentsmd.mjs <extension> <Pi package root>");

const packageRoot = join(dirname(extensionPath), "..");
const home = await mkdtemp(join(tmpdir(), "agentbox-pi-agentsmd-"));
const load = async (relative) => import(pathToFileURL(join(piRoot, relative)).href);
const { loadExtensions } = await load("dist/core/extensions/loader.js");

const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
assert.equal(packageJson.name, "pi-agentsmd");
assert.equal(packageJson.version, "0.2.1");
assert.doesNotMatch(
  await readFile(extensionPath, "utf8"),
  /install-telemetry|mocito\.dev|reportInstallTelemetry/,
  "managed bundle must not keep install telemetry",
);
assert.equal(
  await readFile(join(packageRoot, "src/install-telemetry.ts"), "utf8").then(
    () => "present",
    (error) => (error && error.code === "ENOENT" ? "missing" : Promise.reject(error)),
  ),
  "missing",
);

try {
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(home, "pi");
  process.env.PI_OFFLINE = "1";

  const networkAttempts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    networkAttempts.push(String(input));
    throw new Error("pi-agentsmd must not contact the network while loading");
  };

  try {
    const loaded = await loadExtensions([extensionPath], home);
    assert.deepEqual(loaded.errors, [], "pi-agentsmd must load with the bundled Pi");
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension.commands.has("init"), "/init must be registered");

    const notices = [];
    const messages = [];
    let trusted = false;
    Object.assign(loaded.runtime, {
      sendUserMessage(text) {
        messages.push(text);
      },
    });
    const ctx = {
      cwd: home,
      isProjectTrusted: () => trusted,
      ui: {
        notify(message, level) {
          notices.push({ message, level });
        },
      },
    };
    const command = (args) => extension.commands.get("init").handler(args, ctx);

    await command("");
    assert.equal(messages.length, 0);
    assert.match(notices.at(-1).message, /Trust this project/);

    trusted = true;
    await writeFile(join(home, "AGENTS.md"), "# existing\n", "utf8");
    await command("");
    assert.equal(messages.length, 0);
    assert.match(notices.at(-1).message, /already exists/);

    await command("--force");
    assert.equal(messages.length, 1);
    assert.match(messages[0], /explicitly invoked \/init with --force/);
    assert.match(messages[0], /Create an AGENTS\.md file/);

    await rm(join(home, "AGENTS.md"));
    await command("-f");
    assert.equal(messages.length, 2);
    assert.match(messages[1], /explicitly invoked \/init with --force/);

    await command("");
    assert.equal(messages.length, 3);
    assert.match(messages[2], /Tell the user to run \/init --force/);

    assert.equal(networkAttempts.length, 0, "loading and /init must stay offline");
    console.log("pi-agentsmd extension tests passed");
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  await rm(home, { recursive: true, force: true });
}
