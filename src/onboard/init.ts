import net from "node:net";
import { createIdentity, isInitialized, loadIdentity } from "../identity/index.js";
import { socketPath } from "../paths.js";
import { detectPlatform, requireNode20 } from "../platform/index.js";
import { formatProbes, runProbes } from "./probes.js";
import { installUserService } from "./service.js";
import { installShellHook } from "./shell.js";

export interface InitOptions {
  name?: string;
  shell?: boolean;
}

export interface InitResult {
  identityFingerprint: string;
  deviceName: string;
  probes: string;
  service: string;
  shell?: string;
  alreadyInitialized: boolean;
}

export async function initDevice(options: InitOptions = {}): Promise<InitResult> {
  const node = requireNode20();
  if (!node.ok) {
    throw new Error(node.message);
  }
  const platform = await detectPlatform();
  if (platform === "unsupported") {
    throw new Error("cmdrop supports macOS, Linux, and Ubuntu only.");
  }

  const existed = await isInitialized();
  const identity = existed ? await loadIdentity() : await createIdentity(options.name);
  if (!existed && options.name && options.name !== identity.name) {
    // name is baked into identity at create time
  }

  const probes = await runProbes();
  const service = await installUserService();
  await waitForSocket(4000);

  let shellMessage: string | undefined;
  if (options.shell) {
    shellMessage = await installShellHook();
  }

  return {
    identityFingerprint: identity.fingerprint,
    deviceName: identity.name,
    probes: formatProbes(probes),
    service: service.message,
    shell: shellMessage,
    alreadyInitialized: existed,
  };
}

function waitForSocket(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const socket = net.connect(socketPath());
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) resolve();
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}
