// Names speech-to-text reliably mishears, fixed before any model sees them.
//
// Only spellings that can't mean anything else are here ("FNN", "whisperflow",
// "chat GBT"). Ambiguous words ("cloud" could be Claude or iCloud) are left to
// the model, which gets KNOWN_NAMES as a spelling list and is told never to
// insert a name that wasn't said.

/** Spellings for the model: fix a near-miss to these, never add one. */
export const KNOWN_NAMES = [
  "PromptFlow",
  "Wispr Flow",
  "Claude",
  "Claude Code",
  "ChatGPT",
  "Gemini",
  "Perplexity",
  "Cursor",
  "GitHub",
  "Fn key",
];

const FIXES: Array<[RegExp, string]> = [
  // Wispr Flow: "whisperflow", "whisper flow", "wisper flow", "whispr flow"
  [/\b(?:whisper|wisper|whispr|wispr)[\s-]?flow\b/gi, "Wispr Flow"],
  // PromptFlow: "prompt flow", "prom flow", "promflow", "promt flow", "comflow"
  [/\b(?:prompt|prom|promt|comp?)[\s-]?flow\b/gi, "PromptFlow"],
  // The Fn key: "FNN", "F N N", "FN key", "F N key", "fn key"
  [/\bF\s?N\s?N\b/g, "Fn"],
  [/\b(?:F\s?N|fn)(?=\s+(?:key|button)s?\b)/gi, "Fn"],
  [
    /\b(holding|hold|press|pressing|tap|tapping)\s+(the\s+)?(?:F\s?N|fn)\b/gi,
    "$1 $2Fn",
  ],
  // ChatGPT: "chat GPT", "chat GBT", "chatgbt", "chat g p t"
  [/\bchat\s?g\s?[pb]\s?t\b/gi, "ChatGPT"],
  // Claude Code: "cloud code", "clawed code"
  [/\b(?:cloud|clawed|claud)\s+code\b/gi, "Claude Code"],
  // GitHub: "git hub"
  [/\bgit\s+hub\b/gi, "GitHub"],
];

/** The transcript with known mishearings of product names fixed. */
export function fixKnownNames(text: string): string {
  let out = text;
  for (const [re, to] of FIXES) out = out.replace(re, to);
  return out;
}

/**
 * Names on screen right now (the window title, the text around the cursor):
 * capitalised words and words with inner capitals or digits, which speech
 * recognition spells best when it's told about them. At most `max`.
 */
export function namesOnScreen(
  texts: Array<string | undefined>,
  max = 12,
): string[] {
  const seen = new Map<string, string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t
      .slice(0, 4000)
      .matchAll(
        /(?<![\p{L}\p{N}])([\p{Lu}][\p{L}\p{N}'’-]{2,}|[\p{L}]+[\p{Lu}\p{N}][\p{L}\p{N}]*)(?![\p{L}\p{N}])/gu,
      )) {
      const w = m[1];
      if (COMMON.has(w.toLowerCase())) continue;
      const key = w.toLowerCase();
      if (!seen.has(key)) seen.set(key, w);
      if (seen.size >= max) return [...seen.values()];
    }
  }
  return [...seen.values()];
}

/** Capitalised only because they start a sentence or a title. */
const COMMON = new Set(
  "the this that these those and but for with from your you our their his her its are was were have has had will would can could should hello dear thanks thank regards best hi hey new inbox re fwd draft untitled document window file edit view help home page".split(
    " ",
  ),
);
