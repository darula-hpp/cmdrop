import type { TLSSocket } from "node:tls";
import type { WireMessage } from "../protocol/types.js";

export function sendMessage(socket: TLSSocket, message: WireMessage): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

export function attachReader(socket: TLSSocket, onMessage: (msg: WireMessage) => void, onError?: (err: Error) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        try {
          onMessage(JSON.parse(line) as WireMessage);
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
      idx = buffer.indexOf("\n");
    }
  });
}
