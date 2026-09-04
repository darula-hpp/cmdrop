export const PROTOCOL_VERSION = 1;

export interface DeviceConfig {
  name: string;
  port: number;
  protocolVersion: number;
}

export interface Identity {
  deviceId: string;
  name: string;
  publicKey: string;
  privateKey: string;
  fingerprint: string;
}

export interface TrustedPeer {
  name: string;
  fingerprint: string;
  tlsFingerprint: string;
  certPem: string;
  pairedAt: string;
}

export interface TrustedStore {
  peers: TrustedPeer[];
}

export interface CommandPayload {
  id: string;
  command: string;
  cwd?: string;
  shell?: string;
  senderName: string;
  senderFingerprint: string;
  createdAt: string;
}

export interface PeerInfo {
  name: string;
  host: string;
  port: number;
  fingerprint: string;
  protocolVersion: number;
  trusted: boolean;
  self?: boolean;
  source: "mdns" | "udp" | "self";
}

export interface InboxOffer {
  payload: CommandPayload;
  receivedAt: string;
  expiresAt: string;
}

export interface PairRequest {
  name: string;
  fingerprint: string;
  tlsFingerprint: string;
  pairingCode: string;
  host: string;
  port: number;
  role: "incoming" | "outgoing";
  createdAt: string;
}

export type WireMessage =
  | {
      type: "hello";
      name: string;
      fingerprint: string;
      protocolVersion: number;
      ed25519PublicKey: string;
    }
  | { type: "pair-request"; name: string; fingerprint: string; pairingCode: string }
  | { type: "pair-confirm"; fingerprint: string }
  | { type: "pair-reject"; fingerprint: string }
  | { type: "offer"; offer: CommandPayload }
  | { type: "offer-ack"; offerId: string }
  | { type: "reject"; offerId: string; reason?: string }
  | { type: "error"; message: string };

export type RpcMethod =
  | "status"
  | "peers"
  | "send"
  | "inbox"
  | "inbox.act"
  | "pair.confirm"
  | "pair.reject"
  | "unpair"
  | "history";

export interface RpcRequest {
  id: string;
  method: RpcMethod;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id: string;
  result?: unknown;
  error?: { message: string };
}

export interface RpcEvent {
  method: "event";
  params: {
    type: string;
    [key: string]: unknown;
  };
}

export type InboxAction = "copy" | "insert" | "run" | "reject";

export interface DangerWarning {
  id: string;
  message: string;
}
