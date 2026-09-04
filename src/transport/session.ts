import tls, { type TLSSocket } from "node:tls";
import { fingerprintFromCert } from "../identity/index.js";
import { pairingCode } from "../identity/fingerprint.js";
import type { CommandPayload, Identity, WireMessage } from "../protocol/types.js";
import { attachReader, sendMessage } from "./framing.js";

export interface LocalTls {
  cert: string;
  key: string;
  tlsFingerprint: string;
}

export interface HelloInfo {
  name: string;
  fingerprint: string;
  protocolVersion: number;
  ed25519PublicKey: string;
  tlsFingerprint: string;
  certPem: string;
  pairingCode: string;
}

export function getPeerCertPem(socket: TLSSocket): string {
  const cert = socket.getPeerCertificate(true);
  if (!cert?.raw) return "";
  const b64 = cert.raw.toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [b64];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

export function tlsConnect(opts: {
  host: string;
  port: number;
  local: LocalTls;
}): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: opts.host,
        port: opts.port,
        cert: opts.local.cert,
        key: opts.local.key,
        rejectUnauthorized: false,
        requestCert: true,
      },
      () => resolve(socket),
    );
    socket.once("error", reject);
  });
}

export function createTlsServer(
  local: LocalTls,
  onSocket: (socket: TLSSocket) => void,
): tls.Server {
  return tls.createServer(
    {
      cert: local.cert,
      key: local.key,
      requestCert: true,
      rejectUnauthorized: false,
    },
    onSocket,
  );
}

export function exchangeHello(opts: {
  socket: TLSSocket;
  identity: Identity;
  localTls: LocalTls;
}): Promise<HelloInfo> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hello timeout")), 8000);
    attachReader(
      opts.socket,
      (msg) => {
        if (msg.type !== "hello") return;
        const certPem = getPeerCertPem(opts.socket);
        const tlsFp = certPem ? fingerprintFromCert(certPem) : "";
        const code = pairingCode(opts.identity.fingerprint, msg.fingerprint);
        clearTimeout(timer);
        resolve({
          name: msg.name,
          fingerprint: msg.fingerprint,
          protocolVersion: msg.protocolVersion,
          ed25519PublicKey: msg.ed25519PublicKey,
          tlsFingerprint: tlsFp,
          certPem,
          pairingCode: code,
        });
      },
      reject,
    );
    sendMessage(opts.socket, {
      type: "hello",
      name: opts.identity.name,
      fingerprint: opts.identity.fingerprint,
      protocolVersion: 1,
      ed25519PublicKey: opts.identity.publicKey,
    });
  });
}

export function writeOffer(socket: TLSSocket, offer: CommandPayload): void {
  sendMessage(socket, { type: "offer", offer });
}

export function writeWire(socket: TLSSocket, message: WireMessage): void {
  sendMessage(socket, message);
}
