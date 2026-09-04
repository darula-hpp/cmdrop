import { DEFAULT_PORT } from "../paths.js";
import {
  avahiActive,
  detectPlatform,
  readOsRelease,
  requireNode20,
  ubuntuAvahiInstallHint,
  ufwAllowHint,
  ufwStatus,
  type PlatformId,
} from "../platform/index.js";

export interface ProbeResult {
  platform: PlatformId;
  node: { ok: boolean; version: string; message?: string };
  mdns: { available: boolean; fallback: boolean; messages: string[] };
  firewall: string[];
  notes: string[];
}

export async function runProbes(port = DEFAULT_PORT): Promise<ProbeResult> {
  const platform = await detectPlatform();
  const node = requireNode20();
  const messages: string[] = [];
  const notes: string[] = [];
  const firewall: string[] = [];
  let mdnsAvailable = true;
  let fallback = false;

  if (platform === "unsupported") {
    notes.push("cmdrop supports macOS, Linux, and Ubuntu. This platform is not supported.");
  }

  if (platform === "macos") {
    messages.push("Bonjour is built in. The first LAN advertise may trigger a Local Network permission prompt on macOS 15+ — allow cmdrop / Node.");
    notes.push("Daemon will be installed as a launchd user agent: ~/Library/LaunchAgents/com.cmdrop.daemon.plist");
  }

  if (platform === "linux" || platform === "ubuntu") {
    const avahi = await avahiActive();
    if (avahi.active) {
      messages.push(avahi.hint);
    } else {
      mdnsAvailable = avahi.present && avahi.active;
      fallback = true;
      messages.push(avahi.hint);
      if (platform === "ubuntu" && !avahi.present) {
        messages.push(`Install Avahi: ${ubuntuAvahiInstallHint()}`);
      } else if (!avahi.present) {
        messages.push("Install avahi-daemon with your distro package manager for mDNS discovery.");
      }
    }
    notes.push("Daemon will be installed as a systemd --user unit: ~/.config/systemd/user/cmdrop.service");

    const ufw = await ufwStatus();
    if (ufw.active) {
      firewall.push(
        `ufw is active. cmdrop will not change your firewall. If peers cannot connect, allow the advertised port:\n  ${ufwAllowHint(port)}`,
      );
    }
  }

  const release = platform === "ubuntu" || platform === "linux" ? await readOsRelease() : undefined;
  if (release?.prettyName) {
    notes.push(`Detected OS: ${release.prettyName}`);
  }

  return {
    platform,
    node,
    mdns: { available: mdnsAvailable, fallback, messages },
    firewall,
    notes,
  };
}

export function formatProbes(probes: ProbeResult): string {
  const lines: string[] = [];
  lines.push(`Platform: ${probes.platform}`);
  lines.push(`Node: ${probes.node.ok ? "ok" : "too old"} (${probes.node.version})`);
  if (probes.node.message) lines.push(`  ${probes.node.message}`);
  lines.push(`mDNS: ${probes.mdns.available ? "available" : "unavailable"}${probes.mdns.fallback ? " (UDP fallback enabled)" : ""}`);
  for (const m of probes.mdns.messages) lines.push(`  ${m}`);
  for (const f of probes.firewall) lines.push(f);
  for (const n of probes.notes) lines.push(n);
  return lines.join("\n");
}
