// The fidelity guard: deterministic checks that a rewrite didn't invent
// facts. In the first live test a small model added "99% accurate", "10%",
// "95%+" and "1-2 pages" to a prompt the user never said; this catches that
// class of error without trusting another model.
//
// Checked: numbers (incl. percentages), URLs, emails, @handles and file
// names. Every one in the output must be traceable to the transcript or to
// trusted context (dictionary, snippets, app, selection, standing context).

const SMALL: Record<string, number> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};
const SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1_000,
  lakh: 100_000,
  million: 1_000_000,
  crore: 10_000_000,
  billion: 1_000_000_000,
};
const ALSO: Record<string, number[]> = {
  half: [0.5, 50],
  quarter: [0.25, 25],
  couple: [2],
  dozen: [12],
  pair: [2],
  double: [2],
  twice: [2],
  triple: [3],
  single: [1],
  once: [1],
};

// Number words in the Indian languages PromptFlow transcribes, so a prompt
// translated into English may write "5" for "पांच" or "ఐదు". Best effort:
// the common words, not every compound.
const INDIC: Record<string, number> = {
  // Hindi / Marathi (Devanagari)
  शून्य: 0,
  एक: 1,
  दो: 2,
  तीन: 3,
  चार: 4,
  पांच: 5,
  पाँच: 5,
  पाच: 5,
  छह: 6,
  छः: 6,
  छे: 6,
  सहा: 6,
  सात: 7,
  आठ: 8,
  नौ: 9,
  नऊ: 9,
  दस: 10,
  दहा: 10,
  ग्यारह: 11,
  बारह: 12,
  तेरह: 13,
  चौदह: 14,
  पंद्रह: 15,
  पन्द्रह: 15,
  सोलह: 16,
  सत्रह: 17,
  अठारह: 18,
  उन्नीस: 19,
  बीस: 20,
  पच्चीस: 25,
  तीस: 30,
  चालीस: 40,
  पचास: 50,
  साठ: 60,
  सत्तर: 70,
  अस्सी: 80,
  नब्बे: 90,
  सौ: 100,
  शंभर: 100,
  हज़ार: 1000,
  हजार: 1000,
  लाख: 100000,
  करोड़: 10000000,
  करोड: 10000000,
  आधा: 0.5,
  डेढ़: 1.5,
  ढाई: 2.5,
  दर्जन: 12,
  पहला: 1,
  पहली: 1,
  दूसरा: 2,
  दूसरी: 2,
  तीसरा: 3,
  तीसरी: 3,
  चौथा: 4,
  // Telugu
  సున్నా: 0,
  ఒకటి: 1,
  ఒక: 1,
  రెండు: 2,
  మూడు: 3,
  నాలుగు: 4,
  ఐదు: 5,
  ఆరు: 6,
  ఏడు: 7,
  ఎనిమిది: 8,
  తొమ్మిది: 9,
  పది: 10,
  ఇరవై: 20,
  ముప్పై: 30,
  నలభై: 40,
  యాభై: 50,
  వంద: 100,
  వందల: 100,
  వెయ్యి: 1000,
  వేల: 1000,
  లక్ష: 100000,
  కోటి: 10000000,
  // Tamil
  ஒன்று: 1,
  ஒரு: 1,
  இரண்டு: 2,
  மூன்று: 3,
  நான்கு: 4,
  ஐந்து: 5,
  ஆறு: 6,
  ஏழு: 7,
  எட்டு: 8,
  ஒன்பது: 9,
  பத்து: 10,
  இருபது: 20,
  நூறு: 100,
  ஆயிரம்: 1000,
  லட்சம்: 100000,
  கோடி: 10000000,
  // Kannada
  ಒಂದು: 1,
  ಎರಡು: 2,
  ಮೂರು: 3,
  ನಾಲ್ಕು: 4,
  ಐದು: 5,
  ಆರು: 6,
  ಏಳು: 7,
  ಎಂಟು: 8,
  ಒಂಬತ್ತು: 9,
  ಹತ್ತು: 10,
  ಇಪ್ಪತ್ತು: 20,
  ನೂರು: 100,
  ಸಾವಿರ: 1000,
  // Malayalam
  ഒന്ന്: 1,
  ഒരു: 1,
  രണ്ട്: 2,
  മൂന്ന്: 3,
  നാല്: 4,
  അഞ്ച്: 5,
  ആറ്: 6,
  ഏഴ്: 7,
  എട്ട്: 8,
  ഒമ്പത്: 9,
  പത്ത്: 10,
  നൂറ്: 100,
  ആയിരം: 1000,
  // Bengali
  এক: 1,
  দুই: 2,
  তিন: 3,
  চার: 4,
  পাঁচ: 5,
  ছয়: 6,
  সাত: 7,
  আট: 8,
  নয়: 9,
  দশ: 10,
  বিশ: 20,
  একশো: 100,
  শো: 100,
  হাজার: 1000,
  // Gujarati
  એક: 1,
  બે: 2,
  ત્રણ: 3,
  ચાર: 4,
  પાંચ: 5,
  છ: 6,
  સાત: 7,
  આઠ: 8,
  નવ: 9,
  દસ: 10,
  વીસ: 20,
  સો: 100,
  હજાર: 1000,
  // Punjabi (Gurmukhi)
  ਇੱਕ: 1,
  ਦੋ: 2,
  ਤਿੰਨ: 3,
  ਚਾਰ: 4,
  ਪੰਜ: 5,
  ਛੇ: 6,
  ਸੱਤ: 7,
  ਅੱਠ: 8,
  ਨੌਂ: 9,
  ਦਸ: 10,
  ਵੀਹ: 20,
  ਸੌ: 100,
  ਹਜ਼ਾਰ: 1000,
  // Urdu
  ایک: 1,
  دو: 2,
  تین: 3,
  چار: 4,
  پانچ: 5,
  چھ: 6,
  سات: 7,
  آٹھ: 8,
  نو: 9,
  دس: 10,
  بیس: 20,
  سو: 100,
  ہزار: 1000,
  لاکھ: 100000,
};
const INDIC_SCALES = new Set([100, 1000, 100000, 10000000]);
// Dravidian languages add suffixes ("ఐదుగురు", five people), so longer
// words also match as prefixes.
const INDIC_PREFIXES = Object.entries(INDIC).filter(([w]) => w.length >= 3);

function indicValue(word: string): number | undefined {
  if (word in INDIC) return INDIC[word];
  for (const [w, v] of INDIC_PREFIXES) if (word.startsWith(w)) return v;
  return undefined;
}

/** Any script's decimal digits (०-९, ౦-౯, ٠-٩…) as ASCII digits. */
export function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (d) => {
    const code = d.codePointAt(0)!;
    // Unicode decimal digits come in runs of ten starting at a zero.
    for (let zero = code; zero > code - 10; zero--) {
      if (!/\p{Nd}/u.test(String.fromCodePoint(zero - 1)))
        return String(code - zero);
    }
    return d;
  });
}

function addIndicNumbers(text: string, out: Set<string>) {
  const words = text.match(/[\p{L}\p{M}]+/gu) ?? [];
  for (let i = 0; i < words.length; i++) {
    const v = indicValue(words[i]);
    if (v === undefined) continue;
    out.add(String(v));
    const next = i + 1 < words.length ? indicValue(words[i + 1]) : undefined;
    if (next !== undefined && INDIC_SCALES.has(next) && next > v)
      out.add(String(v * next));
  }
}

function normalizeNumber(raw: string): string | undefined {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : undefined;
}

/** Every number a transcript mentions, in digits or words. */
export function spokenNumbers(rawText: string): Set<string> {
  const out = new Set<string>();
  const text = asciiDigits(rawText);
  if (/[^\p{Script=Latin}\P{L}]/u.test(text)) addIndicNumbers(text, out);
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = normalizeNumber(m[0]);
    if (n) out.add(n);
    // "5:30", "1-2" and "3/4" split into their parts
    for (const part of m[0].split(/[.,]/)) {
      const p = normalizeNumber(part);
      if (p) out.add(p);
    }
  }
  // Punctuation ends a spoken number: "fifteen hundred, two thousand".
  const words = text
    .toLowerCase()
    .replace(/[.,;:!?]+(\s|$)/g, " | ")
    .replace(/[^a-z\s|-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
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
      if (inNumber && current % 10 === 0 && current >= 20 && SMALL[w] < 10)
        current += SMALL[w];
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

const small = (n: string) => Number(n) >= 1 && Number(n) <= 10;

// Words that make a small number a label for a part of the answer, not a fact.
const STRUCTURE_WORDS =
  "step|steps|section|sections|part|parts|phase|phases|stage|stages|option|options|item|items|point|points|question|questions|task|tasks|example|examples|tip|tips|rule|rules|idea|ideas|approach|approaches|bullet|bullets|paragraph|paragraphs|heading|headings|draft|drafts|version|variant|variants|alternative|alternatives|reason|reasons|priority|scenario|scenarios|method|methods|solution|solutions|takeaway|takeaways";

/**
 * Small numbers (1–10) used to enumerate or structure the output are
 * formatting, not facts: list markers anywhere on a line ("1.", "2)", "(3)",
 * "#4", "**5.**", "[6]"), headings ("### 1. Overview") and labels such as
 * "Step 1" or "Section 6". Larger numbers always count.
 */
export function stripEnumerators(text: string): string {
  let out = text
    // "1." / "2)" at a line start, after a heading mark or bullet
    .replace(
      /^(\s*(?:#{1,6}\s*|[-*•]\s+)?)\(?(\d{1,2})[.):](?=\s|\*|$)/gm,
      (m, pre, n) => (small(n) ? pre : m),
    )
    // "(1)", "[2]", "#3", "**4.**", "**5**"
    .replace(
      /\((\d{1,2})\)|\[(\d{1,2})\]|(?<![\w&])#(\d{1,2})\b|\*\*(\d{1,2})[.)]?\*\*/g,
      (m, a, b, c, d) => (small(a ?? b ?? c ?? d) ? " " : m),
    )
    // "Step 1", "Section 6", "option 2:"
    .replace(
      new RegExp(`\\b(${STRUCTURE_WORDS})\\s+(\\d{1,2})\\b`, "gi"),
      (m, word, n) => (small(n) ? word : m),
    )
    // "Step one" is already words; also "1st", "2nd" as ordinals of parts
    .replace(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, (m, n) => (small(n) ? " " : m));
  // Mid-line markers ("two sections: 1. Brief answer 2. Detail"): after a
  // colon, semicolon or bracket, before emphasis, or as a run starting at 1.
  const midline = /(^|[\s:;(])(\d{1,2})[.)](?=\s)/g;
  const values = new Set<number>();
  for (const m of out.matchAll(midline)) values.add(Number(m[2]));
  const run = values.has(1) && values.has(2);
  out = out.replace(midline, (m, pre, n, offset: number, whole: string) => {
    if (!small(n)) return m;
    const before = whole.slice(0, offset + pre.length).trimEnd();
    if (run || /[:;(]$/.test(before)) return pre;
    return m;
  });
  out = out.replace(/(\d{1,2})[.)](?=\s*[*_`])/g, (m, n) =>
    small(n) ? " " : m,
  );
  return out;
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
const FILE_RE =
  /\b[\w-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|swift|rb|php|css|html|json|yaml|yml|toml|md|sql|sh|c|cpp|h)\b/gi;

export function extractFacts(text: string): Facts {
  const body = stripEnumerators(text);
  const emails = [...body.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase());
  const urls = [...body.matchAll(URL_RE)].map((m) =>
    m[0].replace(/[.,;:!?]+$/, "").toLowerCase(),
  );
  const noLinks = body.replace(URL_RE, " ").replace(EMAIL_RE, " ");
  const handles = [...noLinks.matchAll(HANDLE_RE)].map((m) =>
    m[0].slice(1).toLowerCase(),
  );
  const files = [...noLinks.matchAll(FILE_RE)].map((m) => m[0].toLowerCase());
  const numbers = [
    ...noLinks.replace(FILE_RE, " ").matchAll(/\d[\d,]*(?:\.\d+)?/g),
  ]
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
    if (
      /^\d{4}$/.test(n) &&
      allowedNumbers.has(n.slice(0, 2)) &&
      allowedNumbers.has(String(Number(n.slice(2))))
    )
      continue;
    // "1,500" spoken as "fifteen hundred"
    if (Number(n) % 100 === 0 && allowedNumbers.has(String(Number(n) / 100)))
      continue;
    problems.push(`number ${n}`);
  }
  // Spoken links come out as words ("john at gmail dot com"), so compare
  // with everything but letters and digits removed.
  for (const e of new Set(facts.emails)) {
    const spoken = [
      e,
      e.replace("@", "at"),
      e.replace("@", "at").replace(/\./g, "dot"),
    ].map(squash);
    if (!spoken.some((v) => sourceSquashed.includes(v)))
      problems.push(`email ${e}`);
  }
  for (const u of new Set(facts.urls)) {
    const core = u.replace(/^https?:\/\//, "").replace(/^www\./, "");
    if (
      !sourceSquashed.includes(squash(core)) &&
      !sourceSquashed.includes(squash(core.replace(/\./g, "dot")))
    ) {
      problems.push(`link ${u}`);
    }
  }
  for (const h of new Set(facts.handles)) {
    if (!sourceLower.includes(h) && !sourceSquashed.includes(squash(h)))
      problems.push(`mention @${h}`);
  }
  for (const f of new Set(facts.files)) {
    const stem = f.replace(/\.[^.]+$/, "");
    if (
      !sourceSquashed.includes(squash(f)) &&
      !sourceSquashed.includes(squash(f.replace(".", "dot"))) &&
      !sourceSquashed.includes(squash(stem))
    ) {
      problems.push(`file ${f}`);
    }
  }
  return problems;
}
