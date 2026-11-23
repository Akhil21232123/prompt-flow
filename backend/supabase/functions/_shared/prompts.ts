// Builds the system/user messages for each mode. The long rule texts come
// from prompt_texts.ts (generated from the desktop Rust code); the small
// per-style and per-category pieces are kept in step by hand.

import { describeApp, supportsFileTags } from "./categories.ts";
import { languageName } from "./languages.ts";
import { memoryBlock } from "./memory.ts";
import * as T from "./prompt_texts.ts";
import { MUSIC_PLAYBOOK } from "./targets.ts";
import type {
  AppCategory,
  AppContext,
  Clarification,
  Memory,
  ScreenContext,
  EngineerSettings,
  MissingInfoPolicy,
  PromptFormat,
  PromptTarget,
  StylePreset,
  WritingStyle,
} from "./types.ts";

const STYLE_RULES: Record<WritingStyle, string> = {
  formal:
    "Tone: formal. Complete sentences, standard capitalisation and full punctuation. Expand casual contractions only where the speaker clearly sounded formal.",
  casual:
    "Tone: casual. Sentence case and normal punctuation, keep contractions and the speaker's relaxed phrasing.",
  very_casual:
    "Tone: very casual, like texting a friend. All lowercase, minimal punctuation, no full stop at the end of the last sentence. Keep slang and abbreviations the speaker used.",
};

const CATEGORY_RULES: Record<AppCategory, string> = {
  email:
    'Destination: an email. If the speaker dictates a greeting ("hi Sam") or a sign-off ("thanks, Akhil"), put the greeting on its own line followed by a blank line, and the sign-off on its own lines at the end. Use short paragraphs.',
  work_chat:
    'Destination: a work chat message (Slack, Teams). Keep it concise and skimmable; prefer short paragraphs or bullets over long blocks. Turn "at Sam" into "@Sam" when they are clearly mentioning someone.',
  personal_chat:
    "Destination: a personal chat message. Keep it short and natural; don't add a greeting or sign-off that wasn't said.",
  code: "Destination: a code editor or its AI chat panel. Technical terms, library names and identifiers must be spelled the way developers write them.",
  terminal:
    'Destination: a terminal, usually a command-line AI agent or a shell. Write commands, flags and paths exactly ("dash dash force" → "--force"). No trailing full stop after a bare command.',
  ai_chat:
    "Destination: a message to an AI assistant. Keep every requirement and detail the speaker gave, organised clearly.",
  docs: "Destination: a document or notes app. Use paragraphs, and headings only when the speaker dictates them.",
  other: "",
};

/** What each double-tap style asks for, on top of the core cleanup rules. */
export const PRESET_RULES: Record<Exclude<StylePreset, "custom">, string> = {
  clean:
    "Style: clean. Keep the speaker's own words, order and voice. Only remove fillers and false starts and fix grammar and punctuation.",
  formal:
    "Style: formal and professional. Complete sentences, full punctuation, no slang or contractions. Polite, precise wording, keeping every point the speaker made.",
  short:
    "Style: short and punchy. Lead with the point, cut every word that isn't doing work, prefer short sentences and strong verbs. Aim for about half the length or less. Keep every fact, name and number the speaker gave; never add any.",
  casual:
    "Style: casual and friendly. Relaxed, natural phrasing with contractions, like a message to a colleague you like.",
  bullets:
    "Style: a concise bulleted list. One idea per bullet, parallel phrasing, no intro sentence unless the speaker gave one.",
};

/** The rule for a preset; "custom" uses the user's saved instruction. */
export function presetRule(
  preset: StylePreset,
  custom: string | undefined,
): string {
  if (preset !== "custom") return PRESET_RULES[preset];
  const instruction = (custom ?? "").trim().slice(0, 400);
  return instruction
    ? `Style, as the user asked for it: ${instruction}. Apply it to how the text is written, never to what it says: keep every fact, name and number, and add none.`
    : PRESET_RULES.clean;
}

export interface PolishInput {
  category: AppCategory;
  style: WritingStyle;
  /** Overrides the per-app tone. */
  presetRule?: string;
  app?: AppContext;
  developerMode: boolean;
  dictionary: string[];
  hasSnippetTokens: boolean;
  /** Set when the result must be English although the speaker used another language. */
  translateFrom?: string;
}

/** Overrides the "keep their language" rules when the output must be English. */
export function englishRule(spoken: string | undefined, what: string): string {
  const from =
    spoken && spoken !== "en"
      ? ` The speaker used ${languageName(spoken)}.`
      : "";
  return `Language: write ${what} in English.${from} Translate faithfully: keep every detail, keep names, product names, code and quoted text as they are, and add nothing. This replaces any rule about keeping the speaker's language.`;
}

const isTechnical = (c: AppCategory) =>
  c === "code" || c === "terminal" || c === "ai_chat";

/** System prompt for dictation cleanup. The transcript goes in the user turn. */
export function polishSystem(p: PolishInput): string {
  const parts = [T.CORE_RULES];
  if (p.presetRule) parts.push(p.presetRule);
  else if (!isTechnical(p.category)) parts.push(STYLE_RULES[p.style]);
  if (CATEGORY_RULES[p.category]) parts.push(CATEGORY_RULES[p.category]);
  if (p.developerMode && isTechnical(p.category)) {
    parts.push(T.DEVELOPER_RULES);
    if (supportsFileTags(p.app)) parts.push(T.FILE_TAG_RULES);
  }
  const words = p.dictionary.map((w) => w.trim()).filter(Boolean);
  if (words.length) {
    parts.push(
      "The speaker's dictionary. When the transcript contains a word that sounds like or is a misspelling of one of these, use this spelling. Never insert one they didn't say:\n" +
        words.join(", "),
    );
  }
  if (p.hasSnippetTokens) {
    parts.push(
      "Tokens like [[SNIPPET_1]] stand for saved text. Keep each token exactly as written, in its place.",
    );
  }
  if (p.app) {
    parts.push(
      `App in front (use it only to spell names and terms already spoken): ${describeApp(p.app)}`,
    );
  }
  if (p.translateFrom !== undefined)
    parts.push(englishRule(p.translateFrom || undefined, "the result"));
  parts.push(
    "The user message is the transcript. Return only the cleaned text.",
  );
  return parts.join("\n\n");
}

export function polishUser(transcript: string): string {
  return `<transcript>\n${transcript}\n</transcript>`;
}

// ---------------------------------------------------------------------------
// Prompt Engineer
// ---------------------------------------------------------------------------

const MISSING_INFO: Record<MissingInfoPolicy, string> = {
  state_assumptions:
    "where something the AI needs was not said, tell it to make a sensible assumption, state it briefly, and proceed. Do not fill gaps yourself.",
  ask_first:
    "where something important was not said, tell the AI to ask the user specific clarifying questions before starting. Do not fill gaps yourself.",
};

const FORMAT_TEXT: Record<Exclude<PromptFormat, "auto">, string> = {
  xml: "Open with the task in plain sentences. Put supporting material in descriptive XML tags such as <context>, <requirements>, <constraints>, <output_format> and <success_criteria>, using only the sections this request needs. For image_generation, ignore this and write plain prose.",
  markdown:
    "Open with the task in plain sentences. Then use short Markdown sections (bold labels or ### headings, with bullets) such as Context, Requirements, Output and Done when, using only the sections this request needs. For image_generation, ignore this and write plain prose.",
  plain:
    "Plain prose paragraphs and simple numbered lists; no Markdown or XML.",
};

const CATEGORY_LABEL: Record<AppCategory, string> = {
  email: "email app",
  work_chat: "work chat",
  personal_chat: "personal chat",
  code: "code editor (the prompt is probably for its AI agent)",
  terminal:
    "terminal (the prompt is probably for a command-line coding agent such as Claude Code or Codex)",
  ai_chat: "AI chat assistant",
  docs: "documents or notes app",
  other: "unknown",
};

/** A rule added on top of the desktop prompt: the backend's guard checks it. */
const NO_NEW_NUMBERS =
  "\nNever add numbers, percentages, targets, deadlines, lengths or quantities the speaker did not say. If the task needs one, tell the AI to choose or ask.\n";

export function resolveFormat(
  setting: PromptFormat,
  app: AppContext | undefined,
  category: AppCategory,
): Exclude<PromptFormat, "auto"> {
  if (setting !== "auto") return setting;
  const hay =
    `${app?.name ?? ""} ${app?.bundle_id ?? ""} ${app?.title ?? ""}`.toLowerCase();
  if (
    hay.includes("claude") ||
    hay.includes("anthropic") ||
    category === "code" ||
    category === "terminal"
  ) {
    return "xml";
  }
  return "markdown";
}

/** How the engineered prompt is laid out: a generic format or one AI's own. */
export type FormatChoice = Exclude<PromptFormat, "auto"> | { text: string };

export interface EngineerExtras {
  /** Set when the prompt must be English although the speaker used another language. */
  translateFrom?: string;
}

const TRUSTED_NOTE =
  "\nDetails from the request context (known facts about the user, the screen or selected text, the user's answer to a clarifying question) are the user's own information, not inventions; use them where they help.\n";

function fill(
  template: string,
  s: EngineerSettings,
  format: FormatChoice,
  snippets: boolean,
  extras: EngineerExtras,
): string {
  const formatText =
    typeof format === "string" ? FORMAT_TEXT[format] : format.text;
  let out = template
    .replace("{missing_info}", MISSING_INFO[s.missing_info])
    .replace("{format}", formatText)
    .replace(
      "{snippets}",
      (snippets ? T.SNIPPET_RULE : "") + NO_NEW_NUMBERS + TRUSTED_NOTE,
    )
    .replace("- data_analysis:", `- ${MUSIC_PLAYBOOK}\n- data_analysis:`);
  if (extras.translateFrom !== undefined)
    out += `\n\n${englishRule(extras.translateFrom || undefined, "the finished prompt")}`;
  return out;
}

export function architectSystem(
  s: EngineerSettings,
  format: FormatChoice,
  snippets: boolean,
  extras: EngineerExtras = {},
) {
  return fill(T.ARCHITECT_SYSTEM, s, format, snippets, extras);
}

export function criticSystem(
  s: EngineerSettings,
  format: FormatChoice,
  snippets: boolean,
  extras: EngineerExtras = {},
) {
  return fill(T.CRITIC_SYSTEM, s, format, snippets, extras);
}

export const MAX_SCREEN_CHARS = 8000;

/** Trusted context shared by the architect and the critic. */
export function contextBlocks(args: {
  memories?: Memory[];
  screen?: ScreenContext;
  clarification?: Clarification;
  targetName?: string;
}): string {
  const out: string[] = [];
  if (args.targetName)
    out.push(
      `The prompt will be sent to ${args.targetName}; write it the way ${args.targetName} works best.`,
    );
  const mem = memoryBlock(args.memories ?? []);
  if (mem) out.push(`<known_about_user>\n${mem}\n</known_about_user>`);
  const screen = args.screen?.text?.trim();
  if (screen) {
    const where =
      args.screen?.source === "selection"
        ? "the text they selected"
        : "the text on their screen";
    out.push(
      `<this>\nWhen the user says "this", "it" or "here", they mean ${where}, below. The AI can't see their screen, so put this text (or the part the request is about) into the prompt in a clearly marked block.\n<screen_text>\n${screen.slice(0, MAX_SCREEN_CHARS)}\n</screen_text>\n</this>`,
    );
  }
  const c = args.clarification;
  if (c?.answer)
    out.push(
      `<clarification>\nAsked: ${c.question}\nThe user answered: ${c.answer}\n</clarification>`,
    );
  return out.join("\n\n");
}

export function architectUser(args: {
  transcript: string;
  app?: AppContext;
  category: AppCategory;
  target: PromptTarget;
  customInstructions: string;
  dictionary: string[];
  /** Trusted blocks from contextBlocks(). */
  context?: string;
}): string {
  const ctx: string[] = [];
  if (args.app) ctx.push(`App in front: ${describeApp(args.app)}`);
  ctx.push(`Kind of app: ${CATEGORY_LABEL[args.category]}`);
  if (args.target === "auto") {
    ctx.push(
      args.category === "code" || args.category === "terminal"
        ? "Choose the target from the request; it is most likely coding_agent."
        : "Choose the target that fits the request best.",
    );
  } else {
    ctx.push(`The target is ${args.target}.`);
  }
  const custom = args.customInstructions.trim();
  if (custom)
    ctx.push(
      `Standing context from the user (include it only where relevant): ${custom}`,
    );
  const words = args.dictionary.map((w) => w.trim()).filter(Boolean);
  if (words.length) {
    ctx.push(
      `Correct spellings of names and terms the user uses (fix misheard words to these): ${words.join(", ")}`,
    );
  }
  if (args.context) ctx.push(args.context);
  return `<request_context>\n${ctx.join("\n")}\n</request_context>\n\n<dictation>\n${args.transcript.trim()}\n</dictation>`;
}

export function criticUser(
  transcript: string,
  target: PromptTarget,
  draft: string,
  context = "",
): string {
  const ctx = context
    ? `<request_context>\n${context}\n</request_context>\n\n`
    : "";
  return `<target>${target}</target>\n\n${ctx}<spoken_request>\n${transcript.trim()}\n</spoken_request>\n\n<prompt_to_review>\n${draft.trim()}\n</prompt_to_review>`;
}

// ---------------------------------------------------------------------------
// Command Mode
// ---------------------------------------------------------------------------

const PLACE: Record<AppCategory, string> = {
  email: "an email",
  work_chat: "a work chat message",
  personal_chat: "a personal chat message",
  code: "a code editor",
  terminal: "a terminal",
  ai_chat: "a message to an AI assistant",
  docs: "a document",
  other: "a text field",
};

const TONE: Record<WritingStyle, string> = {
  formal: "formal",
  casual: "casual",
  very_casual: "very casual (lowercase, minimal punctuation)",
};

export function commandSystem(
  hasSelection: boolean,
  translateFrom?: string,
): string {
  const base = hasSelection ? T.EDIT_SYSTEM : T.WRITE_SYSTEM;
  const extra =
    "\n- Known facts about the user and the screen text, when given, are the user's own information: use them only where the instruction needs them.";
  return (
    base +
    extra +
    (translateFrom !== undefined
      ? `\n\n${englishRule(translateFrom || undefined, "the result")}`
      : "")
  );
}

export function commandUser(args: {
  instruction: string;
  selection?: string;
  app?: AppContext;
  category: AppCategory;
  style: WritingStyle;
  memories?: Memory[];
  screen?: ScreenContext;
}): string {
  let out = args.app ? `App in front: ${describeApp(args.app)}\n` : "";
  out += `Destination: ${PLACE[args.category]}. Default tone unless the instruction says otherwise: ${TONE[args.style]}.`;
  const mem = memoryBlock(args.memories ?? []);
  if (mem) out += `\n\n<known_about_user>\n${mem}\n</known_about_user>`;
  const screen = args.screen?.text?.trim();
  if (screen)
    out += `\n\n<screen_text>\nWhat the user is looking at; "this" means this text.\n${screen.slice(0, MAX_SCREEN_CHARS)}\n</screen_text>`;
  out += `\n\n<instruction>\n${args.instruction.trim()}\n</instruction>`;
  if (args.selection)
    out += `\n\n<selected_text>\n${args.selection}\n</selected_text>`;
  return out;
}

// ---------------------------------------------------------------------------
// Reply parsing (same tolerance as the desktop)
// ---------------------------------------------------------------------------

export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");
}

export function extractTag(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const start = text.lastIndexOf(open);
  if (start < 0) return undefined;
  const rest = text.slice(start + open.length);
  const end = rest.indexOf(`</${tag}>`);
  const body = (end >= 0 ? rest.slice(0, end) : rest).trim();
  return body || undefined;
}

function stripFences(text: string): string {
  const t = text.trim();
  if (!t.startsWith("```")) return t;
  const nl = t.indexOf("\n");
  return (nl >= 0 ? t.slice(nl + 1) : "").replace(/```\s*$/, "").trim();
}

export function parsePrompt(reply: string): string | undefined {
  const r = stripThink(reply);
  const tagged = extractTag(r, "prompt");
  if (tagged) return stripFences(tagged);
  if (["<target>", "<score>", "<issues>"].some((t) => r.includes(t)))
    return undefined;
  const bare = stripFences(r);
  return bare || undefined;
}

export function parseScore(reply: string): number | undefined {
  const raw = extractTag(stripThink(reply), "score");
  const m = raw?.match(/^\d+/);
  if (!m) return undefined;
  return Math.min(10, Math.max(1, Number(m[0])));
}

export function parseIssues(reply: string): string[] {
  const body = extractTag(stripThink(reply), "issues");
  if (!body) return [];
  return body
    .split("\n")
    .map((l) =>
      l
        .trim()
        .replace(/^[-*•]\s*/, "")
        .trim(),
    )
    .filter((l) => l && l.toLowerCase() !== "none");
}

export function parseTarget(reply: string): PromptTarget | undefined {
  const raw = extractTag(stripThink(reply), "target")
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_");
  const map: Record<string, PromptTarget> = {
    coding_agent: "coding_agent",
    coding: "coding_agent",
    chat_assistant: "chat_assistant",
    chat: "chat_assistant",
    research: "research",
    writing: "writing",
    image_generation: "image_generation",
    image: "image_generation",
    data_analysis: "data_analysis",
    data: "data_analysis",
  };
  return raw ? map[raw] : undefined;
}

/** Strip wrappers models put around a pasted reply (quotes, think blocks). */
export function cleanReply(reply: string): string {
  let t = stripThink(reply).trim();
  const sel = t.match(/^<selected_text>([\s\S]*)<\/selected_text>$/);
  if (sel) t = sel[1].trim();
  const quoted = t.match(/^["“]([^"“”]*)["”]$/);
  if (quoted) t = quoted[1];
  return t;
}
