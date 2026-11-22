// The fidelity guard: deterministic checks that a rewrite didn't invent
// facts. In the first live test a small model added "99% accurate", "10%",
// "95%+" and "1-2 pages" to a prompt the user never said; this catches that
// class of error without trusting another model.
//
// Checked: numbers (incl. percentages), URLs, emails, @handles and file
// names. Every one in the output must be traceable to the transcript or to
// trusted context (dictionary, snippets, app, selection, standing context).

const SMALL: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10,
};
const SCALES: Record<string, number> = {
  hundred: 100, thousand: 1_000, lakh: 100_000, million: 1_000_000,
  crore: 10_000_000, billion: 1_000_000_000,
};
const ALSO: Record<string, number[]> = {
  half: [0.5, 50], quarter: [0.25, 25], couple: [2], dozen: [12], pair: [2],
  double: [2], twice: [2], triple: [3], single: [1], once: [1],
};

function normalizeNumber(raw: string): string | undefined {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : undefined;
}

/** Every number a transcript mentions, in digits or words. */
export function spokenNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = normalizeNumber(m[0]);
    if (n) out.add(n);
    // "5:30", "1-2" and "3/4" split into their parts
    for (const part of m[0].split(/[.,]/)) {
      const p = normalizeNumber(part);
      if (p) out.add(p);
    }
  }
  const words = text.toLowerCase().replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  let current = 0;
  let total = 0;
  let inNumber = false;
  const flush = () => {
    if (inNumber) out.add(String(total + current));
    current = 0;
    total = 0;
    inNumber = false;
  };
  for (const w of words) {
    if (w in SMALL) {
      out.add(String(SMALL[w]));
      // "five thirty" is two numbers, "thirty five" is one.
      if (inNumber && current % 10 === 0 && current >= 20 && SMALL[w] < 10) current += SMALL[w];
      else if (inNumber && current > 0 && current < 100 && SMALL[w] >= 0) {
        flush();
        current = SMALL[w];
      } else current += SMALL[w];
      inNumber = true;
    } else if (w in SCALES && inNumber) {
      const scale = SCALES[w];
      if (scale === 100) current = (current || 1) * 100;
      else {
        total += (current || 1) * scale;
        current = 0;
      }
    } else if (w === "and" && inNumber) {
      continue;
    } else {
      flush();
      if (w in ORDINALS) out.add(String(ORDINALS[w]));
      if (w in ALSO) for (const v of ALSO[w]) out.add(String(v));
    }
  }
  flush();
  return out;
}

/** List markers ("1.", "2)") at line starts are formatting, not facts. */
function stripListMarkers(text: string): string {
  return text.replace(/^(\s*)\d+[.)](?=\s)/gm, "$1");
}

export interface Facts {
  numbers: string[];
  urls: string[];
  emails: string[];
  handles: string[];
  files: string[];
}

const URL_RE = /\bhttps?:\/\/[^\s<>()"']+|\bwww\.[^\s<>()"']+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const HANDLE_RE = /(?<![\w@])@[A-Za-z][\w.-]{1,}/g;
const FILE_RE = /\b[\w-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|swift|rb|php|css|html|json|yaml|yml|toml|md|sql|sh|c|cpp|h)\b/gi;

export function extractFacts(text: string): Facts {
  const body = stripListMarkers(text);
  const emails = [...body.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase());
  const urls = [...body.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:!?]+$/, "").toLowerCase());
  const noLinks = body.replace(URL_RE, " ").replace(EMAIL_RE, " ");
  const handles = [...noLinks.matchAll(HANDLE_RE)].map((m) => m[0].slice(1).toLowerCase());
  const files = [...noLinks.matchAll(FILE_RE)].map((m) => m[0].toLowerCase());
  const numbers = [...noLinks.replace(FILE_RE, " ").matchAll(/\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => normalizeNumber(m[0]))
    .filter((n): n is string => n !== undefined);
  return { numbers, urls, emails, handles, files };
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Facts in `output` that can't be traced to `source` (the transcript plus any
 * trusted context). Empty means the rewrite is safe to paste.
 */
export function findInventions(source: string, rawOutput: string): string[] {
  // Snippet tokens stand for the user's own saved text.
  const output = rawOutput.replace(/\[\[SNIPPET_\d+\]\]/g, " ");
  const allowedNumbers = spokenNumbers(source);
  const sourceSquashed = squash(source);
  const sourceLower = source.toLowerCase();
  const facts = extractFacts(output);
  const problems: string[] = [];

  for (const n of new Set(facts.numbers)) {
    if (allowedNumbers.has(n)) continue;
    // "2026" spoken as "twenty twenty six"
    if (/^\d{4}$/.test(n) && allowedNumbers.has(n.slice(0, 2)) && allowedNumbers.has(String(Number(n.slice(2))))) continue;
    // "1,500" spoken as "fifteen hundred"
    if (Number(n) % 100 === 0 && allowedNumbers.has(String(Number(n) / 100))) continue;
    problems.push(`number ${n}`);
  }
  // Spoken links come out as words ("john at gmail dot com"), so compare
  // with everything but letters and digits removed.
  for (const e of new Set(facts.emails)) {
    const spoken = [e, e.replace("@", "at"), e.replace("@", "at").replace(/\./g, "dot")].map(squash);
    if (!spoken.some((v) => sourceSquashed.includes(v))) problems.push(`email ${e}`);
  }
  for (const u of new Set(facts.urls)) {
    const core = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
    if (!sourceSquashed.includes(squash(core)) && !sourceSquashed.includes(squash(core.replace(/\./g, "dot")))) {
      problems.push(`link ${u}`);
    }
  }
  for (const h of new Set(facts.handles)) {
    if (!sourceLower.includes(h) && !sourceSquashed.includes(squash(h))) problems.push(`mention @${h}`);
  }
  for (const f of new Set(facts.files)) {
    const stem = f.replace(/\.[^.]+$/, "");
    if (!sourceSquashed.includes(squash(f)) && !sourceSquashed.includes(squash(f.replace(".", "dot"))) && !sourceSquashed.includes(squash(stem))) {
      problems.push(`file ${f}`);
    }
  }
  return problems;
}
