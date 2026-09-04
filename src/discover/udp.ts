import { EventEmitter } from "node:events";
import dgram from "node:dgram";
import os from "node:os";
import { PROTOCOL_VERSION, UDP_MULTICAST_ADDR, UDP_PORT } from "../paths.js";
import type { PeerInfo } from "../protocol/types.js";

interface Announce {
  v: number;
  kind: "cmdrop-announce";
  name: string;
  port: number;
  fingerprint: string;
  protocolVersion: number;
}

const INTERVAL_MS = 4000;
const STALE_MS = 12_000;

export class UdpDiscovery extends EventEmitter {
  private socket: dgram.Socket | undefined;
  private timer: NodeJS.Timeout | undefined;
  private seen = new Map<string, { peer: PeerInfo; lastSeen: number }>();
  private sweep: NodeJS.Timeout | undefined;
  private local: Announce | undefined;

  start(local: { name: string; port: number; fingerprint: string }): void {
    this.local = {
      v: 1,
      kind: "cmdrop-announce",
      name: local.name,
      port: local.port,
      fingerprint: local.fingerprint,
      protocolVersion: PROTOCOL_VERSION,
    };
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket = socket;
    socket.on("error", () => {
      // keep daemon alive; mDNS may still work
    });
    socket.on("message", (msg, rinfo) => {
      this.onMessage(msg, rinfo.address);
    });
    socket.bind(UDP_PORT, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(1);
        socket.addMembership(UDP_MULTICAST_ADDR);
      } catch {
        // membership can fail on some interfaces; broadcast still helps
      }
      this.timer = setInterval(() => this.announce(), INTERVAL_MS);
      this.announce();
    });
    this.sweep = setInterval(() => this.dropStale(), 3000);
  }

  private announce(): void {
    if (!this.local || !this.socket) return;
    const buf = Buffer.from(JSON.stringify(this.local), "utf8");
    try {
      this.socket.send(buf, UDP_PORT, UDP_MULTICAST_ADDR);
    } catch {
      // ignore
    }
    for (const addr of broadcastAddresses()) {
      try {
        this.socket.send(buf, UDP_PORT, addr);
      } catch {
        // ignore
      }
    }
  }

  private onMessage(msg: Buffer, host: string): void {
    try {
      const parsed = JSON.parse(msg.toString("utf8")) as Announce;
      if (parsed.kind !== "cmdrop-announce") return;
      if (this.local && parsed.fingerprint === this.local.fingerprint) return;
      const peer: PeerInfo = {
        name: parsed.name,
        host,
        port: parsed.port,
        fingerprint: parsed.fingerprint,
        protocolVersion: parsed.protocolVersion ?? PROTOCOL_VERSION,
        trusted: false,
        source: "udp",
      };
      const prev = this.seen.get(peer.fingerprint);
      this.seen.set(peer.fingerprint, { peer, lastSeen: Date.now() });
      if (!prev) this.emit("up", peer);
    } catch {
      // ignore junk
    }
  }

  private dropStale(): void {
    const now = Date.now();
    for (const [fp, entry] of this.seen) {
      if (now - entry.lastSeen > STALE_MS) {
        this.seen.delete(fp);
        this.emit("down", entry.peer);
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sweep) clearInterval(this.sweep);
    try {
      this.socket?.close();
    } catch {
      // ignore
    }
  }
}

function broadcastAddresses(): string[] {
  const out = new Set<string>(["255.255.255.255"]);
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      const addr = ipv4ToInt(info.address);
      const mask = ipv4ToInt(info.netmask);
      if (addr === undefined || mask === undefined) continue;
      out.add(intToIpv4((addr & mask) | (~mask >>> 0)));
    }
  }
  return [...out];
}

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  return (((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!) >>> 0;
}

function intToIpv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}
