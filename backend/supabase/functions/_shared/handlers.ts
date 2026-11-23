// HTTP handlers for the edge functions. Each takes its dependencies as
// arguments so tests can run them without Supabase or model providers.
// docs/v2-contract.md is the source of truth for every shape here.
//
//   POST /dictate         multipart: audio (WAV), meta (JSON)
//   POST /rewrite         JSON: { text, mode, preset?, app?, selection?, screen?, language?, output_language? }
//   POST /check           JSON: { intent, answer, app? }
//   POST /learn           JSON: { original, edited }
//   GET  /usage
//   POST /delete_account

import { CLARIFY_TTL_MS, decideAskBack, mayAsk } from "./askback.ts";
import { checkAnswer, MAX_INTENT_CHARS } from "./check.ts";
import { isLikelyHallucination, isPromptEcho } from "./hallucination.ts";
import { boolish } from "./json.ts";
import {
  guessLanguageFromScript,
  languageCode,
  languageName,
  parseOutputLanguage,
  sttLanguage,
} from "./languages.ts";
import { learnFromEdit } from "./learn.ts";
import {
  DEFAULT_LIMITS,
  feedbackRetryAfter,
  LimitError,
  type Limits,
  MAX_AUDIO_SEC,
  PLAN,
  wavSeconds,
} from "./limits.ts";
import { extractMemories, memorySearches } from "./memory.ts";
import { classify, isAiTarget } from "./categories.ts";
import {
  MIN_PROMPT_WORDS,
  outputLanguageFor,
  plannedMode,
  rewrite,
  type Models,
} from "./pipeline.ts";
import { MAX_SCREEN_CHARS } from "./prompts.ts";
import {
  BASE_VOCABULARY,
  ProviderError,
  vocabularyPrompt,
} from "./providers.ts";
import {
  AuthError,
  type ClarificationRow,
  type Db,
  isUuid,
} from "./supabase.ts";
import { detectTarget } from "./targets.ts";
import type {
  AppContext,
  Complete,
  Memory,
  Mode,
  PromptTarget,
  RewriteRequest,
  RewriteResult,
  ScreenContext,
  StylePreset,
  Transcribe,
  UserData,
  WritingStyle,
} from "./types.ts";

export interface Ctx {
  /** Resolves the caller; throws AuthError when signed out. */
  db: (req: Request) => Promise<Db>;
  complete: Complete;
  transcribe: Transcribe;
  models: Models;
  limits?: Limits;
  /**
   * Keeps work running after the response is sent (EdgeRuntime.waitUntil
   * in Supabase). Without it the work is fire-and-forget.
   */
  background?: (work: Promise<unknown>) => void;
}

/** How many relevant memories go into a prompt, besides the pinned ones. */
export const RELEVANT_MEMORIES = 6;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

export function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json", ...extraHeaders },
  });
}

class BadRequest extends Error {}

function errorResponse(e: unknown): Response {
  if (e instanceof AuthError)
    return json({ error: e.message, code: "auth" }, 401);
  if (e instanceof BadRequest)
    return json({ error: e.message, code: "bad_request" }, 400);
  if (e instanceof LimitError)
    return json(
      { error: e.message, code: e.code, retry_after_sec: e.retryAfterSec },
      429,
      { "retry-after": String(e.retryAfterSec) },
    );
  if (e instanceof ProviderError) {
    console.error(`provider error: ${e.message}`);
    if (e.status === 429)
      return json(
        {
          error: "The AI service is busy. Try again in a few seconds.",
          code: "rate_limited",
          retry_after_sec: 15,
        },
        429,
        { "retry-after": "15" },
      );
    return json({ error: e.message, code: "provider" }, 502);
  }
  console.error(e);
  return json(
    { error: e instanceof Error ? e.message : String(e), code: "internal" },
    500,
  );
}

/** Runs work after the response; its failure is logged, never thrown. */
function later(ctx: Ctx, work: () => Promise<unknown>) {
  const p = Promise.resolve()
    .then(work)
    .catch((e) =>
      console.warn(
        `background work failed: ${e instanceof Error ? e.message : e}`,
      ),
    );
  ctx.background?.(p);
}

async function consume(ctx: Ctx, db: Db): Promise<void> {
  const usage = await db.consumeUsage(ctx.limits ?? DEFAULT_LIMITS);
  if (!usage.allowed) throw new LimitError(usage.code, usage.retry_after_sec);
}

const MODES: Mode[] = ["dictate", "engineer", "command"];
const STYLES: WritingStyle[] = ["formal", "casual", "very_casual"];
const PRESETS: StylePreset[] = [
  "clean",
  "formal",
  "short",
  "casual",
  "bullets",
  "custom",
];
const SCREEN_SOURCES = ["selection", "window", "ocr"] as const;

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.slice(0, max) : undefined;

function parseApp(raw: unknown): AppContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const a = raw as Record<string, unknown>;
  const app: AppContext = {
    name: str(a.name, 200),
    bundle_id: str(a.bundle_id, 200),
    title: str(a.title, 500),
    surrounding_text:
      typeof a.surrounding_text === "string"
        ? a.surrounding_text.slice(-2000)
        : undefined,
    url: str(a.url, 2000),
    category:
      typeof a.category === "string"
        ? (a.category as AppContext["category"])
        : undefined,
  };
  for (const k of Object.keys(app) as Array<keyof AppContext>)
    if (app[k] === undefined) delete app[k];
  return Object.keys(app).length ? app : undefined;
}

function parseScreen(raw: unknown): ScreenContext | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  const text = str(s.text, MAX_SCREEN_CHARS);
  if (!text) return undefined;
  const source = SCREEN_SOURCES.find((x) => x === s.source);
  return source ? { text, source } : { text };
}

/** What the Fn key does here; see parseRequestBody. */
export function autoMode(
  app: AppContext | undefined,
  selection: string | undefined,
  text: string,
): Mode {
  if (selection) return "command";
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const ai = detectTarget(app) !== undefined || isAiTarget(classify(app));
  return ai && words >= MIN_PROMPT_WORDS ? "engineer" : "dictate";
}

function parseRequestBody(
  raw: Record<string, unknown>,
  text: string,
): RewriteRequest {
  const app = parseApp(raw.app);
  const selected =
    typeof raw.selection === "string" && raw.selection.trim()
      ? raw.selection
      : undefined;
  // "auto" (the Mac's Fn key): PromptFlow decides. Text selected → edit it;
  // an AI app or code editor → a prompt; anywhere else → your words, written
  // for that app.
  const mode = (
    raw.mode === "auto"
      ? autoMode(app, selected, text)
      : (raw.mode ?? "dictate")
  ) as Mode;
  if (!MODES.includes(mode)) throw new BadRequest(`unknown mode "${raw.mode}"`);
  const style = raw.style as WritingStyle | undefined;
  if (style && !STYLES.includes(style))
    throw new BadRequest(`unknown style "${style}"`);
  const preset = raw.preset as StylePreset | undefined;
  if (preset && !PRESETS.includes(preset))
    throw new BadRequest(`unknown preset "${preset}"`);
  return {
    text,
    mode,
    app,
    selection:
      typeof raw.selection === "string" && raw.selection.trim()
        ? raw.selection.slice(0, 20_000)
        : undefined,
    style,
    preset,
    target: raw.target as PromptTarget | undefined,
    screen: parseScreen(raw.screen),
    outputLanguage: parseOutputLanguage(raw.output_language),
  };
}

/** The part of a request's meta that's kept with an ask-back question. */
function snapshot(meta: Record<string, unknown>): Record<string, unknown> {
  const keep = [
    "mode",
    "preset",
    "style",
    "target",
    "language",
    "output_language",
    "app",
    "selection",
    "screen",
    "device",
    "duration_sec",
  ];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (meta[k] !== undefined) out[k] = meta[k];
  const app = parseApp(meta.app);
  if (app) out.app = app;
  else delete out.app;
  const screen = parseScreen(meta.screen);
  if (screen) out.screen = screen;
  else delete out.screen;
  if (typeof out.selection === "string")
    out.selection = out.selection.slice(0, 20_000);
  return out;
}

const CLARIFY_KEYS = ["clarify_session", "answer_text", "skip_clarify"];

function parseMeta(raw: FormDataEntryValue | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const meta = JSON.parse(typeof raw === "string" ? raw : "");
    if (meta && typeof meta === "object" && !Array.isArray(meta))
      return meta as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new BadRequest("meta must be a JSON object");
}

// 25 MB is Whisper's upload limit; 6 minutes of 16 kHz mono PCM16 is ~11.5 MB.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

async function checkAudio(audio: Blob, durationSec: unknown) {
  if (audio.size > MAX_AUDIO_BYTES)
    throw new BadRequest("recording is too long (6 minutes max)");
  const header = new Uint8Array(await audio.slice(0, 4096).arrayBuffer());
  const seconds = wavSeconds(header, audio.size);
  const claimed = typeof durationSec === "number" ? durationSec : 0;
  if (Math.max(seconds ?? 0, claimed) > MAX_AUDIO_SEC)
    throw new BadRequest("recording is too long (6 minutes max)");
}

interface Heard {
  text: string;
  provider?: string;
  language?: string;
  ms: number;
  dropped?: "silence" | "hallucination";
}

async function hear(
  ctx: Ctx,
  audio: Blob,
  opts: { language?: string; vocabulary?: string; durationSec?: number },
): Promise<Heard> {
  const t0 = Date.now();
  const stt = await ctx.transcribe(audio, {
    language: opts.language,
    prompt: opts.vocabulary,
  });
  const ms = Date.now() - t0;
  const text = stt.text.trim();
  let dropped: Heard["dropped"];
  if (stt.silent || !text) dropped = "silence";
  else if (
    isLikelyHallucination(text, opts.durationSec) ||
    isPromptEcho(text, opts.vocabulary)
  )
    dropped = "hallucination";
  return {
    text,
    provider: stt.provider,
    ms,
    dropped,
    language:
      languageCode(stt.language) ??
      opts.language ??
      guessLanguageFromScript(text) ??
      "en",
  };
}

/** After a finished dictation: remember new facts, note which were used. */
function learnLater(
  ctx: Ctx,
  db: Db,
  user: UserData,
  said: string,
  offered: Memory[],
  result: RewriteResult,
) {
  if (!user.settings.memory_enabled) return;
  later(ctx, async () => {
    const used = (result.memory_used ?? []).map((m) => m.id);
    if (used.length) await db.markMemoriesUsed(used);
    const known = offered.length
      ? offered
      : await db.findMemories(said, RELEVANT_MEMORIES);
    const found = await extractMemories(
      said,
      known,
      ctx.complete,
      ctx.models.fast,
    );
    await db.saveMemories(found);
  });
}

async function memoriesFor(
  db: Db,
  user: UserData,
  request: RewriteRequest,
): Promise<Memory[]> {
  if (!user.settings.memory_enabled) return [];
  // Plain dictation is only cleaned up, so it never needs memory.
  if (plannedMode(request, user) === "dictate") return [];
  const query = [request.text, request.clarification?.answer ?? ""].join(" ");
  const lists = await Promise.all([
    db.findMemories(query, RELEVANT_MEMORIES),
    ...memorySearches(request.text).map((q) => db.findMemories(q, 4)),
  ]);
  const seen = new Set<string>();
  return lists.flat().filter((m) => !seen.has(m.id) && seen.add(m.id));
}

function finished(
  raw: string,
  result: RewriteResult,
  language: string | undefined,
  timing: Record<string, number>,
  id?: string,
) {
  return {
    ...(id ? { id } : {}),
    raw,
    text: result.text,
    mode: result.mode,
    category: result.category,
    label: result.label,
    ...(result.target ? { target: result.target } : {}),
    guarded: result.guarded ?? [],
    memory_used: result.memory_used ?? [],
    ...(result.fallback_reason
      ? { fallback_reason: result.fallback_reason }
      : {}),
    ...(language ? { language } : {}),
    timing,
  };
}

export async function handleDictate(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const db = await ctx.db(req);
    const form = await req.formData().catch(() => {
      throw new BadRequest("send multipart/form-data with an audio file");
    });
    const field = form.get("audio");
    const audio = field instanceof Blob && field.size > 0 ? field : undefined;
    let meta = parseMeta(form.get("meta"));
    const started = Date.now();

    // Answering an earlier ask-back question?
    const sessionId =
      typeof meta.clarify_session === "string" ? meta.clarify_session : "";
    const skip = boolish(meta.skip_clarify);
    const answerText =
      typeof meta.answer_text === "string"
        ? meta.answer_text.trim().slice(0, 500)
        : "";
    let pending: ClarificationRow | undefined;
    if (sessionId) {
      if (!audio && !answerText && !skip)
        throw new BadRequest("send answer_text, audio or skip_clarify");
      pending = await db.takeClarification(sessionId);
      if (!pending)
        throw new BadRequest(
          "That question has expired. Please say your request again.",
        );
      const current = Object.fromEntries(
        Object.entries(meta).filter(([k]) => !CLARIFY_KEYS.includes(k)),
      );
      meta = { ...pending.meta, ...current };
    } else if (!audio) {
      throw new BadRequest("missing audio");
    }
    if (audio) await checkAudio(audio, meta.duration_sec);
    const base = parseRequestBody(meta, "");
    const durationSec =
      typeof meta.duration_sec === "number" ? meta.duration_sec : undefined;

    // Answers to a question were counted with the question.
    const [user] = await Promise.all([
      db.loadUserData(),
      pending ? Promise.resolve() : consume(ctx, db),
    ]);
    // The product names help only where they're said: in AI apps. Elsewhere
    // (WhatsApp in Hinglish) an English word list pulls names off ("Priya").
    const aiApp =
      detectTarget(base.app) !== undefined || isAiTarget(classify(base.app));
    const vocabulary = vocabularyPrompt([
      ...user.dictionary,
      ...(aiApp ? BASE_VOCABULARY : []),
    ]);
    const whisperLanguage = sttLanguage(
      meta.language ?? user.settings.spoken_language,
    );

    let transcript: string;
    let language: string | undefined;
    let sttMs = 0;
    let sttProvider: string | undefined;
    let answer: string | undefined;

    if (pending) {
      transcript = pending.transcript;
      language = pending.language ?? undefined;
      if (!skip && answerText) answer = answerText;
      else if (!skip && audio) {
        const heard = await hear(ctx, audio, {
          language: whisperLanguage ?? language,
          vocabulary,
          durationSec,
        });
        sttMs = heard.ms;
        sttProvider = heard.provider;
        // Nothing heard counts as "just write it".
        if (!heard.dropped) answer = heard.text;
      }
    } else {
      const heard = await hear(ctx, audio!, {
        language: whisperLanguage,
        vocabulary,
        durationSec,
      });
      sttMs = heard.ms;
      sttProvider = heard.provider;
      if (heard.dropped) {
        return json({
          dropped: true,
          raw: "",
          reason: heard.dropped,
          text: "",
          mode: base.mode,
          label: "Nothing heard",
          timing: { stt_ms: sttMs, total_ms: Date.now() - started },
        });
      }
      transcript = heard.text;
      language = heard.language;
    }

    const request: RewriteRequest = {
      ...base,
      text: transcript,
      language,
      clarification: pending
        ? { question: pending.question, answer }
        : undefined,
    };
    const memories = await memoriesFor(db, user, request);
    request.memories = memories;
    const deps = { complete: ctx.complete, models: ctx.models };

    let result: RewriteResult;
    const canAsk =
      !pending &&
      base.mode === "engineer" &&
      meta.ask_back !== false &&
      user.settings.ask_back &&
      mayAsk(transcript);
    if (canAsk) {
      // Write the prompt while deciding; most requests don't get a question.
      const writing = rewrite(request, user, deps);
      writing.catch(() => {});
      const target = detectTarget(request.app);
      const english =
        outputLanguageFor("engineer", request, user) === "en"
          ? "English"
          : language && language !== "en"
            ? languageName(language)
            : undefined;
      const decision = await decideAskBack(
        {
          transcript,
          appName: request.app?.name,
          targetName: target?.name,
          memories,
          screen: request.screen,
          selection: request.selection,
          questionLanguage: english,
        },
        ctx.complete,
        ctx.models.fast,
      );
      if (decision.ask && decision.question) {
        const id = await db.createClarification({
          transcript,
          question: decision.question,
          options: decision.options ?? [],
          meta: snapshot(meta),
          language: language ?? null,
          expires_at: new Date(Date.now() + CLARIFY_TTL_MS).toISOString(),
        });
        if (id) {
          return json({
            needs_clarification: true,
            clarify_session: id,
            question: decision.question,
            options: decision.options ?? [],
            raw: transcript,
            timing: { stt_ms: sttMs, total_ms: Date.now() - started },
          });
        }
      }
      result = await writing;
    } else {
      result = await rewrite(request, user, deps);
    }
    const totalMs = Date.now() - started;
    const said = answer ? `${transcript}\n${answer}` : transcript;

    // The row's id is made here so the response can carry it (for
    // /feedback) while the insert runs after the response.
    const id = user.settings.store_history ? crypto.randomUUID() : undefined;
    if (id) {
      later(ctx, () =>
        db.saveDictation({
          id,
          mode: result.mode,
          device: typeof meta.device === "string" ? meta.device : null,
          app: request.app ?? null,
          category: result.category,
          raw_text: said,
          final_text: result.text,
          label: result.label,
          duration_ms: durationSec ? Math.round(durationSec * 1000) : null,
          stt_provider: sttProvider ?? null,
          latency_ms: totalMs,
          guarded: result.guarded ?? null,
        }),
      );
    }
    learnLater(ctx, db, user, said, memories, result);

    return json(
      finished(
        transcript,
        result,
        language,
        { stt_ms: sttMs, total_ms: totalMs },
        id,
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => {
    throw new BadRequest("send a JSON body");
  });
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BadRequest("send a JSON object");
  return body as Record<string, unknown>;
}

export async function handleRewrite(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const db = await ctx.db(req);
    const body = await readJson(req);
    const text = typeof body.text === "string" ? body.text : "";
    if (text.length > 50_000) throw new BadRequest("text is too long");
    const parsed = parseRequestBody(body, text);
    const [user] = await Promise.all([db.loadUserData(), consume(ctx, db)]);
    const started = Date.now();
    const language =
      languageCode(body.language) ??
      guessLanguageFromScript(text) ??
      (text.trim() ? "en" : undefined);
    const request: RewriteRequest = { ...parsed, language };
    request.memories = await memoriesFor(db, user, request);
    const result = await rewrite(request, user, {
      complete: ctx.complete,
      models: ctx.models,
    });
    const totalMs = Date.now() - started;
    const id =
      user.settings.store_history && body.save !== false && text.trim()
        ? crypto.randomUUID()
        : undefined;
    if (id) {
      later(ctx, () =>
        db.saveDictation({
          id,
          mode: result.mode,
          app: request.app ?? null,
          category: result.category,
          raw_text: text,
          final_text: result.text,
          label: result.label,
          latency_ms: totalMs,
          guarded: result.guarded ?? null,
        }),
      );
    }
    if (text.trim()) learnLater(ctx, db, user, text, request.memories, result);
    return json({
      ...finished(text, result, language, { total_ms: totalMs }, id),
      calls: result.calls,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function handleCheck(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const db = await ctx.db(req);
    const body = await readJson(req);
    const intent = typeof body.intent === "string" ? body.intent.trim() : "";
    const answer = typeof body.answer === "string" ? body.answer.trim() : "";
    if (!intent || !answer) throw new BadRequest("send intent and answer");
    if (intent.length > MAX_INTENT_CHARS)
      throw new BadRequest("intent is too long");
    await consume(ctx, db);
    const app = parseApp(body.app);
    const result = await checkAnswer(
      { intent, answer, appName: app?.name },
      ctx.complete,
      ctx.models.smart,
    );
    return json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function handleUsage(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const db = await ctx.db(req);
    const today = await db.usageToday();
    return json({
      today,
      daily_limit: (ctx.limits ?? DEFAULT_LIMITS).perDay,
      plan: PLAN,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function handleDeleteAccount(
  req: Request,
  ctx: Ctx,
): Promise<Response> {
  try {
    if (req.method !== "POST") throw new BadRequest("use POST");
    const db = await ctx.db(req);
    await db.deleteAccount();
    return json({ deleted: true });
  } catch (e) {
    return errorResponse(e);
  }
}

class Unavailable extends Error {}

/**
 * POST /feedback: a 👍/👎 on a result, with an optional note. Not counted in
 * the limits; capped at 30 an hour per user.
 */
export async function handleFeedback(
  req: Request,
  ctx: Ctx,
): Promise<Response> {
  try {
    const db = await ctx.db(req);
    const body = await readJson(req);
    const rating = body.rating;
    if (rating !== "up" && rating !== "down")
      throw new BadRequest('rating must be "up" or "down"');
    const dictationId = body.dictation_id;
    if (
      dictationId !== undefined &&
      dictationId !== null &&
      !isUuid(dictationId)
    )
      throw new BadRequest(
        "dictation_id must be an id from /dictate or /rewrite",
      );
    const wait = feedbackRetryAfter(await db.recentFeedback());
    if (wait > 0)
      throw new LimitError(
        "rate_limited",
        wait,
        "Thanks, that's plenty of feedback for this hour.",
      );
    const app =
      typeof body.app === "string"
        ? { name: body.app.slice(0, 200) }
        : (parseApp(body.app) ?? null);
    const stored = await db.saveFeedback({
      dictation_id: dictationId ?? null,
      rating,
      note:
        typeof body.note === "string" && body.note.trim()
          ? body.note.trim().slice(0, 1000)
          : null,
      app,
      mode: str(body.mode, 40) ?? null,
      label: str(body.label, 200) ?? null,
    });
    if (!stored) throw new Unavailable("Feedback can't be saved right now");
    return json({ ok: true });
  } catch (e) {
    if (e instanceof Unavailable)
      return json({ error: e.message, code: "provider" }, 503);
    return errorResponse(e);
  }
}

export async function handleLearn(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const db = await ctx.db(req);
    const body = (await readJson(req)) as {
      original?: string;
      edited?: string;
    };
    if (typeof body.original !== "string" || typeof body.edited !== "string")
      throw new BadRequest("send original and edited text");
    if (!body.original || !body.edited)
      throw new BadRequest("send original and edited text");
    const user = await db.loadUserData();
    const words = learnFromEdit(
      body.original.slice(0, 20_000),
      body.edited.slice(0, 20_000),
      user.dictionary,
    );
    await db.addWords(words, "learned");
    return json({ learned: words });
  } catch (e) {
    return errorResponse(e);
  }
}

export function handleOptions(): Response {
  return new Response("ok", { headers: CORS });
}
