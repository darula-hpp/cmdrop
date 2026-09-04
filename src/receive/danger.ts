import type { DangerWarning } from "../protocol/types.js";

const RULES: { id: string; re: RegExp; message: string }[] = [
  {
    id: "pipe-shell",
    re: /(curl|wget)\b[\s\S]{0,200}\|\s*(ba)?sh\b/i,
    message: "Downloads a script and pipes it to a shell.",
  },
  {
    id: "rm-rf",
    re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-rf|-fr)\b/,
    message: "Recursive force-delete.",
  },
  {
    id: "sudo",
    re: /(^|[;&|]\s*)sudo\b/,
    message: "Requests elevated privileges.",
  },
  {
    id: "eval",
    re: /\beval\s+/,
    message: "Evaluates a string as code.",
  },
  {
    id: "fork-bomb",
    re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;?/,
    message: "Looks like a fork bomb.",
  },
  {
    id: "token",
    re: /\b(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
    message: "May contain an API token or secret.",
  },
];

export function warnDangerous(command: string): DangerWarning[] {
  return RULES.filter((r) => r.re.test(command)).map((r) => ({ id: r.id, message: r.message }));
}
