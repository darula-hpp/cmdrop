#!/usr/bin/env node
import { Command } from "commander";
import { isInitialized } from "./identity/index.js";
import { initDevice } from "./onboard/init.js";
import { restartUserService } from "./onboard/service.js";
import { installShellHook } from "./onboard/shell.js";
import { requireNode20 } from "./platform/index.js";
import type { InboxOffer, PairRequest, PeerInfo } from "./protocol/types.js";
import { warnDangerous } from "./receive/danger.js";
import { lastCommand, readShellHistory } from "./select/history.js";
import { pickItem } from "./select/picker.js";
import { withDaemon, type DaemonClient } from "./cli/client.js";
import { ask, confirm, readStdin } from "./cli/prompt.js";

const program = new Command();
program.name("cmdrop").description("AirDrop for shell commands").version("0.1.0");

program
  .command("init")
  .description("Create device identity, probe the LAN, and install the user daemon")
  .option("--name <name>", "device display name")
  .option("--shell", "install zsh/bash/fish insert hook")
  .action(async (opts: { name?: string; shell?: boolean }) => {
    const result = await initDevice({ name: opts.name, shell: opts.shell });
    console.log(result.alreadyInitialized ? "cmdrop was already initialized." : "cmdrop initialized.");
    console.log(`Device: ${result.deviceName}`);
    console.log(`Fingerprint: ${result.identityFingerprint}`);
    console.log("");
    console.log(result.probes);
    console.log("");
    console.log(result.service);
    if (result.shell) console.log(result.shell);
  });

program
  .command("send")
  .description("Send a command to a nearby device")
  .option("--to <device>", "recipient device name or fingerprint")
  .option("--last", "send the last shell history command")
  .argument("[command...]", "command text (or omit to pick from history)")
  .action(async (commandParts: string[], opts: { to?: string; last?: boolean }) => {
    await ensureReady();
    const command = await resolveCommand(commandParts, opts.last === true);
    if (!command) {
      console.error("No command selected.");
      process.exitCode = 1;
      return;
    }
    const warnings = warnDangerous(command);
    if (warnings.length > 0) {
      console.log("Warning: this command looks dangerous:");
      for (const w of warnings) console.log(`  - ${w.message}`);
      if (!(await confirm("Send it anyway?"))) {
        console.log("Cancelled.");
        return;
      }
    }
    await withDaemon(async (client) => {
      const to = opts.to ?? (await pickPeer(client));
      if (!to) {
        console.error("No recipient selected.");
        process.exitCode = 1;
        return;
      }
      const pairing = new Promise<{ name: string; fingerprint: string; pairingCode: string }>((resolve) => {
        client.onEvent((ev) => {
          if (ev.params.type === "pair.request") {
            resolve({
              name: String(ev.params.name ?? to),
              fingerprint: String(ev.params.fingerprint ?? ""),
              pairingCode: String(ev.params.pairingCode ?? ""),
            });
          }
        });
      });
      const sendPromise = client.call("send", { command, to, cwd: process.cwd() });
      const raced = await Promise.race([
        sendPromise.then((result) => ({ kind: "sent" as const, result })),
        pairing.then((pair) => ({ kind: "pair" as const, pair })),
      ]);
      if (raced.kind === "pair") {
        console.log("");
        console.log(`Pairing with ${raced.pair.name}`);
        console.log(`Code: ${raced.pair.pairingCode}`);
        console.log("The other device should show the same code. Confirm there with: cmdrop inbox");
        const ok = await confirm("Does the other device show the same pairing code?");
        if (!ok) {
          await client.call("pair.reject", { fingerprint: raced.pair.fingerprint }).catch(() => undefined);
          console.log("Pairing rejected.");
          return;
        }
        await client.call("pair.confirm", { fingerprint: raced.pair.fingerprint });
        console.log("Waiting for the other device to confirm…");
        const result = (await sendPromise) as { to: string; offerId: string };
        console.log(`Delivered to ${result.to} inbox (${result.offerId}).`);
        console.log("They must preview it before copy / insert / run. Commands never auto-run.");
        return;
      }
      const result = raced.result as { to: string; offerId: string };
      console.log(`Delivered to ${result.to} inbox (${result.offerId}).`);
      console.log("They must preview it before copy / insert / run. Commands never auto-run.");
    });
  });

program
  .command("inbox")
  .description("Preview pending offers and pairing requests")
  .action(async () => {
    await ensureReady();
    await withDaemon(async (client) => {
      const data = (await client.call("inbox")) as {
        pairing: PairRequest[];
        offers: Array<InboxOffer & { warnings: { id: string; message: string }[] }>;
      };
      const items = [
        ...data.pairing.map((p) => ({
          id: `pair:${p.fingerprint}`,
          label: `Pair ${p.name}  code ${p.pairingCode}`,
          detail: p.role,
        })),
        ...data.offers.map((o) => ({
          id: o.payload.id,
          label: o.payload.command,
          detail: `from ${o.payload.senderName}`,
        })),
      ];
      if (items.length === 0) {
        console.log("Inbox is empty.");
        return;
      }
      const picked = await pickItem("Inbox — pairing and offers", items);
      if (!picked) return;
      if (picked.id.startsWith("pair:")) {
        const fp = picked.id.slice("pair:".length);
        const req = data.pairing.find((p) => p.fingerprint === fp);
        console.log(`Device: ${req?.name}`);
        console.log(`Fingerprint: ${fp}`);
        console.log(`Pairing code: ${req?.pairingCode}`);
        if (await confirm("Pair with this device?")) {
          await client.call("pair.confirm", { fingerprint: fp });
          console.log("Paired. Future drops from this device skip the code.");
        } else {
          await client.call("pair.reject", { fingerprint: fp });
          console.log("Rejected.");
        }
        return;
      }
      const offer = data.offers.find((o) => o.payload.id === picked.id);
      if (!offer) return;
      console.log("");
      console.log(`From: ${offer.payload.senderName} (${offer.payload.senderFingerprint})`);
      if (offer.payload.cwd) console.log(`cwd hint: ${offer.payload.cwd}`);
      console.log(`Command:\n  ${offer.payload.command}`);
      if (offer.warnings.length > 0) {
        console.log("Warnings:");
        for (const w of offer.warnings) console.log(`  - ${w.message}`);
      }
      const action = await pickItem("Preview — choose an action (never auto-runs)", [
        { id: "copy", label: "Copy to clipboard" },
        { id: "insert", label: "Insert into next prompt (or clipboard fallback)" },
        { id: "run", label: "Run after typing confirm" },
        { id: "reject", label: "Reject / dismiss" },
      ]);
      if (!action) return;
      if (action.id === "run") {
        const typed = await ask('Type "run" to execute this command: ');
        const result = (await client.call("inbox.act", {
          id: offer.payload.id,
          action: "run",
          confirm: typed,
        })) as { stdout?: string; stderr?: string };
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        return;
      }
      const result = (await client.call("inbox.act", {
        id: offer.payload.id,
        action: action.id,
      })) as { message?: string };
      console.log(result.message ?? "Done.");
    });
  });

program
  .command("peers")
  .description("List nearby cmdrop devices")
  .action(async () => {
    await ensureReady();
    await withDaemon(async (client) => {
      const peers = (await client.call("peers")) as PeerInfo[];
      if (peers.length === 0) {
        console.log("No devices found. Is the daemon running on the other machine?");
        return;
      }
      for (const p of peers) {
        const flags = [
          p.self ? "this device" : undefined,
          p.trusted ? "trusted" : "unpaired",
          p.source,
        ]
          .filter(Boolean)
          .join(", ");
        console.log(`${p.name}\t${p.fingerprint}\t${p.host}:${p.port}\t${flags}`);
      }
    });
  });

program
  .command("history")
  .description("Browse local shell history (does not send)")
  .action(async () => {
    const entries = await readShellHistory();
    const picked = await pickItem(
      "Shell history",
      entries.map((e, i) => ({ id: String(i), label: e.command })),
    );
    if (picked) console.log(picked.label);
  });

program
  .command("unpair")
  .description("Forget a trusted device")
  .argument("<device>", "device name or fingerprint")
  .action(async (device: string) => {
    await ensureReady();
    await withDaemon(async (client) => {
      const result = (await client.call("unpair", { device })) as { removed: { name: string } };
      console.log(`Unpaired ${result.removed.name}.`);
    });
  });

program
  .command("status")
  .description("Show daemon and device status")
  .action(async () => {
    await ensureReady();
    await withDaemon(async (client) => {
      const status = await client.call("status");
      console.log(JSON.stringify(status, null, 2));
    });
  });

program
  .command("restart")
  .description("Reload the user daemon (launchd / systemd)")
  .action(async () => {
    const result = await restartUserService();
    console.log(result.message);
    if (!result.started) process.exitCode = 1;
  });

program
  .command("hook")
  .description("Install the shell insert hook")
  .action(async () => {
    console.log(await installShellHook());
  });

async function ensureReady(): Promise<void> {
  const node = requireNode20();
  if (!node.ok) {
    throw new Error(node.message);
  }
  if (!(await isInitialized())) {
    console.log("cmdrop is not initialized yet. Running init…");
    const result = await initDevice();
    console.log(`Device: ${result.deviceName}`);
    console.log(`Fingerprint: ${result.identityFingerprint}`);
    console.log(result.service);
  }
}

async function resolveCommand(parts: string[], last: boolean): Promise<string | undefined> {
  if (last) {
    const entries = await readShellHistory();
    return lastCommand(entries);
  }
  if (parts.length > 0) return parts.join(" ");
  if (!process.stdin.isTTY) {
    const piped = await readStdin();
    if (piped) return piped;
  }
  const entries = await readShellHistory();
  if (entries.length === 0) {
    console.error("No shell history found. Pass a command: cmdrop send -- 'echo hello'");
    return undefined;
  }
  const picked = await pickItem(
    "Select a command to send",
    entries.map((e, i) => ({ id: String(i), label: e.command })),
  );
  return picked?.label;
}

async function pickPeer(client: DaemonClient): Promise<string | undefined> {
  const peers = ((await client.call("peers")) as PeerInfo[]).filter((p) => !p.self);
  if (peers.length === 0) {
    console.error("No nearby devices. On the other machine run: cmdrop init");
    return undefined;
  }
  if (peers.length === 1) return peers[0]!.name;
  const picked = await pickItem(
    "Send to nearby device",
    peers.map((p) => ({
      id: p.fingerprint,
      label: p.name,
      detail: p.trusted ? "trusted" : "needs pairing",
    })),
  );
  return picked?.label;
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}

void main();
