import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentShell } from "../platform/index.js";

export interface HistoryEntry {
  command: string;
  timestamp?: number;
}

const MAX_ENTRIES = 400;

export async function readShellHistory(shell = currentShell()): Promise<HistoryEntry[]> {
  if (shell === "zsh") return readZshHistory();
  if (shell === "fish") return readFishHistory();
  return readBashHistory();
}

async function readZshHistory(): Promise<HistoryEntry[]> {
  const file = process.env.HISTFILE || path.join(os.homedir(), ".zsh_history");
  const raw = await readMaybe(file);
  const entries: HistoryEntry[] = [];
    const re = /: (\d+):\d+;(.*)$/;
  let pending = "";
  for (const line of raw.split("\n")) {
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1)}\n`;
      continue;
    }
    const full = pending + line;
    pending = "";
    const m = re.exec(full);
    if (m) {
      entries.push({ timestamp: Number(m[1]), command: unescapeZsh(m[2] ?? "") });
    } else if (full.trim()) {
      entries.push({ command: full });
    }
  }
  return uniqueRecent(entries);
}

function unescapeZsh(command: string): string {
  return command.replace(/\\\\/g, "\\");
}

async function readBashHistory(): Promise<HistoryEntry[]> {
  const file = process.env.HISTFILE || path.join(os.homedir(), ".bash_history");
  const raw = await readMaybe(file);
  const entries: HistoryEntry[] = [];
  let ts: number | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("#") && /^\d+$/.test(line.slice(1))) {
      ts = Number(line.slice(1));
      continue;
    }
    if (line.trim()) {
      entries.push({ command: line, timestamp: ts });
      ts = undefined;
    }
  }
  return uniqueRecent(entries);
}

async function readFishHistory(): Promise<HistoryEntry[]> {
  const file =
    process.env.fish_history ||
    path.join(os.homedir(), ".local", "share", "fish", "fish_history");
  const raw = await readMaybe(file);
  const entries: HistoryEntry[] = [];
  let current: HistoryEntry | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("- cmd:")) {
      if (current?.command) entries.push(current);
      current = { command: line.slice("- cmd:".length).trim() };
    } else if (line.trim().startsWith("when:") && current) {
      current.timestamp = Number(line.split(":")[1]?.trim());
    }
  }
  if (current?.command) entries.push(current);
  return uniqueRecent(entries);
}

function uniqueRecent(entries: HistoryEntry[]): HistoryEntry[] {
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const cmd = entries[i]!.command.trim();
    if (!cmd || seen.has(cmd)) continue;
    seen.add(cmd);
    out.push({ command: cmd, timestamp: entries[i]!.timestamp });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

async function readMaybe(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

export function lastCommand(entries: HistoryEntry[]): string | undefined {
  return entries[0]?.command;
}

export function filterHistory(entries: HistoryEntry[], query: string): HistoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries
    .map((e) => ({ e, score: score(e.command, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e);
}

function score(command: string, query: string): number {
  const c = command.toLowerCase();
  if (c === query) return 1000;
  if (c.startsWith(query)) return 500 + (100 - Math.min(query.length, 100));
  if (c.includes(query)) return 200;
  let qi = 0;
  for (const ch of c) {
    if (ch === query[qi]) qi += 1;
    if (qi >= query.length) return 50;
  }
  return 0;
}
