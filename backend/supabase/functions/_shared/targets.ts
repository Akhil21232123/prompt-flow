// Which AI the prompt is for, worked out from the app in front (name,
// bundle id, window title, URL), and how that AI likes its prompts written.

import { classify } from "./categories.ts";
import type { AppContext, PromptTarget } from "./types.ts";

export type TargetFamily =
  | "chat"
  | "search"
  | "coding"
  | "app_builder"
  | "image"
  | "music";

export interface AiTarget {
  /** Stable id returned to clients as `target`. */
  id: string;
  /** Display name, as in "Prompt · for Claude". */
  name: string;
  family: TargetFamily;
}

interface Rule extends AiTarget {
  bundles?: string[];
  hosts?: string[];
  /** Words matched in the app name, and in the window title or URL. */
  words?: string[];
  /** Words matched in the app name only (too common for window titles). */
  nameWords?: string[];
}

// Order matters: editors before the chat apps whose names they contain
// (VS Code's Copilot Chat before Microsoft Copilot), and specific tools
// before general ones.
const RULES: Rule[] = [
  {
    id: "cursor",
    name: "Cursor",
    family: "coding",
    bundles: ["com.todesktop.230313mzl4w4u92"],
    nameWords: ["cursor"],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    family: "coding",
    bundles: ["com.exafunction.windsurf"],
    words: ["windsurf"],
  },
  {
    id: "vscode",
    name: "VS Code",
    family: "coding",
    bundles: ["com.microsoft.vscode", "com.microsoft.vscodeinsiders"],
    words: ["visual studio code", "vs code", "vscode", "copilot chat"],
  },
  {
    id: "v0",
    name: "v0",
    family: "app_builder",
    hosts: ["v0.dev", "v0.app"],
    nameWords: ["v0"],
  },
  {
    id: "lovable",
    name: "Lovable",
    family: "app_builder",
    hosts: ["lovable.dev", "lovable.app"],
    words: ["lovable"],
  },
  {
    id: "bolt",
    name: "Bolt",
    family: "app_builder",
    hosts: ["bolt.new"],
    words: ["bolt.new"],
  },
  {
    id: "midjourney",
    name: "Midjourney",
    family: "image",
    hosts: ["midjourney.com"],
    words: ["midjourney"],
  },
  {
    id: "dalle",
    name: "DALL·E",
    family: "image",
    words: ["dall-e", "dall·e", "dalle"],
  },
  {
    id: "ideogram",
    name: "Ideogram",
    family: "image",
    hosts: ["ideogram.ai"],
    words: ["ideogram"],
  },
  {
    id: "leonardo",
    name: "Leonardo",
    family: "image",
    hosts: ["leonardo.ai"],
    words: ["leonardo.ai"],
    nameWords: ["leonardo"],
  },
  {
    id: "firefly",
    name: "Firefly",
    family: "image",
    hosts: ["firefly.adobe.com"],
    words: ["adobe firefly", "firefly"],
  },
  {
    id: "suno",
    name: "Suno",
    family: "music",
    bundles: ["com.suno.android", "com.suno.app", "ai.suno.app"],
    hosts: ["suno.com", "suno.ai"],
    words: ["suno"],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    family: "search",
    bundles: [
      "ai.perplexity.mac",
      "ai.perplexity.app",
      "ai.perplexity.app.android",
    ],
    hosts: ["perplexity.ai"],
    words: ["perplexity"],
  },
  {
    id: "claude",
    name: "Claude",
    family: "chat",
    bundles: ["com.anthropic.claudefordesktop", "com.anthropic.claude"],
    hosts: ["claude.ai"],
    words: ["claude"],
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    family: "chat",
    bundles: ["com.openai.chat", "com.openai.chatgpt"],
    hosts: ["chatgpt.com", "chat.openai.com"],
    words: ["chatgpt"],
  },
  {
    id: "gemini",
    name: "Gemini",
    family: "chat",
    bundles: ["com.google.android.apps.bard", "com.google.gemini"],
    hosts: ["gemini.google.com", "aistudio.google.com"],
    words: ["gemini"],
  },
  {
    id: "copilot",
    name: "Copilot",
    family: "chat",
    bundles: ["com.microsoft.copilot", "com.microsoft.copilot.mac"],
    hosts: ["copilot.microsoft.com"],
    words: ["copilot"],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    family: "chat",
    bundles: ["com.deepseek.chat"],
    hosts: ["chat.deepseek.com", "deepseek.com"],
    words: ["deepseek"],
  },
  {
    id: "grok",
    name: "Grok",
    family: "chat",
    bundles: ["ai.x.grok", "com.x.grok"],
    hosts: ["grok.com"],
    words: ["grok"],
  },
];

/** Command-line coding agents, recognised from a terminal's window title. */
const TERMINAL_AGENTS: Rule[] = [
  {
    id: "claude_code",
    name: "Claude Code",
    family: "coding",
    words: ["claude"],
  },
  { id: "codex", name: "Codex", family: "coding", words: ["codex"] },
  { id: "gemini_cli", name: "Gemini CLI", family: "coding", words: ["gemini"] },
];

function containsWord(haystack: string, needle: string): boolean {
  if (!haystack) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`,
    "u",
  ).test(haystack);
}

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return "";
  }
}

const hostMatches = (host: string, rule: string) =>
  host === rule || host.endsWith(`.${rule}`);

const pick = (r: Rule): AiTarget => ({
  id: r.id,
  name: r.name,
  family: r.family,
});

/** The AI the user is writing to, or undefined when it isn't one we know. */
export function detectTarget(
  app: AppContext | undefined,
): AiTarget | undefined {
  if (!app) return undefined;
  const bundle = (app.bundle_id ?? "").trim().toLowerCase();
  const name = (app.name ?? "").trim().toLowerCase();
  const title = (app.title ?? "").toLowerCase();
  const host = hostOf(app.url);
  const category = classify(app);

  if (category === "terminal") {
    const agent = TERMINAL_AGENTS.find((r) =>
      r.words!.some((w) => containsWord(title, w) || containsWord(name, w)),
    );
    return agent ? pick(agent) : undefined;
  }

  // Strong signals first: the app itself, then the site.
  for (const r of RULES)
    if (r.bundles?.some((b) => bundle === b || bundle.startsWith(`${b}.`)))
      return pick(r);
  if (host)
    for (const r of RULES)
      if (r.hosts?.some((h) => hostMatches(host, h))) return pick(r);
  for (const r of RULES)
    if (
      [...(r.words ?? []), ...(r.nameWords ?? [])].some((w) =>
        containsWord(name, w),
      )
    )
      return pick(r);

  // A window title mentions all sorts of things in mail, chat and documents
  // ("Re: Claude pricing"), so it only counts in browsers and AI apps.
  if (category === "ai_chat" || category === "other" || category === "code") {
    for (const r of RULES)
      if ((r.words ?? []).some((w) => containsWord(title, w))) return pick(r);
  }
  return undefined;
}

/** The Prompt Engineer playbook entry each family maps to. */
export function playbookFor(t: AiTarget): PromptTarget | undefined {
  switch (t.family) {
    case "coding":
    case "app_builder":
      return "coding_agent";
    case "search":
      return "research";
    case "image":
      return "image_generation";
    case "music":
      return "music_generation";
    default:
      return undefined; // chat assistants: let the model pick per request
  }
}

const XML_SECTIONS =
  "Open with the task in plain sentences. Put supporting material in descriptive XML tags such as <context>, <requirements>, <constraints>, <output_format> and <success_criteria>, using only the sections this request needs.";
const MARKDOWN_SECTIONS =
  "Open with the task in one or two plain sentences. Then use short Markdown sections with ### headings and bullets, such as Context, Requirements, Output format and Done when, using only the sections this request needs.";

const ASPECT_WORDS =
  /\b(landscape|portrait|square|wide|widescreen|vertical|horizontal|tall|panoramic|banner|thumbnail|wallpaper)\b/i;

/** How to write the prompt for this AI; replaces the generic format rule. */
export function formatFor(t: AiTarget): string {
  switch (t.id) {
    case "claude":
      return `This prompt is for Claude. ${XML_SECTIONS} Claude follows instructions precisely, so state exactly what is wanted, and say why where it helps.`;
    case "perplexity":
      return "This prompt is for Perplexity, an answer engine that searches the web. Write one focused, search-style question first: the exact thing to find out. Then add at most a few short plain lines on scope (time range, region, domain) and the kind of sources wanted, and ask for the most recent information available, with dates and cited sources. No headings, no XML, no role-play.";
    case "claude_code":
      return `This prompt is for Claude Code, a coding agent in the terminal. ${XML_SECTIONS} Cover the goal, the context (files, functions, commands and errors mentioned), constraints, and acceptance criteria the agent can check before it finishes.`;
    case "cursor":
    case "windsurf":
    case "vscode":
    case "codex":
    case "gemini_cli":
      return `This prompt is for ${t.name}'s coding agent. Use short Markdown sections with ### headings: Goal, Context (the files, functions, stack and errors mentioned), Constraints, and Acceptance criteria the agent can check before it finishes. Use only the sections the request needs; a small fix can be a few lines.`;
    case "midjourney":
      return 'This prompt is for Midjourney. Write one dense visual description, with no headings, markup or preamble: subject first, then setting, style or medium, lighting, colour palette, composition and camera angle, and mood, as descriptive comma-separated phrases. Only when the speaker gave a shape or ratio, end with an aspect ratio flag (landscape or wide → --ar 16:9, portrait or vertical → --ar 9:16, square → --ar 1:1, or the ratio they said). Add "--no" followed by things they said to leave out. Add no other flags.';
    case "ideogram":
      return "This prompt is for Ideogram. Write one dense visual description in plain sentences, with no headings or markup: subject, setting, style or medium, lighting, colour palette, composition and mood. Put any words that must appear in the image in double quotes and say where they go; Ideogram renders text well.";
    case "suno":
      return "This prompt is for Suno, a music generator. First line: a compact style description as comma-separated tags (genre and sub-genre, mood, tempo feel, instrumentation, vocal type). Then, only if the speaker gave lyrics or a theme for them, lay out the song with [Verse], [Chorus] and [Bridge] tags, using their words. No BPM, key or durations unless the speaker said them.";
  }
  switch (t.family) {
    case "image":
      return `This prompt is for ${t.name}, an image generator. Write one dense visual description in plain prose, with no headings, markup or preamble: subject first, then setting, style or medium, lighting, colour palette, composition and camera angle, and mood. Put any text that must appear in the image in quotes. Mention the shape (landscape, portrait, square) only if the speaker gave one.`;
    case "app_builder":
      return `This prompt is for ${t.name}, an AI app builder. Open with what the app or page is and who it is for. Then use short Markdown sections with ### headings: Pages and components, Key interactions, Data, Look and feel, and Done when, using only the sections the request needs.`;
    case "music":
      return `This prompt is for ${t.name}, a music generator. Describe the genre, mood, instrumentation, vocals and song structure in a few compact lines.`;
    default:
      return `This prompt is for ${t.name}. ${MARKDOWN_SECTIONS}`;
  }
}

/** Playbook rule for music, which the desktop prompt doesn't cover. */
export const MUSIC_PLAYBOOK =
  "music_generation: Describe genre, mood, tempo feel, instrumentation, vocals and song structure; use the speaker's lyrics or theme exactly.";

/**
 * Format conventions the guard should accept although the speaker didn't
 * say them: Midjourney's aspect ratio flags, when the speaker named a shape.
 */
export function conventionsFor(
  t: AiTarget | undefined,
  transcript: string,
): string {
  if (t?.id === "midjourney" && ASPECT_WORDS.test(transcript))
    return "16:9 9:16 1:1 4:5 5:4 3:2 2:3 21:9";
  return "";
}
