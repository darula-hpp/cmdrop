import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { insertPath } from "../paths.js";
import { currentShell } from "../platform/index.js";

const MARKER_BEGIN = "# >>> cmdrop hook >>>";
const MARKER_END = "# <<< cmdrop hook <<<";

function zshHook(insertFile: string): string {
  return `${MARKER_BEGIN}
# Inserts a received command into the next prompt (never auto-runs).
_cmdrop_insert_precmd() {
  local f=${JSON.stringify(insertFile)}
  if [[ -f "$f" ]]; then
    local cmd
    cmd=$(<"$f")
    rm -f "$f"
    print -z -- "$cmd"
  fi
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd _cmdrop_insert_precmd
${MARKER_END}
`;
}

function bashHook(insertFile: string): string {
  return `${MARKER_BEGIN}
_cmdrop_insert_prompt() {
  local f=${JSON.stringify(insertFile)}
  if [[ -f "$f" ]]; then
    local cmd
    cmd=$(<"$f")
    rm -f "$f"
    READLINE_LINE="$cmd"
    READLINE_POINT=\${#cmd}
  fi
}
if [[ $- == *i* ]]; then
  bind -x '"\\C-x\\C-i": _cmdrop_insert_prompt'
  PROMPT_COMMAND="_cmdrop_insert_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
${MARKER_END}
`;
}

function fishHook(insertFile: string): string {
  return `${MARKER_BEGIN}
function _cmdrop_insert --on-event fish_prompt
  set -l f ${JSON.stringify(insertFile)}
  if test -f $f
    set -l cmd (cat $f)
    rm -f $f
    commandline -r -- $cmd
  end
end
${MARKER_END}
`;
}

function rcPath(shell: string): string | undefined {
  const home = os.homedir();
  if (shell === "zsh") return path.join(home, ".zshrc");
  if (shell === "bash") return path.join(home, ".bashrc");
  if (shell === "fish") return path.join(home, ".config", "fish", "config.fish");
  return undefined;
}

function hookFor(shell: string, insertFile: string): string | undefined {
  if (shell === "zsh") return zshHook(insertFile);
  if (shell === "bash") return bashHook(insertFile);
  if (shell === "fish") return fishHook(insertFile);
  return undefined;
}

export async function installShellHook(shell = currentShell()): Promise<string> {
  const dest = rcPath(shell);
  const hook = hookFor(shell, insertPath());
  if (!dest || !hook) {
    throw new Error(`No insert hook for shell "${shell}". Supported: zsh, bash, fish.`);
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  let existing = "";
  try {
    existing = await fs.readFile(dest, "utf8");
  } catch {
    existing = "";
  }
  if (existing.includes(MARKER_BEGIN)) {
    const next = existing.replace(
      new RegExp(`${MARKER_BEGIN}[\\s\\S]*?${MARKER_END}\\n?`),
      hook.endsWith("\n") ? hook : `${hook}\n`,
    );
    await fs.writeFile(dest, next);
    return `Updated cmdrop hook in ${dest}`;
  }
  const prefix = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
  await fs.writeFile(dest, `${existing}${prefix}\n${hook}`);
  return `Installed cmdrop hook in ${dest}. Restart your shell to enable insert.`;
}

export { MARKER_BEGIN, MARKER_END };
