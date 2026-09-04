import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Compiled daemon entry inside this package (works for npm -g and local dist). */
export function daemonScriptPath(): string {
  return fileURLToPath(new URL("./daemon.js", import.meta.url));
}

export function nodeExecutable(): string {
  return process.execPath;
}

/** Prefer the npm shim next to `cmdrop` so nvm/global installs keep working. */
export function resolveDaemonArgv(): { cmd: string; args: string[] } {
  const argv1 = process.argv[1];
  if (argv1) {
    const sibling = path.join(path.dirname(argv1), "cmdrop-daemon");
    if (isFile(sibling)) {
      return { cmd: nodeExecutable(), args: [sibling] };
    }
  }
  return { cmd: nodeExecutable(), args: [daemonScriptPath()] };
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
