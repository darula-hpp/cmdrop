# cmdrop

AirDrop for shell commands. Send a command to a nearby Mac or Linux machine on the same LAN. Commands never auto-run.

## Install

Requires **Node.js 20+**.

```bash
npm install -g cmdrop
cmdrop init
```

On Ubuntu, Avahi is recommended (UDP fallback works without it):

```bash
sudo apt install avahi-daemon
```

If `ufw` is active, allow the daemon port when peers cannot see each other:

```bash
sudo ufw allow 45454/tcp && sudo ufw allow 45455/udp
```

## Pair two machines

Do this on **each** computer (same Wi‑Fi / LAN):

```bash
npm install -g cmdrop
cmdrop init
cmdrop peers
```

`peers` should list this device and the other machine. The first drop between two devices shows a **6-digit pairing code** on both sides — confirm it matches. After that, the devices stay trusted until you `cmdrop unpair`.

## Use

```bash
# pick a command from history, then pick a nearby device
cmdrop send

# send an explicit command
cmdrop send -- 'docker compose up -d'
cmdrop send --last --to OtherLaptop

# on the receiving machine: preview, then copy / insert / run
cmdrop inbox
```

**Run** always asks you to type `run`. Nothing executes silently.

```bash
cmdrop status          # identity + daemon
cmdrop history         # browse history without sending
cmdrop unpair NAME     # forget a device
cmdrop restart         # reload the user daemon
cmdrop init --shell    # optional: insert into the next prompt
```

## How it works

cmdrop runs a small user daemon (launchd on macOS, systemd --user on Linux). It finds peers with mDNS (Bonjour / Avahi) and a UDP fallback, then sends the command over TLS. There is no account and no cloud.

## Requirements

- macOS, Linux, or Ubuntu
- Node.js 20 or newer
- Same local network

Windows is not supported.
