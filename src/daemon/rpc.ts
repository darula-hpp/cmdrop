import net from "node:net";
import fs from "node:fs";
import type { RpcEvent, RpcRequest, RpcResponse } from "../protocol/types.js";

export type RpcHandler = (req: RpcRequest) => Promise<unknown>;

export class SocketServer {
  private server: net.Server | undefined;
  private clients = new Set<net.Socket>();

  constructor(
    private readonly path: string,
    private readonly handler: RpcHandler,
  ) {}

  async listen(): Promise<void> {
    try {
      fs.unlinkSync(this.path);
    } catch {
      // no leftover socket
    }
    this.server = net.createServer((socket) => this.onClient(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.path, resolve);
    });
    try {
      fs.chmodSync(this.path, 0o600);
    } catch {
      // ignore
    }
  }

  private onClient(socket: net.Socket): void {
    this.clients.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) void this.handleLine(socket, line);
        idx = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch {
      socket.write(`${JSON.stringify({ id: "?", error: { message: "invalid json" } } satisfies RpcResponse)}\n`);
      return;
    }
    try {
      const result = await this.handler(req);
      const res: RpcResponse = { id: req.id, result };
      socket.write(`${JSON.stringify(res)}\n`);
    } catch (err) {
      const res: RpcResponse = {
        id: req.id,
        error: { message: err instanceof Error ? err.message : String(err) },
      };
      socket.write(`${JSON.stringify(res)}\n`);
    }
  }

  broadcast(event: RpcEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    for (const client of this.clients) {
      try {
        client.write(line);
      } catch {
        // ignore
      }
    }
  }

  close(): void {
    for (const client of this.clients) {
      try {
        client.destroy();
      } catch {
        // ignore
      }
    }
    this.server?.close();
    try {
      fs.unlinkSync(this.path);
    } catch {
      // ignore
    }
  }
}
