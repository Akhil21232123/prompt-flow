// Tolerant JSON parsing for model replies, which may wrap the object in
// prose, code fences or <think> blocks, or leave a trailing comma.

function stripWrappers(reply: string): string {
  return reply
    .replace(/<think>[\s\S]*?(<\/think>|$)/g, "")
    .replace(/```(?:json)?/gi, "")
    .trim();
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      // Trailing commas and smart quotes are the usual small-model slips.
      return JSON.parse(
        text.replace(/,\s*([}\]])/g, "$1").replace(/[“”]/g, '"'),
      );
    } catch {
      return undefined;
    }
  }
}

/** The end of the balanced {...} that starts at `start`, or -1. */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The first JSON object in a model reply, or undefined. Never throws. */
export function parseJsonObject(
  reply: unknown,
): Record<string, unknown> | undefined {
  if (typeof reply !== "string") return undefined;
  const text = stripWrappers(reply);
  const whole = tryParse(text);
  if (isObject(whole)) return whole;
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) {
    const end = matchingBrace(text, i);
    const candidate = tryParse(
      end >= 0 ? text.slice(i, end + 1) : text.slice(i),
    );
    if (isObject(candidate)) return candidate;
  }
  return undefined;
}

/** Trimmed non-empty strings from an unknown value, capped in count and length. */
export function stringList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string" && typeof v !== "number") continue;
    const s = String(v).replace(/\s+/g, " ").trim();
    if (!s || s.length > maxLength || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function boolish(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string")
    return ["true", "yes", "1"].includes(value.trim().toLowerCase());
  return value === 1;
}
