import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { TLSSocket } from "node:tls";
import { Discovery } from "../discover/index.js";
import {
  findTrusted,
  loadConfig,
  loadIdentity,
  loadTls,
  pinPeer,
  unpinPeer,
} from "../identity/index.js";
import { daemonLogPath, DEFAULT_PORT, socketPath } from "../paths.js";
import { currentShell } from "../platform/index.js";
import type {
  CommandPayload,
  Identity,
  InboxAction,
  PairRequest,
  RpcRequest,
  TrustedPeer,
} from "../protocol/types.js";
import { copyCommand, insertCommand, runCommand } from "../receive/actions.js";
import { warnDangerous } from "../receive/danger.js";
import { createTlsServer, tlsConnect, type LocalTls } from "../transport/session.js";
import { WireSession } from "../transport/wire.js";
import { Inbox } from "./inbox.js";
import { SocketServer } from "./rpc.js";

interface PendingPair {
  request: PairRequest;
  session: WireSession;
  localConfirmed: boolean;
  remoteConfirmed: boolean;
  waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
}

export class CmdropDaemon {
  private identity!: Identity;
  private localTls!: LocalTls;
  private discovery = new Discovery();
  private inbox = new Inbox();
  private pairs = new Map<string, PendingPair>();
  private sessionQueue = new WeakMap<WireSession, Promise<void>>();
  private rpc: SocketServer | undefined;
  private tlsServer: ReturnType<typeof createTlsServer> | undefined;
  private port = DEFAULT_PORT;

  async start(): Promise<void> {
    this.identity = await loadIdentity();
    this.localTls = await loadTls();
    const config = await loadConfig();
    const envPort = Number.parseInt(process.env.CMDROP_PORT ?? "", 10);
    this.port = Number.isFinite(envPort) && envPort > 0 ? envPort : config.port || DEFAULT_PORT;

    this.tlsServer = createTlsServer(this.localTls, (socket) => {
      void this.onIncoming(socket);
    });
    await new Promise<void>((resolve, reject) => {
      this.tlsServer!.once("error", reject);
      this.tlsServer!.listen(this.port, "0.0.0.0", resolve);
    });

    this.discovery.start({
      name: this.identity.name,
      port: this.port,
      fingerprint: this.identity.fingerprint,
    });

    this.rpc = new SocketServer(socketPath(), (req) => this.handleRpc(req));
    await this.rpc.listen();

    this.log(
      `cmdrop daemon listening tls=:${this.port} socket=${socketPath()} device=${this.identity.name} fp=${this.identity.fingerprint}`,
    );
  }

  private log(line: string): void {
    const stamped = `${new Date().toISOString()} ${line}\n`;
    try {
      fs.appendFileSync(daemonLogPath(), stamped);
    } catch {
      // ignore
    }
    console.error(line);
  }

  private async onIncoming(socket: TLSSocket): Promise<void> {
    const session = new WireSession(socket);
    try {
      await session.handshake(this.identity, this.localTls);
      session.on("message", (msg) => {
        this.enqueuePeerMessage(session, msg);
      });
    } catch (err) {
      this.log(`incoming handshake failed: ${err instanceof Error ? err.message : err}`);
      session.close();
    }
  }

  private enqueuePeerMessage(session: WireSession, msg: import("../protocol/types.js").WireMessage): void {
    const prev = this.sessionQueue.get(session) ?? Promise.resolve();
    const next = prev.then(() => this.onPeerMessage(session, msg)).catch((err) => {
      this.log(`peer message failed: ${err instanceof Error ? err.message : err}`);
    });
    this.sessionQueue.set(session, next);
  }

  private async onPeerMessage(session: WireSession, msg: import("../protocol/types.js").WireMessage): Promise<void> {
    if (msg.type === "pair-request") {
      await this.notePair(session, "incoming");
      this.broadcast("pair.request", {
        name: session.peerName,
        fingerprint: session.peerFingerprint,
        pairingCode: session.pairingCode,
      });
      return;
    }
    if (msg.type === "pair-confirm") {
      const pending = this.pairs.get(session.peerFingerprint);
      if (pending) {
        pending.remoteConfirmed = true;
        await this.maybeFinishPair(pending);
      }
      return;
    }
    if (msg.type === "pair-reject") {
      const pending = this.pairs.get(session.peerFingerprint);
      if (pending) this.failPair(pending, new Error("Peer rejected pairing"));
      return;
    }
    if (msg.type === "offer") {
      let trusted = await findTrusted(session.peerFingerprint);
      if (!trusted) {
        const pending = this.pairs.get(session.peerFingerprint);
        if (pending?.localConfirmed) {
          pending.remoteConfirmed = true;
          await this.maybeFinishPair(pending);
          trusted = await findTrusted(session.peerFingerprint);
        }
      }
      if (!trusted) {
        session.send({ type: "error", message: "pair first" });
        return;
      }
      const offer = await this.inbox.add(msg.offer);
      session.send({ type: "offer-ack", offerId: offer.payload.id });
      this.broadcast("inbox.offer", {
        id: offer.payload.id,
        from: offer.payload.senderName,
        command: offer.payload.command,
      });
      return;
    }
  }

  private async notePair(session: WireSession, role: PairRequest["role"]): Promise<PendingPair> {
    const existing = this.pairs.get(session.peerFingerprint);
    if (existing) {
      existing.session = session;
      existing.request.role = role;
      return existing;
    }
    const request: PairRequest = {
      name: session.peerName,
      fingerprint: session.peerFingerprint,
      tlsFingerprint: session.peerTlsFingerprint,
      pairingCode: session.pairingCode,
      host: session.socket.remoteAddress ?? "",
      port: session.socket.remotePort ?? 0,
      role,
      createdAt: new Date().toISOString(),
    };
    const pending: PendingPair = {
      request,
      session,
      localConfirmed: false,
      remoteConfirmed: false,
      waiters: [],
    };
    this.pairs.set(session.peerFingerprint, pending);
    return pending;
  }

  private async maybeFinishPair(pending: PendingPair): Promise<void> {
    if (!pending.localConfirmed || !pending.remoteConfirmed) return;
    const peer: TrustedPeer = {
      name: pending.request.name,
      fingerprint: pending.request.fingerprint,
      tlsFingerprint: pending.request.tlsFingerprint,
      certPem: pending.session.peerCertPem,
      pairedAt: new Date().toISOString(),
    };
    await pinPeer(peer);
    this.discovery.markTrusted(peer.fingerprint, true);
    this.pairs.delete(peer.fingerprint);
    this.broadcast("pair.complete", { name: peer.name, fingerprint: peer.fingerprint });
    for (const w of pending.waiters) w.resolve();
    pending.waiters = [];
  }

  private failPair(pending: PendingPair, err: Error): void {
    this.pairs.delete(pending.request.fingerprint);
    this.broadcast("pair.failed", { fingerprint: pending.request.fingerprint, message: err.message });
    for (const w of pending.waiters) w.reject(err);
    pending.waiters = [];
    pending.session.close();
  }

  private waitPaired(pending: PendingPair): Promise<void> {
    if (pending.localConfirmed && pending.remoteConfirmed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
    });
  }

  private broadcast(type: string, params: Record<string, unknown>): void {
    this.rpc?.broadcast({ method: "event", params: { type, ...params } });
  }

  private async handleRpc(req: RpcRequest): Promise<unknown> {
    switch (req.method) {
      case "status":
        return {
          name: this.identity.name,
          fingerprint: this.identity.fingerprint,
          port: this.port,
          socket: socketPath(),
          peers: this.discovery.list().length,
          inbox: (await this.inbox.list()).length,
          pairing: [...this.pairs.values()].map((p) => p.request),
        };
      case "peers":
        return this.discovery.list();
      case "send":
        return this.handleSend(req.params ?? {});
      case "inbox":
        return this.handleInboxList();
      case "inbox.act":
        return this.handleInboxAct(req.params ?? {});
      case "pair.confirm":
        return this.handlePairConfirm(String(req.params?.fingerprint ?? ""), true);
      case "pair.reject":
        return this.handlePairConfirm(String(req.params?.fingerprint ?? ""), false);
      case "unpair":
        return this.handleUnpair(String(req.params?.device ?? ""));
      case "history":
        return [];
      default:
        throw new Error(`unknown method ${req.method}`);
    }
  }

  private async handleInboxList(): Promise<unknown> {
    const offers = await this.inbox.list();
    return {
      pairing: [...this.pairs.values()].map((p) => p.request),
      offers: offers.map((o) => ({
        ...o,
        warnings: warnDangerous(o.payload.command),
      })),
    };
  }

  private async handleInboxAct(params: Record<string, unknown>): Promise<unknown> {
    const id = String(params.id ?? "");
    const action = String(params.action ?? "") as InboxAction;
    const confirm = String(params.confirm ?? "");
    const offer = await this.inbox.get(id);
    if (!offer) throw new Error("offer not found or expired");
    const command = offer.payload.command;
    if (action === "reject") {
      await this.inbox.remove(id);
      return { ok: true, action };
    }
    if (action === "copy") {
      const message = await copyCommand(command);
      await this.inbox.remove(id);
      return { ok: true, action, message };
    }
    if (action === "insert") {
      const message = await insertCommand(command);
      await this.inbox.remove(id);
      return { ok: true, action, message };
    }
    if (action === "run") {
      const result = await runCommand(command, confirm);
      await this.inbox.remove(id);
      return { ok: true, action, ...result };
    }
    throw new Error(`unknown action ${action}`);
  }

  private async handlePairConfirm(fingerprint: string, accept: boolean): Promise<unknown> {
    const pending =
      this.pairs.get(fingerprint) ??
      [...this.pairs.values()].find((p) => p.request.name.toLowerCase() === fingerprint.toLowerCase());
    if (!pending) throw new Error("no pending pairing for that device");
    if (!accept) {
      pending.session.send({ type: "pair-reject", fingerprint: this.identity.fingerprint });
      this.failPair(pending, new Error("Pairing rejected"));
      return { ok: true, rejected: true };
    }
    pending.localConfirmed = true;
    pending.session.send({ type: "pair-confirm", fingerprint: this.identity.fingerprint });
    await this.maybeFinishPair(pending);
    return {
      ok: true,
      pairingCode: pending.request.pairingCode,
      complete: pending.localConfirmed && pending.remoteConfirmed,
    };
  }

  private async handleUnpair(device: string): Promise<unknown> {
    const removed = await unpinPeer(device);
    if (!removed) throw new Error(`no trusted device matching "${device}"`);
    this.discovery.markTrusted(removed.fingerprint, false);
    return { ok: true, removed };
  }

  private async handleSend(params: Record<string, unknown>): Promise<unknown> {
    const command = String(params.command ?? "").trim();
    const to = String(params.to ?? "").trim();
    if (!command) throw new Error("command is required");
    if (!to) throw new Error("recipient is required");
    const peer = this.discovery.find(to);
    if (!peer) throw new Error(`no nearby device matching "${to}"`);
    if (peer.self) throw new Error("cannot send to yourself");

    const socket = await tlsConnect({ host: peer.host, port: peer.port, local: this.localTls });
    const session = new WireSession(socket);
    await session.handshake(this.identity, this.localTls);

    const trusted = await findTrusted(session.peerFingerprint);
    if (!trusted) {
      const pending = await this.notePair(session, "outgoing");
      session.on("message", (msg) => {
        this.enqueuePeerMessage(session, msg);
      });
      session.send({
        type: "pair-request",
        name: this.identity.name,
        fingerprint: this.identity.fingerprint,
        pairingCode: session.pairingCode,
      });
      this.broadcast("pair.request", {
        name: session.peerName,
        fingerprint: session.peerFingerprint,
        pairingCode: session.pairingCode,
        role: "outgoing",
      });
      await this.waitPaired(pending);
    }

    const payload: CommandPayload = {
      id: randomUUID(),
      command,
      cwd: typeof params.cwd === "string" ? params.cwd : process.cwd(),
      shell: currentShell(),
      senderName: this.identity.name,
      senderFingerprint: this.identity.fingerprint,
      createdAt: new Date().toISOString(),
    };
    session.send({ type: "offer", offer: payload });
    const ack = await session.waitFor((m) => m.type === "offer-ack" || m.type === "error", 20_000);
    if (ack.type === "error") throw new Error(ack.message);
    if (ack.type !== "offer-ack") throw new Error(`unexpected reply ${ack.type}`);
    session.close();
    return {
      ok: true,
      offerId: payload.id,
      to: session.peerName,
      fingerprint: session.peerFingerprint,
      warnings: warnDangerous(command),
    };
  }

  async stop(): Promise<void> {
    this.discovery.stop();
    this.rpc?.close();
    await new Promise<void>((resolve) => this.tlsServer?.close(() => resolve()) ?? resolve());
  }
}
