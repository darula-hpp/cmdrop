import { generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import selfsigned from "selfsigned";
import {
  configDir,
  configPath,
  dataDir,
  DEFAULT_PORT,
  identityPath,
  PROTOCOL_VERSION,
  tlsCertPath,
  tlsKeyPath,
  trustedPath,
} from "../paths.js";
import type { DeviceConfig, Identity, TrustedPeer, TrustedStore } from "../protocol/types.js";
import { fingerprintFromCert, fingerprintFromPublicKey, fingerprintsEqual } from "./fingerprint.js";

const FILE_MODE = 0o600;

async function writeSecret(filePath: string, contents: string): Promise<void> {
  await fs.writeFile(filePath, contents, { mode: FILE_MODE });
  await fs.chmod(filePath, FILE_MODE);
}

export async function ensureDirs(): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
}

export async function isInitialized(): Promise<boolean> {
  try {
    await fs.access(identityPath());
    await fs.access(tlsCertPath());
    await fs.access(configPath());
    return true;
  } catch {
    return false;
  }
}

export async function createIdentity(deviceName?: string): Promise<Identity> {
  await ensureDirs();
  const name = (deviceName?.trim() || process.env.CMDROP_NAME || os.hostname() || "cmdrop-device").slice(0, 63);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const identity: Identity = {
    deviceId: randomUUID(),
    name,
    publicKey,
    privateKey,
    fingerprint: fingerprintFromPublicKey(publicKey),
  };

  const attrs = [{ name: "commonName", value: name }];
  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    algorithm: "sha256",
    days: 3650,
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    ],
  });

  await writeSecret(identityPath(), JSON.stringify(identity, null, 2));
  await writeSecret(tlsCertPath(), pems.cert);
  await writeSecret(tlsKeyPath(), pems.private);
  await writeSecret(
    configPath(),
    JSON.stringify(
      {
        name,
        port: Number.parseInt(process.env.CMDROP_PORT ?? "", 10) || DEFAULT_PORT,
        protocolVersion: PROTOCOL_VERSION,
      } satisfies DeviceConfig,
      null,
      2,
    ),
  );
  await writeSecret(trustedPath(), JSON.stringify({ peers: [] } satisfies TrustedStore, null, 2));
  return identity;
}

export async function loadIdentity(): Promise<Identity> {
  const raw = await fs.readFile(identityPath(), "utf8");
  return JSON.parse(raw) as Identity;
}

export async function loadConfig(): Promise<DeviceConfig> {
  const raw = await fs.readFile(configPath(), "utf8");
  return JSON.parse(raw) as DeviceConfig;
}

export async function saveConfig(config: DeviceConfig): Promise<void> {
  await writeSecret(configPath(), JSON.stringify(config, null, 2));
}

export async function loadTls(): Promise<{ cert: string; key: string; tlsFingerprint: string }> {
  const cert = await fs.readFile(tlsCertPath(), "utf8");
  const key = await fs.readFile(tlsKeyPath(), "utf8");
  return { cert, key, tlsFingerprint: fingerprintFromCert(cert) };
}

export async function loadTrusted(): Promise<TrustedStore> {
  try {
    const raw = await fs.readFile(trustedPath(), "utf8");
    return JSON.parse(raw) as TrustedStore;
  } catch {
    return { peers: [] };
  }
}

export async function saveTrusted(store: TrustedStore): Promise<void> {
  await writeSecret(trustedPath(), JSON.stringify(store, null, 2));
}

export async function findTrusted(
  fingerprint: string,
  store?: TrustedStore,
): Promise<TrustedPeer | undefined> {
  const s = store ?? (await loadTrusted());
  return s.peers.find(
    (p) => fingerprintsEqual(p.fingerprint, fingerprint) || fingerprintsEqual(p.tlsFingerprint, fingerprint),
  );
}

export async function pinPeer(peer: TrustedPeer): Promise<void> {
  const store = await loadTrusted();
  store.peers = store.peers.filter(
    (p) =>
      !fingerprintsEqual(p.fingerprint, peer.fingerprint) &&
      !fingerprintsEqual(p.tlsFingerprint, peer.tlsFingerprint),
  );
  store.peers.push(peer);
  await saveTrusted(store);
}

export async function unpinPeer(device: string): Promise<TrustedPeer | undefined> {
  const store = await loadTrusted();
  const needle = device.toLowerCase();
  const found = store.peers.find(
    (p) =>
      p.name.toLowerCase() === needle ||
      fingerprintsEqual(p.fingerprint, device) ||
      fingerprintsEqual(p.tlsFingerprint, device),
  );
  if (!found) return undefined;
  store.peers = store.peers.filter((p) => p !== found);
  await saveTrusted(store);
  return found;
}

export { fingerprintFromCert, fingerprintFromPublicKey } from "./fingerprint.js";
