// Prompt Engineer writes content, the server writes layout. The model returns
// the prompt's parts as JSON (task, context, requirements…) and renderPrompt
// lays them out the way the target AI reads best: XML sections for Claude,
// Markdown headings for ChatGPT and friends, a focused question for
// Perplexity, Goal/Constraints for coding agents, one dense description for
// image and music generators. Small models ignore format instructions; this
// way the format never depends on them.

import { parseJsonObject } from "./json.ts";
import type { AiTarget } from "./targets.ts";
import type { PromptFormat, PromptTarget, ScreenContext } from "./types.ts";

export interface PromptParts {
  task: string;
  context: string;
  requirements: string[];
  output_format: string;
  acceptance_criteria: string[];
  examples: string[];
  /** Image and music prompts: the whole prompt as one description. */
  prose: string;
}

export type Layout =
  | "xml"
  | "markdown"
  | "plain"
  | "search"
  | "coding"
  | "prose";

export const PROMPT_JSON_SPEC = `Reply with only a JSON object: no prose before or after it, no code fences.
{
  "target": "coding_agent" | "chat_assistant" | "research" | "writing" | "image_generation" | "music_generation" | "data_analysis",
  "task": "the direct instruction, one to three sentences, in the user's voice",
  "context": "the background, purpose and audience the user gave or clearly implied",
  "requirements": ["one requirement, constraint or 'don't' per item"],
  "output_format": "what the answer should look like: structure, length, format",
  "acceptance_criteria": ["checks the AI can make before it finishes; mainly for coding work, otherwise []"],
  "examples": ["only examples the user gave, or one that clearly helps; otherwise []"],
  "prose": "image and music prompts only: the whole prompt as one dense description; otherwise \\"\\""
}
Fill task, context, requirements and output_format for every prompt except image and music prompts, which only need prose. Don't number the items or add headings, bullets, XML or Markdown inside the fields: the server lays the prompt out. Write every field in the language the prompt should be in.`;

export const REVIEW_JSON_SPEC = `Reply with only a JSON object: no prose before or after it, no code fences.
{"score": N, "issues": ["one short line per issue, or [] if none"], "prompt": { the improved prompt, with exactly the same fields as the one you reviewed }}
Don't number the items or add headings, bullets, XML or Markdown inside the fields: the server lays the prompt out.`;

export const JSON_RETRY_NOTE =
  "\n\nYour previous reply was not valid JSON. Reply again with only the JSON object described above, starting with { and ending with }, and nothing else.";

const LAYOUT_NOTE =
  "The server lays the prompt out in the format the AI it's for reads best (XML sections, Markdown headings, a search question or one dense description). You supply the content as JSON fields.";

export function layoutNote(guidance: string): string {
  return guidance ? `${LAYOUT_NOTE} ${guidance}` : LAYOUT_NOTE;
}

/** Cuts the desktop prompt's tag-based reply shape and asks for JSON instead. */
export function withJsonReply(system: string, spec: string): string {
  const cut = system.indexOf("Reply in exactly this shape");
  const base = (cut >= 0 ? system.slice(0, cut) : system).trimEnd();
  return `${base}\n\n${spec}`;
}

// A leading "1.", "2)", "(3)", "[4]", "Step 5:", "- ", "• " or "**1.**".
const ENUMERATOR =
  /^\s*(?:\*\*\s*\d{1,2}[.)]?\s*\*\*\s*|(?:[-*•–]\s+)|\(?\d{1,2}[.):]\s+|\[\d{1,2}\]\s*|(?:step|item|point)\s+\d{1,2}\s*[:.)-]\s*)/i;

export function cleanItem(item: string): string {
  let s = item.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2 && ENUMERATOR.test(s); i++)
    s = s.replace(ENUMERATOR, "").trim();
  return s;
}

const text = (v: unknown): string => {
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v))
    return v
      .filter((x) => typeof x === "string")
      .join(" ")
      .trim();
  return "";
};

function list(v: unknown): string[] {
  const raw = Array.isArray(v)
    ? v
    : typeof v === "string"
      ? v.split(/\n+/)
      : [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" && typeof item !== "number") continue;
    const s = cleanItem(String(item));
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 20);
}

const pick = (o: Record<string, unknown>, ...keys: string[]) =>
  keys.map((k) => o[k]).find((v) => v !== undefined && v !== null);

function partsFrom(o: Record<string, unknown>): PromptParts | undefined {
  const parts: PromptParts = {
    task: text(pick(o, "task", "goal", "instruction", "question")),
    context: text(pick(o, "context", "background")),
    requirements: list(pick(o, "requirements", "constraints")),
    output_format: text(pick(o, "output_format", "format", "output")),
    acceptance_criteria: list(
      pick(o, "acceptance_criteria", "success_criteria", "done_when"),
    ),
    examples: list(pick(o, "examples", "example")),
    prose: text(pick(o, "prose", "description")),
  };
  return parts.task || parts.prose ? parts : undefined;
}

const TARGETS: Record<string, PromptTarget> = {
  coding_agent: "coding_agent",
  coding: "coding_agent",
  chat_assistant: "chat_assistant",
  chat: "chat_assistant",
  research: "research",
  writing: "writing",
  image_generation: "image_generation",
  image: "image_generation",
  music_generation: "music_generation",
  music: "music_generation",
  data_analysis: "data_analysis",
  data: "data_analysis",
};

/** The architect's reply: the prompt's parts and its playbook target. */
export function parseDraft(
  reply: string,
): { parts: PromptParts; target?: PromptTarget } | undefined {
  const obj = parseJsonObject(reply);
  if (!obj) return undefined;
  const inner =
    obj.prompt && typeof obj.prompt === "object" && !Array.isArray(obj.prompt)
      ? (obj.prompt as Record<string, unknown>)
      : obj;
  const parts = partsFrom(inner);
  if (!parts) return undefined;
  const raw = String(obj.target ?? "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return { parts, target: TARGETS[raw] };
}

/** The critic's reply: a score and the improved parts (each may be missing). */
export function parseReview(reply: string): {
  score?: number;
  parts?: PromptParts;
} {
  const obj = parseJsonObject(reply);
  if (!obj) return {};
  const n = Number(obj.score);
  const score = Number.isFinite(n)
    ? Math.min(10, Math.max(1, Math.round(n)))
    : undefined;
  const inner =
    obj.prompt && typeof obj.prompt === "object" && !Array.isArray(obj.prompt)
      ? (obj.prompt as Record<string, unknown>)
      : undefined;
  return { score, parts: inner ? partsFrom(inner) : undefined };
}

/** The draft as the critic sees it. */
export function partsJson(parts: PromptParts): string {
  return JSON.stringify(parts, null, 2);
}

/** How to lay out the prompt: the AI's own form, else the user's setting. */
export function layoutFor(
  ai: AiTarget | undefined,
  playbook: PromptTarget,
  setting: PromptFormat,
): Layout {
  if (ai) {
    switch (ai.family) {
      case "image":
      case "music":
        return "prose";
      case "search":
        return "search";
      case "coding":
      case "app_builder":
        return "coding";
      default:
        return ai.id === "claude" ? "xml" : "markdown";
    }
  }
  if (playbook === "image_generation" || playbook === "music_generation")
    return "prose";
  return setting === "xml" || setting === "plain" ? setting : "markdown";
}

// Neutral fillers so every section is always there; they carry no facts.
const NO_CONTEXT = "No further background was given.";
const NO_REQUIREMENTS = "Use your judgement for anything not stated above.";
const NO_FORMAT = "Choose the clearest format for this answer.";
const NO_CHECKS = "It does what the goal above describes.";

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join("\n");

function fence(body: string): string {
  const ticks = body.includes("```") ? "````" : "```";
  return `${ticks}\n${body}\n${ticks}`;
}

/** Lays the parts out for the target. Pure: the same parts, the same text. */
export function renderPrompt(
  parts: PromptParts,
  layout: Layout,
  screen?: ScreenContext,
): string {
  const ref = screen?.text?.trim();
  const refName =
    screen?.source === "selection" ? "selected_text" : "screen_text";
  const refTitle =
    screen?.source === "selection" ? "Selected text" : "Screen text";
  const task = parts.task || parts.prose;
  const context = parts.context || NO_CONTEXT;
  const output = parts.output_format || NO_FORMAT;

  switch (layout) {
    case "prose":
      return (
        parts.prose ||
        [parts.task, parts.context, ...parts.requirements]
          .filter(Boolean)
          .join(" ")
      );
    case "search": {
      const include = [...parts.requirements, ...parts.acceptance_criteria];
      if (parts.output_format) include.push(parts.output_format);
      let out = task;
      if (ref) out += `\n\nAbout this text:\n"""\n${ref}\n"""`;
      if (include.length) out += `\n\nInclude:\n${bullets(include)}`;
      return out;
    }
    case "coding": {
      const constraints = parts.requirements.length
        ? parts.requirements
        : [NO_REQUIREMENTS];
      const checks = parts.acceptance_criteria.length
        ? parts.acceptance_criteria
        : [parts.output_format || NO_CHECKS];
      const blocks = [
        `### Goal\n${task}`,
        `### Context\n${context}`,
        ...(ref ? [`### ${refTitle}\n${fence(ref)}`] : []),
        `### Constraints\n${bullets(constraints)}`,
        `### Acceptance criteria\n${bullets(checks)}`,
      ];
      if (parts.examples.length)
        blocks.push(`### Examples\n${bullets(parts.examples)}`);
      return blocks.join("\n\n");
    }
    case "xml": {
      const reqs = [...parts.requirements, ...parts.acceptance_criteria];
      const blocks = [
        `<task>\n${task}\n</task>`,
        `<context>\n${context}\n</context>`,
        ...(ref ? [`<${refName}>\n${ref}\n</${refName}>`] : []),
        `<requirements>\n${bullets(reqs.length ? reqs : [NO_REQUIREMENTS])}\n</requirements>`,
        `<output_format>\n${output}\n</output_format>`,
      ];
      if (parts.examples.length)
        blocks.push(
          `<examples>\n${parts.examples.map((e) => `<example>\n${e}\n</example>`).join("\n")}\n</examples>`,
        );
      return blocks.join("\n");
    }
    case "plain": {
      const reqs = [...parts.requirements, ...parts.acceptance_criteria];
      const blocks = [task, context];
      if (ref) blocks.push(`${refTitle}:\n"""\n${ref}\n"""`);
      blocks.push(
        `Requirements:\n${bullets(reqs.length ? reqs : [NO_REQUIREMENTS])}`,
      );
      blocks.push(`Output: ${output}`);
      if (parts.examples.length)
        blocks.push(`Examples:\n${bullets(parts.examples)}`);
      return blocks.join("\n\n");
    }
    default: {
      const reqs = [...parts.requirements, ...parts.acceptance_criteria];
      const blocks = [
        `### Task\n${task}`,
        `### Context\n${context}`,
        ...(ref ? [`### ${refTitle}\n${fence(ref)}`] : []),
        `### Requirements\n${bullets(reqs.length ? reqs : [NO_REQUIREMENTS])}`,
        `### Output format\n${output}`,
      ];
      if (parts.examples.length)
        blocks.push(`### Examples\n${bullets(parts.examples)}`);
      return blocks.join("\n\n");
    }
  }
}
