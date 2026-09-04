import { EventEmitter } from "node:events";
import { findTrusted } from "../identity/index.js";
import type { PeerInfo } from "../protocol/types.js";
import { BonjourDiscovery } from "./mdns.js";
import { UdpDiscovery } from "./udp.js";

export class Discovery extends EventEmitter {
  private mdns = new BonjourDiscovery();
  private udp = new UdpDiscovery();
  private peers = new Map<string, PeerInfo>();
  private localFingerprint = "";

  constructor() {
    super();
    const onUp = async (peer: PeerInfo) => {
      if (peer.fingerprint === this.localFingerprint) return;
      const trusted = Boolean(await findTrusted(peer.fingerprint));
      const next = { ...peer, trusted };
      const key = peer.fingerprint;
      const existing = this.peers.get(key);
      if (existing && existing.source === "mdns" && peer.source === "udp") {
        return;
      }
      this.peers.set(key, next);
      this.emit("up", next);
    };
    const onDown = (peer: PeerInfo) => {
      const current = this.peers.get(peer.fingerprint);
      if (!current) return;
      if (current.source !== peer.source && current.source === "mdns") return;
      this.peers.delete(peer.fingerprint);
      this.emit("down", current);
    };
    this.mdns.on("up", onUp);
    this.mdns.on("down", onDown);
    this.udp.on("up", onUp);
    this.udp.on("down", onDown);
  }

  start(local: { name: string; port: number; fingerprint: string }): void {
    this.localFingerprint = local.fingerprint;
    this.mdns.startBrowse();
    this.mdns.advertise({ name: local.name, port: local.port, fingerprint: local.fingerprint });
    // UDP runs alongside mDNS so peers still appear if Bonjour/Avahi drops a service.
    this.udp.start(local);
    const selfPeer: PeerInfo = {
      name: local.name,
      host: "127.0.0.1",
      port: local.port,
      fingerprint: local.fingerprint,
      protocolVersion: 1,
      trusted: true,
      self: true,
      source: "self",
    };
    this.peers.set(local.fingerprint, selfPeer);
  }

  list(): PeerInfo[] {
    return [...this.peers.values()].sort((a, b) => Number(Boolean(b.self)) - Number(Boolean(a.self)) || a.name.localeCompare(b.name));
  }

  find(nameOrFp: string): PeerInfo | undefined {
    const needle = nameOrFp.toLowerCase();
    return this.list().find(
      (p) =>
        !p.self &&
        (p.name.toLowerCase() === needle ||
          p.fingerprint.replace(/[^a-f0-9]/gi, "") === needle.replace(/[^a-f0-9]/gi, "")),
    );
  }

  markTrusted(fingerprint: string, trusted: boolean): void {
    const peer = this.peers.get(fingerprint);
    if (peer) this.peers.set(fingerprint, { ...peer, trusted });
  }

  stop(): void {
    this.mdns.stop();
    this.udp.stop();
  }
}
