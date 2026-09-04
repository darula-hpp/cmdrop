import { exec } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { insertPath } from "../paths.js";
import { copyToClipboard, currentShell } from "../platform/index.js";

const execAsync = promisify(exec);

export async function copyCommand(command: string): Promise<string> {
  await copyToClipboard(command);
  return "Copied to clipboard. Paste and review before running.";
}

export async function insertCommand(command: string): Promise<string> {
  await fs.writeFile(insertPath(), command, { mode: 0o600 });
  try {
    await copyToClipboard(command);
    return `Wrote insert file and copied to clipboard. If the shell hook is installed, the next prompt will show the command. Otherwise paste it.`;
  } catch {
    return `Wrote ${insertPath()}. Install the shell hook with \`cmdrop init --shell\` or paste from that file.`;
  }
}

export async function runCommand(command: string, confirm: string): Promise<{ stdout: string; stderr: string }> {
  if (confirm.trim() !== "run") {
    throw new Error('Run aborted. Type "run" to execute a received command.');
  }
  const shell = process.env.SHELL || "/bin/sh";
  const { stdout, stderr } = await execAsync(command, {
    shell,
    env: process.env,
    timeout: 10 * 60 * 1000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { stdout, stderr };
}

export { currentShell };
