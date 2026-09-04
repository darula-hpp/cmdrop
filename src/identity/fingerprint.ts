import { createHash } from "node:crypto";

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function formatFingerprint(hex: string): string {
  const compact = hex.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  const pairs = compact.match(/.{1,4}/g) ?? [compact];
  return pairs.slice(0, 8).join(":");
}

export function fingerprintFromPublicKey(publicKeyPemOrDer: string | Buffer): string {
  return formatFingerprint(sha256Hex(publicKeyPemOrDer));
}

export function fingerprintFromCert(certPem: string): string {
  const der = pemToDer(certPem);
  return formatFingerprint(sha256Hex(der));
}

export function pemToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return Buffer.from(body, "base64");
}

/** Both sides compute the same 6-digit code from the two fingerprints. */
export function pairingCode(localFingerprint: string, peerFingerprint: string): string {
  const [a, b] = [localFingerprint, peerFingerprint].sort();
  const hex = sha256Hex(`${a}|${b}`);
  const n = Number.parseInt(hex.slice(0, 8), 16) % 1_000_000;
  return n.toString().padStart(6, "0");
}

export function fingerprintsEqual(a: string, b: string): boolean {
  return a.replace(/[^a-f0-9]/gi, "").toLowerCase() === b.replace(/[^a-f0-9]/gi, "").toLowerCase();
}
