import React, { useMemo, useState } from "react";
import { Box, render, Text, useInput } from "ink";

export interface PickItem {
  id: string;
  label: string;
  detail?: string;
}

interface FuzzyPickProps {
  title: string;
  items: PickItem[];
  onSelect: (item: PickItem | undefined) => void;
}

function score(label: string, query: string): number {
  const c = label.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;
  if (c === q) return 1000;
  if (c.startsWith(q)) return 500;
  if (c.includes(q)) return 200;
  let qi = 0;
  for (const ch of c) {
    if (ch === q[qi]) qi += 1;
    if (qi >= q.length) return 50;
  }
  return 0;
}

function FuzzyPick({ title, items, onSelect }: FuzzyPickProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const filtered = useMemo(() => {
    const ranked = items
      .map((item) => ({ item, s: score(`${item.label} ${item.detail ?? ""}`, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.item);
    return ranked;
  }, [items, query]);
  const clamped = Math.min(index, Math.max(filtered.length - 1, 0));
  const window = filtered.slice(0, 12);

  useInput((input, key) => {
    if (key.escape) {
      onSelect(undefined);
      return;
    }
    if (key.return) {
      onSelect(filtered[clamped]);
      return;
    }
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setIndex(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
      setIndex(0);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>
        Filter: {query || "(type to search)"} · ↑↓ select · enter confirm · esc cancel
      </Text>
      {window.length === 0 ? (
        <Text color="yellow">No matches</Text>
      ) : (
        window.map((item, i) => {
          const active = i === clamped;
          return (
            <Box key={item.id}>
              <Text color={active ? "cyan" : undefined} inverse={active}>
                {active ? "› " : "  "}
                {item.label}
                {item.detail ? `  ${item.detail}` : ""}
              </Text>
            </Box>
          );
        })
      )}
    </Box>
  );
}

export async function pickItem(title: string, items: PickItem[]): Promise<PickItem | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return items[0];
  }
  return new Promise((resolve) => {
    const instance = render(
      <FuzzyPick
        title={title}
        items={items}
        onSelect={(item) => {
          instance.unmount();
          resolve(item);
        }}
      />,
    );
  });
}
