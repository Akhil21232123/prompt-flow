// The rewrite pipeline shared by every client: smart polish, Prompt Engineer
// (draft → independent critique → revise) and Command Mode, each followed by
// the fidelity guard.

import { classify, isAiTarget } from "./categories.ts";
import { findInventions } from "./fidelity.ts";
import * as P from "./prompts.ts";
import * as S from "./snippets.ts";
import type {
  AppCategory,
  Complete,
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

/** Text the rewrite may legitimately draw facts from, besides the transcript. */
function trustedContext(
  req: RewriteRequest,
  user: UserData,
  extra = "",
): string {
  return [
    req.text,
    req.selection ?? "",
    req.app?.name ?? "",
    req.app?.title ?? "",
    req.app?.surrounding_text ?? "",
    user.dictionary.join(" "),
    extra,
  ].join("\n");
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
      : `Smart polish · ${category} · ${style}`,
    guarded,
    calls,
  };
}

async function engineer(
  req: RewriteRequest,
  user: UserData,
  category: AppCategory,
  deps: Deps,
): Promise<RewriteResult> {
  const s = user.settings.engineer;
  const protectedText = S.protect(req.text, user.snippets);
  const hasTokens = protectedText.tokens.length > 0;
  const format = P.resolveFormat(s.format, req.app, category);
  const architect = P.architectSystem(s, format, hasTokens);
  const critic = P.criticSystem(s, format, hasTokens);
  const fixedTarget: PromptTarget = req.target ?? s.target;
  let calls = 0;

  calls++;
  const draftReply = await deps.complete(
    architect,
    P.architectUser({
      transcript: protectedText.text,
      app: req.app,
      category,
      target: fixedTarget,
      customInstructions: s.custom_instructions,
      dictionary: user.dictionary,
    }),
    { model: deps.models.smart, maxTokens: 4096 },
  );
  let prompt = P.parsePrompt(draftReply);
  if (!prompt) throw new Error("the model returned no prompt");
  const target: PromptTarget =
    fixedTarget !== "auto"
      ? fixedTarget
      : (P.parseTarget(draftReply) ??
        (category === "code" || category === "terminal"
          ? "coding_agent"
          : "chat_assistant"));

  const rounds =
    s.quality === "fast"
      ? 0
      : s.quality === "balanced"
        ? 1
        : Math.min(5, Math.max(1, s.max_rounds));
  let score: number | undefined;
  let done = 0;
  for (let i = 0; i < rounds; i++) {
    let review: string;
    try {
      calls++;
      review = await deps.complete(
        critic,
        P.criticUser(protectedText.text, target, prompt),
        {
          model: deps.models.smart,
          maxTokens: 4096,
        },
      );
    } catch {
      break; // keep the best prompt so far
    }
    done++;
    score = P.parseScore(review);
    prompt = P.parsePrompt(review) ?? prompt;
    if (score !== undefined && score >= s.min_score) break;
  }

  // Fidelity guard, then one targeted repair, then fall back to plain polish.
  const context = trustedContext(req, user, s.custom_instructions);
  let problems = findInventions(context, prompt);
  let guarded: string[] | undefined;
  if (problems.length) {
    guarded = problems;
    calls++;
    const repaired = await deps.complete(
      critic + REPAIR_NOTE(problems),
      P.criticUser(protectedText.text, target, prompt),
      { model: deps.models.smart, maxTokens: 4096 },
    );
    const fixed = P.parsePrompt(repaired);
    if (fixed && findInventions(context, fixed).length === 0) {
      prompt = fixed;
      problems = [];
    }
  }
  if (problems.length) {
    const safe = await polish(
      { ...req, mode: "dictate" },
      user,
      category,
      deps,
    );
    return {
      ...safe,
      guarded: problems,
      calls: calls + safe.calls,
      label: "Prompt Engineer blocked an invented detail · used smart polish",
    };
  }

  let label = `Prompt Engineer · ${target}`;
  if (done) label += ` · ${done} critique round(s)`;
  if (score !== undefined) label += ` · score ${score}/10`;
  return {
    text: S.expand(prompt, protectedText.tokens),
    mode: "engineer",
    category,
    label,
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
  const system = P.commandSystem(Boolean(selection));
  const user_ = P.commandUser({
    instruction: req.text,
    selection,
    app: req.app,
    category,
    style,
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
          maxTokens: 4096,
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
  if (mode === "command") return command(req, user, category, deps);
  if (mode === "engineer") {
    try {
      return await engineer(req, user, category, deps);
    } catch {
      return polish({ ...req, mode: "dictate" }, user, category, deps);
    }
  }
  return polish(req, user, category, deps);
}
