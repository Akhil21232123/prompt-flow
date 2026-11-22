// HTTP handlers for the edge functions. Each takes its dependencies as
// arguments so tests can run them without Supabase or model providers.
//
//   POST /dictate  multipart: audio (wav/m4a/webm), meta (JSON)
//   POST /rewrite  JSON: { text, mode, app?, selection?, style?, target? }
//   POST /learn    JSON: { original, edited }
//   GET  /health

import { isLikelyHallucination } from "./hallucination.ts";
import { learnFromEdit } from "./learn.ts";
import { rewrite, type Models } from "./pipeline.ts";
import { ProviderError, vocabularyPrompt } from "./providers.ts";
import { AuthError, type Db } from "./supabase.ts";
import type {
  AppContext,
  Complete,
  Mode,
  PromptTarget,
  RewriteRequest,
  Transcribe,
  WritingStyle,
} from "./types.ts";

export interface Ctx {
  /** Resolves the caller; throws AuthError when signed out. */
  db: (req: Request) => Promise<Db>;
  complete: Complete;
  transcribe: Transcribe;
  models: Models;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function errorResponse(e: unknown): Response {
  if (e instanceof AuthError)
    return json({ error: e.message, code: "auth" }, 401);
  if (e instanceof BadRequest)
    return json({ error: e.message, code: "bad_request" }, 400);
  if (e instanceof ProviderError) {
    const status = e.status === 429 ? 429 : 502;
    return json(
      { error: e.message, code: status === 429 ? "rate_limited" : "provider" },
      status,
    );
  }
  return json(
    { error: e instanceof Error ? e.message : String(e), code: "internal" },
    500,
  );
}

class BadRequest extends Error {}

const MODES: Mode[] = ["dictate", "engineer", "command"];
const STYLES: WritingStyle[] = ["formal", "casual", "very_casual"];

function parseRequestBody(
  raw: Record<string, unknown>,
  text: string,
): RewriteRequest {
  const mode = (raw.mode ?? "dictate") as Mode;
  if (!MODES.includes(mode)) throw new BadRequest(`unknown mode "${raw.mode}"`);
  const style = raw.style as WritingStyle | undefined;
  if (style && !STYLES.includes(style))
    throw new BadRequest(`unknown style "${style}"`);
  const app =
    raw.app && typeof raw.app === "object"
      ? (raw.app as AppContext)
      : undefined;
  if (app?.surrounding_text)
    app.surrounding_text = String(app.surrounding_text).slice(-2000);
  return {
    text,
    mode,
    app,
    selection:
      typeof raw.selection === "string"
        ? raw.selection.slice(0, 20_000)
        : undefined,
    style,
    target: raw.target as PromptTarget | undefined,
  };
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function handleDictate(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const db = await ctx.db(req);
    const form = await req.formData().catch(() => {
      throw new BadRequest("send multipart/form-data with an audio file");
    });
    const audio = form.get("audio");
    if (!(audio instanceof Blob) || audio.size === 0)
      throw new BadRequest("missing audio");
    if (audio.size > MAX_AUDIO_BYTES)
      throw new BadRequest("recording is too long (25 MB max)");
    const meta = JSON.parse(String(form.get("meta") ?? "{}")) as Record<
      string,
      unknown
    >;
    const durationSec =
      typeof meta.duration_sec === "number" ? meta.duration_sec : undefined;

    const started = Date.now();
    const user = await db.loadUserData();
    const language =
      typeof meta.language === "string"
        ? meta.language
        : user.settings.language;
    const stt = await ctx.transcribe(audio, {
      language,
      prompt: vocabularyPrompt(user.dictionary),
    });
    const sttMs = Date.now() - started;

    if (isLikelyHallucination(stt.text, durationSec)) {
      return json({
        raw: stt.text,
        text: "",
        mode: meta.mode ?? "dictate",
        label: "Nothing heard",
        dropped: true,
        timing: { stt_ms: sttMs },
      });
    }

    const request = parseRequestBody(meta, stt.text);
    const result = await rewrite(request, user, {
      complete: ctx.complete,
      models: ctx.models,
    });
    const totalMs = Date.now() - started;

    if (user.settings.store_history) {
      db.saveDictation({
        mode: result.mode,
        app: request.app ?? null,
        category: result.category,
        raw_text: stt.text,
        final_text: result.text,
        label: result.label,
        duration_ms: durationSec ? Math.round(durationSec * 1000) : null,
        stt_provider: stt.provider,
        latency_ms: totalMs,
        guarded: result.guarded ?? null,
      }).catch(() => {});
    }

    return json({
      raw: stt.text,
      text: result.text,
      mode: result.mode,
      category: result.category,
      label: result.label,
      guarded: result.guarded ?? [],
      timing: { stt_ms: sttMs, total_ms: totalMs },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function handleRewrite(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const db = await ctx.db(req);
    const body = (await req.json().catch(() => {
      throw new BadRequest("send a JSON body");
    })) as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text : "";
    if (text.length > 50_000) throw new BadRequest("text is too long");
    const user = await db.loadUserData();
    const request = parseRequestBody(body, text);
    const started = Date.now();
    const result = await rewrite(request, user, {
      complete: ctx.complete,
      models: ctx.models,
    });
    if (user.settings.store_history && body.save !== false) {
      db.saveDictation({
        mode: result.mode,
        app: request.app ?? null,
        category: result.category,
        raw_text: text,
        final_text: result.text,
        label: result.label,
        latency_ms: Date.now() - started,
        guarded: result.guarded ?? null,
      }).catch(() => {});
    }
    return json({ ...result, guarded: result.guarded ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function handleLearn(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const db = await ctx.db(req);
    const body = (await req.json()) as { original?: string; edited?: string };
    if (!body.original || !body.edited)
      throw new BadRequest("send original and edited text");
    const user = await db.loadUserData();
    const words = learnFromEdit(body.original, body.edited, user.dictionary);
    await db.addWords(words, "learned");
    return json({ learned: words });
  } catch (e) {
    return errorResponse(e);
  }
}

export function handleOptions(): Response {
  return new Response("ok", { headers: CORS });
}
