import { EventEmitter } from "node:events";
import Bonjour from "bonjour-service";
import { MDNS_TYPE, PROTOCOL_VERSION } from "../paths.js";
import type { PeerInfo } from "../protocol/types.js";

interface Service {
  name: string;
  host: string;
  port: number;
  addresses?: string[];
  txt?: Record<string, unknown>;
  referer?: { address?: string };
}

interface Browser {
  on(event: "up" | "down", listener: (service: Service) => void): this;
  stop(): void;
}

export interface AdvertiseOpts {
  name: string;
  port: number;
  fingerprint: string;
}

export interface MdnsDiscovery {
  on(event: "up" | "down", listener: (peer: PeerInfo) => void): this;
  advertise(opts: AdvertiseOpts): void;
  stop(): void;
}

function txtString(txt: Record<string, unknown> | undefined, key: string): string {
  if (!txt) return "";
  const value = txt[key];
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value == null) return "";
  return String(value);
}

function hostFromService(service: Service): string {
  const addresses = (service.addresses ?? []).filter((a) => !a.includes(":"));
  if (addresses.length > 0) return addresses[0]!;
  if (service.referer?.address) return service.referer.address;
  return service.host;
}

function peerFromService(service: Service): PeerInfo | undefined {
  const fingerprint = txtString(service.txt as Record<string, unknown> | undefined, "fp");
  if (!fingerprint || !service.port) return undefined;
  const ver = Number.parseInt(txtString(service.txt as Record<string, unknown> | undefined, "ver") || "1", 10);
  return {
    name: txtString(service.txt as Record<string, unknown> | undefined, "name") || service.name,
    host: hostFromService(service),
    port: service.port,
    fingerprint,
    protocolVersion: Number.isFinite(ver) ? ver : PROTOCOL_VERSION,
    trusted: false,
    source: "mdns",
  };
}

export class BonjourDiscovery extends EventEmitter implements MdnsDiscovery {
  private bonjour = new Bonjour();
  private browser: Browser | undefined;
  private advertised: { stop: CallableFunction } | undefined;

  startBrowse(): void {
    if (this.browser) return;
    this.browser = this.bonjour.find({ type: MDNS_TYPE, protocol: "tcp" });
    this.browser.on("up", (service: Service) => {
      const peer = peerFromService(service);
      if (peer) this.emit("up", peer);
    });
    this.browser.on("down", (service: Service) => {
      const peer = peerFromService(service);
      if (peer) this.emit("down", peer);
    });
  }

  advertise(opts: AdvertiseOpts): void {
    this.advertised?.stop();
    this.advertised = this.bonjour.publish({
      name: `${opts.name} ${opts.fingerprint.slice(0, 9)}`,
      type: MDNS_TYPE,
      protocol: "tcp",
      port: opts.port,
      txt: {
        name: opts.name,
        ver: String(PROTOCOL_VERSION),
        fp: opts.fingerprint,
      },
    });
  }

  stop(): void {
    try {
      this.advertised?.stop();
    } catch {
      // ignore
    }
    try {
      this.browser?.stop();
    } catch {
      // ignore
    }
    try {
      this.bonjour.destroy();
    } catch {
      // ignore
    }
  }
}
