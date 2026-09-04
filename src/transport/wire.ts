import { EventEmitter } from "node:events";
import type { TLSSocket } from "node:tls";
import { fingerprintFromCert } from "../identity/index.js";
import { pairingCode } from "../identity/fingerprint.js";
import type { Identity, WireMessage } from "../protocol/types.js";
import { attachReader, sendMessage } from "./framing.js";
import { getPeerCertPem, type LocalTls } from "./session.js";

export class WireSession extends EventEmitter {
  readonly socket: TLSSocket;
  private queue: WireMessage[] = [];
  private waiters: Array<(msg: WireMessage) => void> = [];
  closed = false;

  peerName = "";
  peerFingerprint = "";
  peerTlsFingerprint = "";
  peerCertPem = "";
  pairingCode = "";

  constructor(socket: TLSSocket) {
    super();
    this.socket = socket;
    attachReader(
      socket,
      (msg) => {
        const waiter = this.waiters.shift();
        if (waiter) waiter(msg);
        else this.queue.push(msg);
        this.emit("message", msg);
      },
      (err) => this.emit("error", err),
    );
    socket.on("close", () => {
      this.closed = true;
      this.emit("close");
    });
    socket.on("error", (err) => this.emit("error", err));
  }

  send(message: WireMessage): void {
    sendMessage(this.socket, message);
  }

  next(timeoutMs = 15_000): Promise<WireMessage> {
    return this.waitFor(() => true, timeoutMs);
  }

  waitFor(pred: (msg: WireMessage) => boolean, timeoutMs = 15_000): Promise<WireMessage> {
    const idx = this.queue.findIndex(pred);
    if (idx >= 0) {
      const [msg] = this.queue.splice(idx, 1);
      return Promise.resolve(msg!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for peer")), timeoutMs);
      const wrapped = (msg: WireMessage) => {
        if (!pred(msg)) {
          this.queue.push(msg);
          this.waiters.push(wrapped);
          return;
        }
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push(wrapped);
    });
  }

  async handshake(identity: Identity, _localTls: LocalTls): Promise<void> {
    this.send({
      type: "hello",
      name: identity.name,
      fingerprint: identity.fingerprint,
      protocolVersion: 1,
      ed25519PublicKey: identity.publicKey,
    });
    const msg = await this.next(8000);
    if (msg.type !== "hello") {
      throw new Error(`expected hello, got ${msg.type}`);
    }
    this.peerName = msg.name;
    this.peerFingerprint = msg.fingerprint;
    this.peerCertPem = getPeerCertPem(this.socket);
    this.peerTlsFingerprint = this.peerCertPem ? fingerprintFromCert(this.peerCertPem) : "";
    this.pairingCode = pairingCode(identity.fingerprint, msg.fingerprint);
  }

  close(): void {
    try {
      this.socket.end();
    } catch {
      // ignore
    }
  }
}
