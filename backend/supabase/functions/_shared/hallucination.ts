// Whisper-family models fill silence with stock phrases learned from video
// subtitles. A short clip whose whole transcript is one of these is dropped
// instead of pasted.

const STOCK = new Set([
  "thank you",
  "thank you very much",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching and see you next time",
  "please subscribe",
  "subscribe",
  "like and subscribe",
  "bye",
  "bye bye",
  "you",
  "okay",
  "so",
  "uh",
  "um",
  "hmm",
  "music",
  "applause",
  "silence",
  "the end",
  "subtitles by the amara org community",
]);

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\[\]()♪*.,!?'"…-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a transcript is probably invented from silence: empty, or a
 * stock phrase from a clip too short to have said it deliberately.
 */
export function isLikelyHallucination(
  text: string,
  durationSec: number | undefined,
): boolean {
  const norm = normalizeForMatch(text);
  if (!norm) return true;
  if (!STOCK.has(norm)) return false;
  // A deliberate "thank you" is fine when the clip is long enough to carry
  // speech around it; with no duration, be conservative and keep it.
  return durationSec !== undefined && durationSec < 2.5;
}

/**
 * True when a short transcript only repeats words from the vocabulary hint.
 * Whisper given "PromptFlow, Wispr Flow" as a hint and no speech will often
 * answer "Wispr" or "PromptFlow".
 */
export function isPromptEcho(
  text: string,
  prompt: string | undefined,
): boolean {
  if (!prompt) return false;
  const words = normalizeForMatch(text).split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  const hint = new Set(normalizeForMatch(prompt.replace(/,/g, " ")).split(" "));
  return words.every((w) => hint.has(w));
}
