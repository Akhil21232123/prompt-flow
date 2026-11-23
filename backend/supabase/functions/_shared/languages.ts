// Spoken and written languages: the codes clients send, what Whisper
// reports back, and which language a rewrite should be written in.

/** Languages the apps offer, by ISO 639-1 code (what Whisper accepts). */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  hi: "Hindi",
  te: "Telugu",
  ta: "Tamil",
  kn: "Kannada",
  ml: "Malayalam",
  mr: "Marathi",
  bn: "Bengali",
  gu: "Gujarati",
  pa: "Punjabi",
  ur: "Urdu",
  or: "Odia",
  as: "Assamese",
  ne: "Nepali",
  sa: "Sanskrit",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ru: "Russian",
  ar: "Arabic",
  tr: "Turkish",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  id: "Indonesian",
  vi: "Vietnamese",
  th: "Thai",
  pl: "Polish",
  uk: "Ukrainian",
};

const BY_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(LANGUAGE_NAMES).map(([code, name]) => [
    name.toLowerCase(),
    code,
  ]),
);
// Other spellings Whisper or clients use.
Object.assign(BY_NAME, {
  bangla: "bn",
  oriya: "or",
  panjabi: "pa",
  mandarin: "zh",
  castilian: "es",
  flemish: "nl",
});

/**
 * A language code Whisper accepts, or undefined for "detect it" ("auto",
 * empty or unknown). Accepts "hi", "hi-IN", "hi_IN" and "Hindi".
 */
export function sttLanguage(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().toLowerCase();
  if (!t || t === "auto") return undefined;
  const code = t.split(/[-_]/)[0];
  if (code in LANGUAGE_NAMES) return code;
  return BY_NAME[t];
}

/** Whisper's verbose output names the language ("hindi"); turn it into a code. */
export function languageCode(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().toLowerCase();
  if (!t) return undefined;
  if (t in LANGUAGE_NAMES) return t;
  if (BY_NAME[t]) return BY_NAME[t];
  const code = t.split(/[-_]/)[0];
  return code in LANGUAGE_NAMES ? code : undefined;
}

/** Unicode script ranges, for guessing the language of text with no label. */
const SCRIPTS: Array<[RegExp, string]> = [
  [/[ఀ-౿]/, "te"],
  [/[஀-௿]/, "ta"],
  [/[ಀ-೿]/, "kn"],
  [/[ഀ-ൿ]/, "ml"],
  [/[ঀ-৿]/, "bn"],
  [/[઀-૿]/, "gu"],
  [/[਀-੿]/, "pa"],
  [/[଀-୿]/, "or"],
  [/[ऀ-ॿ]/, "hi"],
  [/[؀-ۿ]/, "ur"],
];

export function guessLanguageFromScript(text: string): string | undefined {
  for (const [re, code] of SCRIPTS) if (re.test(text)) return code;
  return undefined;
}

/** True when the text has letters outside the Latin alphabet. */
export function hasNonLatinLetters(text: string): boolean {
  return /[^\p{Script=Latin}\P{L}]/u.test(text);
}

export type OutputLanguage = "en" | "same";

export function parseOutputLanguage(raw: unknown): OutputLanguage | undefined {
  if (raw === "en" || raw === "same") return raw;
  if (typeof raw === "string" && raw.toLowerCase().startsWith("en"))
    return "en";
  return undefined;
}

/**
 * Whether the text has to be translated into English: the output should be
 * English and the speaker used another language.
 */
export function needsEnglish(
  output: OutputLanguage,
  spoken: string | undefined,
  text: string,
): boolean {
  if (output !== "en") return false;
  if (spoken && spoken !== "en") return true;
  return hasNonLatinLetters(text);
}

export function languageName(code: string | undefined): string {
  return (code && LANGUAGE_NAMES[code]) || "another language";
}
