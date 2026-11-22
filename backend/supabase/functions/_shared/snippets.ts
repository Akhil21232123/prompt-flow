// Voice snippets, swapped for tokens before the LLM sees the text and
// expanded afterwards. Same behaviour as src-tauri/src/flow/snippets.rs.

import type { Snippet } from "./types.ts";

export interface Protected {
  text: string;
  tokens: Array<[string, string]>;
}

const token = (n: number) => `[[SNIPPET_${n}]]`;

function triggerRegex(trigger: string): RegExp | null {
  const words = trigger
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return null;
  // \b is ASCII-only in JS; use explicit letter/number boundaries.
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${words.join("[\\s,.\\-]+")}(?![\\p{L}\\p{N}_])[.!?]?`,
    "giu",
  );
}

export function protect(text: string, snippets: Snippet[]): Protected {
  const ordered = snippets
    .filter((s) => s.trigger.trim())
    .sort((a, b) => b.trigger.trim().length - a.trigger.trim().length);
  let out = text;
  const tokens: Array<[string, string]> = [];
  for (const s of ordered) {
    const re = triggerRegex(s.trigger);
    if (!re) continue;
    out = out.replace(re, () => {
      const t = token(tokens.length + 1);
      tokens.push([t, s.expansion]);
      return t;
    });
  }
  return { text: out, tokens };
}

export function expand(text: string, tokens: Array<[string, string]>): string {
  let out = text;
  for (const [t, expansion] of tokens) {
    const loose = t.replace(/^\[+|\]+$/g, "");
    if (out.includes(t)) out = out.split(t).join(expansion);
    else if (out.includes(`[${loose}]`)) out = out.split(`[${loose}]`).join(expansion);
    else if (out.includes(loose)) out = out.split(loose).join(expansion);
    else out = (out && !/\s$/.test(out) ? out + " " : out) + expansion;
  }
  return out;
}

export function apply(text: string, snippets: Snippet[]): string {
  const p = protect(text, snippets);
  return expand(p.text, p.tokens);
}
