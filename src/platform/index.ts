import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function spawnWrite(cmd: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

export type PlatformId = "macos" | "ubuntu" | "linux" | "unsupported";

export interface OsRelease {
  id?: string;
  idLike?: string;
  prettyName?: string;
}

export function nodeMajor(): number {
  const [major] = process.versions.node.split(".");
  return Number.parseInt(major ?? "0", 10);
}

export function requireNode20(): { ok: boolean; version: string; message?: string } {
  const version = process.versions.node;
  if (nodeMajor() < 20) {
    return {
      ok: false,
      version,
      message: `cmdrop requires Node.js 20 or newer (found ${version}). Install a current Node from https://nodejs.org or your version manager.`,
    };
  }
  return { ok: true, version };
}

export async function readOsRelease(): Promise<OsRelease> {
  try {
    const raw = await fs.readFile("/etc/os-release", "utf8");
    const map = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq);
      const value = line.slice(eq + 1).replace(/^"|"$/g, "");
      map.set(key, value);
    }
    return {
      id: map.get("ID"),
      idLike: map.get("ID_LIKE"),
      prettyName: map.get("PRETTY_NAME"),
    };
  } catch {
    return {};
  }
}

export async function detectPlatform(): Promise<PlatformId> {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "unsupported";
  if (process.platform !== "linux") return "unsupported";
  const release = await readOsRelease();
  const id = (release.id ?? "").toLowerCase();
  const like = (release.idLike ?? "").toLowerCase();
  if (id === "ubuntu" || like.includes("ubuntu")) return "ubuntu";
  return "linux";
}

export function isUbuntuLike(release: OsRelease): boolean {
  const id = (release.id ?? "").toLowerCase();
  const like = (release.idLike ?? "").toLowerCase();
  return id === "ubuntu" || like.includes("ubuntu");
}

async function runQuiet(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 4000 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string };
    return { ok: false, stdout: (error.stdout ?? "").trim(), stderr: (error.stderr ?? "").trim() };
  }
}

export async function avahiActive(): Promise<{ present: boolean; active: boolean; hint: string }> {
  if (process.platform !== "linux") {
    return { present: true, active: true, hint: "Bonjour / mDNS is built in on macOS." };
  }
  const systemctl = await runQuiet("systemctl", ["is-active", "avahi-daemon"]);
  if (systemctl.ok && systemctl.stdout === "active") {
    return { present: true, active: true, hint: "avahi-daemon is running." };
  }
  const which = await runQuiet("which", ["avahi-daemon"]);
  if (which.ok) {
    return {
      present: true,
      active: false,
      hint: "avahi-daemon is installed but not running. Start it with: systemctl --user enable --now avahi-daemon  (or `sudo systemctl enable --now avahi-daemon`)",
    };
  }
  return {
    present: false,
    active: false,
    hint: "Avahi is not installed. cmdrop will use UDP multicast fallback until you install it.",
  };
}

export async function ufwStatus(): Promise<{ active: boolean; hint?: string }> {
  if (process.platform !== "linux") return { active: false };
  const status = await runQuiet("ufw", ["status"]);
  const text = `${status.stdout}\n${status.stderr}`.toLowerCase();
  if (!status.ok && !text.includes("status:")) {
    return { active: false };
  }
  if (text.includes("status: active")) {
    return { active: true };
  }
  return { active: false };
}

export function ubuntuAvahiInstallHint(): string {
  return "sudo apt install avahi-daemon";
}

export function ufwAllowHint(port: number): string {
  return `sudo ufw allow ${port}/tcp && sudo ufw allow ${port + 1}/udp`;
}

export async function copyToClipboard(text: string): Promise<void> {
  if (process.platform === "darwin") {
    await spawnWrite("pbcopy", [], text);
    return;
  }
  if (process.platform === "linux") {
    const wl = await runQuiet("which", ["wl-copy"]);
    if (wl.ok) {
      await spawnWrite("wl-copy", [], text);
      return;
    }
    const xclip = await runQuiet("which", ["xclip"]);
    if (xclip.ok) {
      await spawnWrite("xclip", ["-selection", "clipboard"], text);
      return;
    }
    throw new Error("No clipboard tool found. Install wl-clipboard or xclip.");
  }
  throw new Error("Clipboard is not supported on this platform.");
}

export function currentShell(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("zsh")) return "zsh";
  if (shell.endsWith("bash")) return "bash";
  if (shell.endsWith("fish")) return "fish";
  return shell.split("/").pop() || "sh";
}

export function hostname(): string {
  return os.hostname();
}
