// Shared types for PromptFlow's backend. Runtime-agnostic: works in Deno
// (Supabase Edge Functions) and in Bun/Node for tests.

export type Mode = "dictate" | "engineer" | "command";

export type WritingStyle = "formal" | "casual" | "very_casual";

/**
 * A style picked for one dictation (double-tap). "clean" keeps the speaker's
 * words and only tidies them; "custom" applies the user's own instruction.
 */
export type StylePreset =
  | "clean"
  | "formal"
  | "short"
  | "casual"
  | "bullets"
  | "custom";

export type AppCategory =
  | "email"
  | "work_chat"
  | "personal_chat"
  | "code"
  | "terminal"
  | "ai_chat"
  | "docs"
  | "other";

export type PromptTarget =
  | "auto"
  | "coding_agent"
  | "chat_assistant"
  | "research"
  | "writing"
  | "image_generation"
  | "music_generation"
  | "data_analysis";

export type EngineerQuality = "fast" | "balanced" | "max";
export type MissingInfoPolicy = "state_assumptions" | "ask_first";
export type PromptFormat = "auto" | "xml" | "markdown" | "plain";

/** The app the user is dictating into, as the client saw it. */
export interface AppContext {
  /** Display name: "Slack", "WhatsApp". */
  name?: string;
  /** macOS bundle id or Android package name. */
  bundle_id?: string;
  /** Window title (desktop) or screen hint (mobile). */
  title?: string;
  /** Client's own guess; the server re-checks it. */
  category?: AppCategory;
  /** Text around the cursor, used only to spell names already spoken. */
  surrounding_text?: string;
  /** Page URL when the app is a browser. */
  url?: string;
}

/** "This": text the user is looking at (selection, window or OCR), ≤ 8000 chars. */
export interface ScreenContext {
  text: string;
  source?: "selection" | "window" | "ocr";
}

/** A durable fact about the user, from `public.memories`. */
export interface Memory {
  id: string;
  content: string;
  kind?: MemoryKind;
  pinned?: boolean;
}

export type MemoryKind = "fact" | "preference" | "project" | "person";

/** The ask-back question and the user's answer (undefined when skipped). */
export interface Clarification {
  question: string;
  answer?: string;
}

export interface Snippet {
  trigger: string;
  expansion: string;
}

export interface Styles {
  email: WritingStyle;
  work_chat: WritingStyle;
  personal_chat: WritingStyle;
  docs: WritingStyle;
  other: WritingStyle;
}

export interface EngineerSettings {
  quality: EngineerQuality;
  target: PromptTarget;
  missing_info: MissingInfoPolicy;
  format: PromptFormat;
  min_score: number;
  max_rounds: number;
  auto_in_ai_apps: boolean;
  auto_min_words: number;
  custom_instructions: string;
}

/** Per-user settings stored in `user_settings.settings`. */
export interface UserSettings {
  language: string; // "en", "auto", "hi"...
  styles: Styles;
  developer_mode: boolean;
  engineer: EngineerSettings;
  store_history: boolean;
  /** The instruction behind the "custom" style preset. */
  custom_style: string;
  /** Learn durable facts and add the relevant ones to prompts. */
  memory_enabled: boolean;
  /** Let Prompt Engineer ask one quick question about a vague request. */
  ask_back: boolean;
  /** Default spoken language: a Whisper code or "auto". */
  spoken_language: string;
  /** Prompt Engineer writes English whatever language was spoken. */
  prompts_in_english: boolean;
}

export const DEFAULT_SETTINGS: UserSettings = {
  language: "en",
  styles: {
    email: "formal",
    work_chat: "casual",
    personal_chat: "casual",
    docs: "formal",
    other: "casual",
  },
  developer_mode: true,
  engineer: {
    quality: "balanced",
    target: "auto",
    missing_info: "state_assumptions",
    format: "auto",
    min_score: 9,
    max_rounds: 3,
    auto_in_ai_apps: false,
    auto_min_words: 8,
    custom_instructions: "",
  },
  store_history: true,
  custom_style: "",
  memory_enabled: true,
  ask_back: true,
  spoken_language: "en",
  prompts_in_english: true,
};

/** Everything the rewrite needs to know about one dictation. */
export interface RewriteRequest {
  text: string;
  mode: Mode;
  app?: AppContext;
  /** Selected text, for Command Mode. */
  selection?: string;
  /** Overrides for this request only. */
  style?: WritingStyle;
  /** A style chosen for this dictation; turns off auto Prompt Engineer. */
  preset?: StylePreset;
  target?: PromptTarget;
  /** "This": what's on screen. Trusted context. */
  screen?: ScreenContext;
  /** "en" or "same"; undefined means the default for the mode. */
  outputLanguage?: "en" | "same";
  /** Spoken (or written) language code, when known. */
  language?: string;
  /** Memories to offer as context (pinned plus the most relevant). */
  memories?: Memory[];
  /** An answered (or skipped) ask-back question. */
  clarification?: Clarification;
}

export interface UserData {
  settings: UserSettings;
  dictionary: string[];
  snippets: Snippet[];
}

export interface RewriteResult {
  text: string;
  /** Which path produced the text. */
  mode: Mode;
  category: AppCategory;
  /** e.g. "Prompt Engineer · coding_agent · 1 critique round(s) · score 9/10". */
  label: string;
  /** Set when the fidelity guard rejected a rewrite and a safer path was used. */
  guarded?: string[];
  /** The AI the prompt was written for (Prompt Engineer only). */
  target?: string;
  /** Memories that made it into the text. */
  memory_used?: Array<{ id: string; content: string }>;
  /** Model calls made. */
  calls: number;
  /** Why Prompt Engineer fell back to the user's words (short, for support). */
  fallback_reason?: string;
}

/** One system+user completion against a chat model. */
export type Complete = (
  system: string,
  user: string,
  opts?: { model?: string; maxTokens?: number },
) => Promise<string>;

/** Speech-to-text for a whole recording. */
export type Transcribe = (
  audio: Blob,
  opts: { language?: string; prompt?: string },
) => Promise<{
  text: string;
  provider: string;
  /** The model judged the whole clip to be non-speech. */
  silent?: boolean;
  /** Language code the model heard, when it says. */
  language?: string;
}>;
