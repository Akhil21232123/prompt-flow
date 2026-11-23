// The rewrite pipeline shared by every client: smart polish, Prompt Engineer
// (draft → independent critique → revise) and Command Mode, each followed by
// the fidelity guard.

import { classify, isAiTarget } from "./categories.ts";
import { findInventions } from "./fidelity.ts";
import { needsEnglish, type OutputLanguage } from "./languages.ts";
import { usedMemories } from "./memory.ts";
import * as P from "./prompts.ts";
import * as S from "./snippets.ts";
import {
  type AiTarget,
  conventionsFor,
  contentFor,
  detectTarget,
  playbookFor,
} from "./targets.ts";
import {
  JSON_RETRY_NOTE,
  layoutFor,
  parseDraft,
  parseReview,
  partsJson,
  type PromptParts,
  renderPrompt,
} from "./structured.ts";
import type {
  AppCategory,
  Complete,
  Mode,
  PromptTarget,
  RewriteRequest,
  RewriteResult,
  UserData,
  WritingStyle,
} from "./types.ts";

export interface Models {
  fast: string;
  smart: string;
}

export interface Deps {
  complete: Complete;
  models: Models;
}

const wordCount = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

export function styleFor(user: UserData, category: AppCategory): WritingStyle {
  switch (category) {
    case "email":
    case "work_chat":
    case "personal_chat":
    case "docs":
    case "other":
      return user.settings.styles[category];
    default:
      return "formal";
  }
}

const PRESET_LABELS = {
  clean: "Clean",
  formal: "Formal",
  short: "Short & punchy",
  casual: "Casual",
  bullets: "Bullet points",
  custom: "Custom",
} as const;

/** Which path a request takes after auto-detection. */
export function resolveMode(
  req: RewriteRequest,
  user: UserData,
  category: AppCategory,
): RewriteRequest["mode"] {
  if (req.mode !== "dictate") return req.mode;
  // A style picked on purpose (double-tap) means "write it like this", not
  // "turn it into a prompt".
  if (req.preset) return "dictate";
  const e = user.settings.engineer;
  return e.auto_in_ai_apps &&
    isAiTarget(category) &&
    wordCount(req.text) >= e.auto_min_words
    ? "engineer"
    : "dictate";
}

/** The path a request will take, before any model is called. */
export function plannedMode(req: RewriteRequest, user: UserData): Mode {
  return resolveMode(req, user, classify(req.app));
}

/** The language the result is written in: "en" or the speaker's own. */
export function outputLanguageFor(
  mode: Mode,
  req: RewriteRequest,
  user: UserData,
): OutputLanguage {
  if (req.outputLanguage) return req.outputLanguage;
  if (mode === "engineer")
    return user.settings.prompts_in_english ? "en" : "same";
  return "same";
}

/** undefined: keep the language; otherwise translate (code, or "" if unknown). */
function translateFrom(
  req: RewriteRequest,
  output: OutputLanguage,
): string | undefined {
  return needsEnglish(output, req.language, req.text)
    ? (req.language ?? "")
    : undefined;
}

/** Text the rewrite may legitimately draw facts from, besides the transcript. */
function trustedContext(
  req: RewriteRequest,
  user: UserData,
  extra = "",
): string {
  return [
    req.text,
    req.selection ?? "",
    req.screen?.text ?? "",
    req.app?.name ?? "",
    req.app?.title ?? "",
    req.app?.url ?? "",
    req.app?.surrounding_text ?? "",
    ...(req.memories ?? []).map((m) => m.content),
    req.clarification?.answer ?? "",
    user.dictionary.join(" "),
    extra,
  ].join("\n");
}

function withMemory(result: RewriteResult, req: RewriteRequest): RewriteResult {
  const used = usedMemories(req.memories ?? [], req.text, result.text);
  return {
    ...result,
    memory_used: used.map((m) => ({ id: m.id, content: m.content })),
  };
}

const REPAIR_NOTE = (problems: string[]) =>
  `\n\nYour previous attempt added details the speaker never said: ${problems.join(", ")}. Leave out anything not in the transcript.`;

async function polish(
  req: RewriteRequest,
  user: UserData,
  category: AppCategory,
  deps: Deps,
): Promise<RewriteResult> {
  const protectedText = S.protect(req.text, user.snippets);
  const style = req.style ?? styleFor(user, category);
  const system = P.polishSystem({
    category,
    style,
    presetRule: req.preset
      ? P.presetRule(req.preset, user.settings.custom_style)
      : undefined,
    app: req.app,
    developerMode: user.settings.developer_mode,
    dictionary: user.dictionary,
    hasSnippetTokens: protectedText.tokens.length > 0,
    translateFrom: translateFrom(req, outputLanguageFor("dictate", req, user)),
  });
  const context = trustedContext(req, user);
  let calls = 0;
  let guarded: string[] | undefined;
  let out = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    calls++;
    const reply = await deps.complete(
      system + (guarded ? REPAIR_NOTE(guarded) : ""),
      P.polishUser(protectedText.text),
      { model: deps.models.fast, maxTokens: 2048 },
    );
    out = P.cleanReply(reply);
    const problems = findInventions(context, out);
    if (problems.length === 0) {
      guarded = attempt > 0 ? guarded : undefined;
      break;
    }
    guarded = problems;
    if (attempt === 1) out = protectedText.text; // give up on the rewrite, keep their words
  }
  return {
    text: S.expand(out, protectedText.tokens),
    mode: "dictate",
    category,
    label: req.preset
      ? `Style · ${PRESET_LABELS[req.preset]}`
      : polishLabel(category, style),
    guarded,
    calls,
  };
}

const STYLE_WORDS: Record<WritingStyle, string> = {
  formal: "formal",
  casual: "casual",
  very_casual: "very casual",
};

/** Plain words for the Mac island: "Cleaned up · formal". */
function polishLabel(category: AppCategory, style: WritingStyle): string {
  // Code, terminals and AI chats get no tone, only the cleanup.
  return category === "code" ||
    category === "terminal" ||
    category === "ai_chat"
    ? "Cleaned up"
    : `Cleaned up · ${STYLE_WORDS[style]}`;
}

/**
 * Shown in the Mac island when Prompt Engineer fell back to the user's own
 * words. Both start "Kept your words" (the founder's stats view counts them).
 */
export const KEPT_WORDS_LABEL = "Kept your words: couldn't verify a detail";
export const KEPT_WORDS_ERROR_LABEL =
  "Kept your words: couldn't write the prompt";

async function engineer(
  req: RewriteRequest,
  user: UserData,
  category: AppCategory,
  deps: Deps,
): Promise<RewriteResult> {
  const s = user.settings.engineer;
  const protectedText = S.protect(req.text, user.snippets);
  const hasTokens = protectedText.tokens.length > 0;
  const ai: AiTarget | undefined = detectTarget(req.app);
  const guidance = contentFor(ai);
  const output = outputLanguageFor("engineer", req, user);
  const extras = { translateFrom: translateFrom(req, output) };
  const architect = P.architectSystem(s, guidance, hasTokens, extras);
  const critic = P.criticSystem(s, guidance, hasTokens, extras);
  const fixedTarget: PromptTarget =
    req.target ?? (ai ? playbookFor(ai) : undefined) ?? s.target;
  const context = P.contextBlocks({
    memories: req.memories,
    screen: req.screen,
    clarification: req.clarification,
    targetName: ai?.name,
  });
  const architectInput = P.architectUser({
    transcript: protectedText.text,
    app: req.app,
    category,
    target: fixedTarget,
    customInstructions: s.custom_instructions,
    dictionary: user.dictionary,
    context,
  });
  const smart = { model: deps.models.smart, maxTokens: 2000 };
  let calls = 0;

  // The draft, as JSON parts; one stricter retry if it isn't valid JSON.
  calls++;
  let reply = await deps.complete(architect, architectInput, smart);
  let draft = parseDraft(reply);
  if (!draft) {
    calls++;
    reply = await deps.complete(
      architect + JSON_RETRY_NOTE,
      architectInput,
      smart,
    );
    draft = parseDraft(reply);
  }
  const target: PromptTarget =
    fixedTarget !== "auto"
      ? fixedTarget
      : (draft?.target ??
        (category === "code" || category === "terminal"
          ? "coding_agent"
          : "chat_assistant"));
  const layout = layoutFor(ai, target, s.format);
  const render = (p: PromptParts) => renderPrompt(p, layout, req.screen);

  let parts = draft?.parts;
  // Still no JSON: use the reply's text as it is, unless it's broken JSON.
  const raw = parts ? undefined : P.parsePrompt(reply);
  if (!parts && (!raw || /^\s*[{[]/.test(raw)))
    throw new Error("the model returned no usable prompt");

  const review = (problems?: string[]) =>
    deps.complete(
      problems ? critic + REPAIR_NOTE(problems) : critic,
      P.criticUser(protectedText.text, target, partsJson(parts!), context),
      smart,
    );

  const rounds = !parts
    ? 0
    : s.quality === "fast"
      ? 0
      : s.quality === "balanced"
        ? 1
        : Math.min(5, Math.max(1, s.max_rounds));
  for (let i = 0; i < rounds; i++) {
    let r: ReturnType<typeof parseReview>;
    try {
      calls++;
      r = parseReview(await review());
    } catch {
      break; // keep the best prompt so far
    }
    parts = r.parts ?? parts;
    if (r.score !== undefined && r.score >= s.min_score) break;
  }
  let prompt = parts ? render(parts) : raw!;

  // Fidelity guard on the rendered text, then one targeted repair, then
  // fall back to the user's own words, cleaned up.
  const trusted = trustedContext(
    req,
    user,
    `${s.custom_instructions}\n${conventionsFor(ai, req.text)}`,
  );
  let problems = findInventions(trusted, prompt);
  let guarded: string[] | undefined;
  if (problems.length) {
    guarded = problems;
    calls++;
    if (parts) {
      const fixed = await review(problems)
        .then((r) => parseReview(r).parts)
        .catch(() => undefined);
      const text = fixed ? render(fixed) : undefined;
      if (text && findInventions(trusted, text).length === 0) {
        prompt = text;
        problems = [];
      }
    } else {
      const fixed = P.parsePrompt(
        await deps.complete(
          critic + REPAIR_NOTE(problems),
          P.criticUser(protectedText.text, target, prompt, context),
          smart,
        ),
      );
      if (fixed && findInventions(trusted, fixed).length === 0) {
        prompt = fixed;
        problems = [];
      }
    }
  }
  if (problems.length) {
    const safe = await polish(
      { ...req, mode: "dictate", outputLanguage: output },
      user,
      category,
      deps,
    );
    return {
      ...safe,
      guarded: problems,
      calls: calls + safe.calls,
      label: KEPT_WORDS_LABEL,
    };
  }

  return {
    text: S.expand(prompt, protectedText.tokens),
    mode: "engineer",
    category,
    label: ai ? `Prompt · for ${ai.name}` : "Prompt",
    ...(ai ? { target: ai.id } : {}),
    guarded,
    calls,
  };
}

async function command(
  req: RewriteRequest,
  user: UserData,
  category: AppCategory,
  deps: Deps,
): Promise<RewriteResult> {
  const selection = req.selection?.trim() ? req.selection : undefined;
  const style = req.style ?? styleFor(user, category);
  const system = P.commandSystem(
    Boolean(selection),
    translateFrom(req, outputLanguageFor("command", req, user)),
  );
  const user_ = P.commandUser({
    instruction: req.text,
    selection,
    app: req.app,
    category,
    style,
    memories: req.memories,
    screen: req.screen,
  });
  const context = trustedContext(req, user);
  let calls = 0;
  let out = "";
  let guarded: string[] | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    calls++;
    out = P.cleanReply(
      await deps.complete(
        system + (guarded ? REPAIR_NOTE(guarded) : ""),
        user_,
        {
          model: deps.models.fast,
          maxTokens: 2000,
        },
      ),
    );
    const problems = findInventions(context, out);
    if (!problems.length) break;
    guarded = problems;
  }
  return {
    text: S.apply(out, user.snippets),
    mode: "command",
    category,
    label: selection ? "Command Mode · edit selection" : "Command Mode · write",
    guarded,
    calls,
  };
}

export async function rewrite(
  req: RewriteRequest,
  user: UserData,
  deps: Deps,
): Promise<RewriteResult> {
  const category = classify(req.app);
  if (!req.text.trim()) {
    return {
      text: "",
      mode: req.mode,
      category,
      label: "Nothing heard",
      calls: 0,
    };
  }
  const mode = resolveMode(req, user, category);
  if (mode === "command")
    return withMemory(await command(req, user, category, deps), req);
  if (mode === "engineer") {
    try {
      return withMemory(await engineer(req, user, category, deps), req);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error("prompt engineer fell back:", reason);
      const safe = await polish(
        {
          ...req,
          mode: "dictate",
          outputLanguage: outputLanguageFor("engineer", req, user),
        },
        user,
        category,
        deps,
      );
      return withMemory(
        {
          ...safe,
          label: KEPT_WORDS_ERROR_LABEL,
          fallback_reason: reason.slice(0, 200),
        },
        req,
      );
    }
  }
  // Plain dictation is only cleaned up; memory is never added to it.
  return withMemory(
    await polish({ ...req, memories: undefined }, user, category, deps),
    { ...req, memories: [] },
  );
}
