import os from "node:os";
import path from "node:path";

export const APP_NAME = "cmdrop";
export const PROTOCOL_VERSION = 1;
export const MDNS_TYPE = "cmdrop";
export const DEFAULT_PORT = 45454;
export const UDP_MULTICAST_ADDR = "239.255.42.99";
export const UDP_PORT = 45455;
export const OFFER_TTL_MS = 2 * 60 * 1000;

export function homeDir(): string {
  return os.homedir();
}

let cachedConfigDir: string | undefined;
let cachedDataDir: string | undefined;

export function configDir(): string {
  if (cachedConfigDir) return cachedConfigDir;
  if (process.env.CMDROP_CONFIG_DIR) {
    cachedConfigDir = process.env.CMDROP_CONFIG_DIR;
    return cachedConfigDir;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  cachedConfigDir = path.join(xdg && xdg.length > 0 ? xdg : path.join(homeDir(), ".config"), APP_NAME);
  return cachedConfigDir;
}

export function dataDir(): string {
  if (cachedDataDir) return cachedDataDir;
  if (process.env.CMDROP_DATA_DIR) {
    cachedDataDir = process.env.CMDROP_DATA_DIR;
    return cachedDataDir;
  }
  const xdg = process.env.XDG_DATA_HOME;
  cachedDataDir = path.join(xdg && xdg.length > 0 ? xdg : path.join(homeDir(), ".local", "share"), APP_NAME);
  return cachedDataDir;
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function identityPath(): string {
  return path.join(configDir(), "identity.json");
}

export function tlsCertPath(): string {
  return path.join(configDir(), "tls-cert.pem");
}

export function tlsKeyPath(): string {
  return path.join(configDir(), "tls-key.pem");
}

export function trustedPath(): string {
  return path.join(configDir(), "trusted.json");
}

export function socketPath(): string {
  return path.join(dataDir(), "cmdrop.sock");
}

export function insertPath(): string {
  return path.join(dataDir(), "insert.txt");
}

export function daemonLogPath(): string {
  return path.join(dataDir(), "daemon.log");
}

export function inboxPath(): string {
  return path.join(dataDir(), "inbox.json");
}
