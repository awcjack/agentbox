import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRuntime } from "./runtime.mjs";

const configPath = process.env.PI_AGENTBOX_RUNTIME_CONFIG ?? "/etc/agentbox/pi-runtime.json";
let runtime;

try {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  runtime = createRuntime(config, { spawn });
  const address = await runtime.listen();
  process.stderr.write(`pi-rpc-runtime listening on ${address.address}:${address.port}\n`);
} catch (error) {
  process.stderr.write(`pi-rpc-runtime startup failed: ${error.message}\n`);
  process.exitCode = 1;
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  process.stderr.write(`pi-rpc-runtime received ${signal}; shutting down\n`);
  try {
    await runtime?.close();
  } catch (error) {
    process.stderr.write(`pi-rpc-runtime shutdown failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
