import net from "node:net";
import { spawn } from "node:child_process";
import { resolveDaemonArgv } from "../bin.js";
import { socketPath } from "../paths.js";
import type { RpcEvent, RpcRequest, RpcResponse } from "../protocol/types.js";

export class DaemonClient {
  private socket: net.Socket | undefined;
  private buffer = "";
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private events: Array<(e: RpcEvent) => void> = [];
  private nextId = 1;

  async connect(sock = socketPath()): Promise<void> {
    this.socket = await connectSocket(sock);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.onLine(line);
        idx = this.buffer.indexOf("\n");
      }
    });
    this.socket.on("error", (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  onEvent(fn: (e: RpcEvent) => void): () => void {
    this.events.push(fn);
    return () => {
      this.events = this.events.filter((x) => x !== fn);
    };
  }

  private onLine(line: string): void {
    const parsed = JSON.parse(line) as RpcResponse & RpcEvent;
    if (parsed.method === "event") {
      for (const fn of this.events) fn(parsed);
      return;
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    if (parsed.error) pending.reject(new Error(parsed.error.message));
    else pending.resolve(parsed.result);
  }

  call(method: RpcRequest["method"], params?: Record<string, unknown>): Promise<unknown> {
    const id = String(this.nextId++);
    const req: RpcRequest = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket?.write(`${JSON.stringify(req)}\n`);
    });
  }

  close(): void {
    this.socket?.destroy();
  }
}

async function connectSocket(sock: string): Promise<net.Socket> {
  try {
    return await tryConnect(sock);
  } catch {
    if (sock !== socketPath()) {
      throw new Error(`could not connect to cmdrop daemon at ${sock}`);
    }
    spawnDaemon();
    const deadline = Date.now() + 8000;
    let last: Error | undefined;
    while (Date.now() < deadline) {
      await sleep(150);
      try {
        return await tryConnect(sock);
      } catch (err) {
        last = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw last ?? new Error("could not connect to cmdrop daemon");
  }
}

function tryConnect(sock: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sock);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function spawnDaemon(): void {
  const { cmd, args } = resolveDaemonArgv();
  const child = spawn(cmd, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function withDaemon<T>(fn: (client: DaemonClient) => Promise<T>): Promise<T> {
  const client = new DaemonClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
