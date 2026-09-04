#!/usr/bin/env node
import { createIdentity, isInitialized } from "./identity/index.js";
import { CmdropDaemon } from "./daemon/core.js";
import { requireNode20 } from "./platform/index.js";

async function main(): Promise<void> {
  const node = requireNode20();
  if (!node.ok) {
    console.error(node.message);
    process.exit(1);
  }
  if (!(await isInitialized())) {
    await createIdentity();
  }
  const daemon = new CmdropDaemon();
  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await daemon.start();
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
