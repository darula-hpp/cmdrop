import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { daemonScriptPath, nodeExecutable } from "../bin.js";
import { daemonLogPath, dataDir } from "../paths.js";
import { detectPlatform } from "../platform/index.js";

const execFileAsync = promisify(execFile);
const LAUNCHD_LABEL = "com.cmdrop.daemon";

export { daemonScriptPath, nodeExecutable };

function launchAgentPath(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.cmdrop.daemon.plist");
}

function systemdUserUnitPath(): string {
  return path.join(os.homedir(), ".config", "systemd", "user", "cmdrop.service");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function launchdDomain(): string {
  const uid = process.getuid?.() ?? os.userInfo().uid;
  return `gui/${uid}`;
}

function launchdTarget(): string {
  return `${launchdDomain()}/${LAUNCHD_LABEL}`;
}

export function launchdPlist(nodePath: string, scriptPath: string, logPath = daemonLogPath()): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(nodePath)}</string>
      <string>${escapeXml(scriptPath)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logPath)}</string>
  </dict>
</plist>
`;
}

async function launchctl(args: string[]): Promise<{ ok: boolean; text: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("launchctl", args, { encoding: "utf8" });
    return { ok: true, text: `${stdout}\n${stderr}`.trim() };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const text = `${error.stderr ?? ""}\n${error.stdout ?? ""}\n${error.message ?? ""}`.trim();
    return { ok: false, text };
  }
}

function notFound(text: string): boolean {
  return /could not find service|no such process|not found/i.test(text);
}

function alreadyLoaded(text: string): boolean {
  return /already|in progress|Input\/output error/i.test(text);
}

export async function launchdAgentRunning(): Promise<boolean> {
  const printed = await launchctl(["print", launchdTarget()]);
  return printed.ok && /state = running/i.test(printed.text);
}

/** Modern macOS: bootstrap/kickstart. Do not use `load`/`unload` — they fail with I/O error 5. */
export async function reloadLaunchdAgent(plist: string): Promise<{ started: boolean; message: string }> {
  const uid = process.getuid?.() ?? os.userInfo().uid;
  const domain = launchdDomain();
  const target = launchdTarget();

  await launchctl(["bootout", target]);
  await launchctl(["bootout", `user/${uid}/${LAUNCHD_LABEL}`]);
  await new Promise((r) => setTimeout(r, 250));

  let boot = await launchctl(["bootstrap", domain, plist]);
  if (!boot.ok && alreadyLoaded(boot.text)) {
    await launchctl(["bootout", target]);
    await new Promise((r) => setTimeout(r, 250));
    boot = await launchctl(["bootstrap", domain, plist]);
  }
  if (!boot.ok && !alreadyLoaded(boot.text) && !notFound(boot.text)) {
    return {
      started: false,
      message: `Could not register the launchd agent: ${boot.text}`,
    };
  }

  await launchctl(["enable", target]);
  const kick = await launchctl(["kickstart", "-k", target]);
  await new Promise((r) => setTimeout(r, 200));
  const running = await launchdAgentRunning();
  if (running) {
    return {
      started: true,
      message: `Restarted launchd agent (${target}).`,
    };
  }
  if (!kick.ok) {
    return {
      started: false,
      message: `launchd kickstart failed: ${kick.text}. Avoid \`launchctl load\`; use: node dist/cli.js restart`,
    };
  }
  return {
    started: false,
    message: `launchd registered ${target} but the daemon is not running. Check ${daemonLogPath()}.`,
  };
}

export function systemdUnit(nodePath: string, scriptPath: string): string {
  return `[Unit]
Description=cmdrop LAN daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${shellQuote(nodePath)} ${shellQuote(scriptPath)}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface ServiceInstallResult {
  kind: "launchd" | "systemd" | "none";
  path?: string;
  started: boolean;
  message: string;
}

export async function installUserService(): Promise<ServiceInstallResult> {
  const platform = await detectPlatform();
  const nodePath = nodeExecutable();
  const scriptPath = daemonScriptPath();

  if (platform === "macos") {
    const plist = launchAgentPath();
    await fs.mkdir(path.dirname(plist), { recursive: true });
    await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
    await fs.writeFile(plist, launchdPlist(nodePath, scriptPath), { mode: 0o644 });
    const reloaded = await reloadLaunchdAgent(plist);
    return {
      kind: "launchd",
      path: plist,
      started: reloaded.started,
      message: reloaded.message,
    };
  }

  if (platform === "linux" || platform === "ubuntu") {
    const unit = systemdUserUnitPath();
    await fs.mkdir(path.dirname(unit), { recursive: true });
    await fs.writeFile(unit, systemdUnit(nodePath, scriptPath), { mode: 0o644 });
    try {
      await execFileAsync("systemctl", ["--user", "daemon-reload"]);
      await execFileAsync("systemctl", ["--user", "enable", "--now", "cmdrop.service"]);
      return {
        kind: "systemd",
        path: unit,
        started: true,
        message: `Installed and started systemd user unit: ${unit}`,
      };
    } catch (err) {
      return {
        kind: "systemd",
        path: unit,
        started: false,
        message: `Wrote ${unit} but could not enable it (${err instanceof Error ? err.message : err}). Start the daemon with: cmdrop-daemon`,
      };
    }
  }

  return { kind: "none", started: false, message: "No user service is installed on this platform." };
}

export async function restartUserService(): Promise<ServiceInstallResult> {
  return installUserService();
}

export async function uninstallUserService(): Promise<void> {
  const platform = await detectPlatform();
  if (platform === "macos") {
    const plist = launchAgentPath();
    await launchctl(["bootout", launchdTarget()]);
    await launchctl(["unload", plist]);
    await fs.unlink(plist).catch(() => undefined);
    return;
  }
  if (platform === "linux" || platform === "ubuntu") {
    await execFileAsync("systemctl", ["--user", "disable", "--now", "cmdrop.service"]).catch(() => undefined);
    await fs.unlink(systemdUserUnitPath()).catch(() => undefined);
  }
}
