// Model providers: Claude (Anthropic) when its key is set, else Groq, for
// every rewrite; Groq or OpenAI for speech-to-text. Plain fetch, no SDKs, so the same code runs in Deno and Bun.

import { languageCode } from "./languages.ts";
import type { Complete, Transcribe } from "./types.ts";

export interface Env {
  get(name: string): string | undefined;
}

type Fetch = typeof fetch;

export const DEFAULT_FAST_MODEL = "claude-haiku-5-5";
export const DEFAULT_SMART_MODEL = "claude-sonnet-5-5";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  return body.slice(0, 300);
}

export function anthropic(env: Env, fetchImpl: Fetch = fetch): Complete {
  const key = env.get("ANTHROPIC_API_KEY");
  return async (system, user, opts = {}) => {
    if (!key) throw new ProviderError("ANTHROPIC_API_KEY is not set", 503);
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? env.get("CLAUDE_FAST_MODEL") ?? DEFAULT_FAST_MODEL,
        max_tokens: opts.maxTokens ?? 2048,
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok)
      throw new ProviderError(
        `Claude returned ${res.status}: ${await readError(res)}`,
        res.status,
      );
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    if (!text.trim())
      throw new ProviderError("Claude returned an empty reply", 502);
    return text;
  };
}

/** Groq's free text models, used until a Claude key is added. */
export const GROQ_FAST_MODEL = "openai/gpt-oss-120b";
export const GROQ_SMART_MODEL = "openai/gpt-oss-120b";
/** Tried in order when the main model is rate limited (separate quotas). */
export const GROQ_BUSY_FALLBACKS = ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"];

/** OpenAI-compatible chat on Groq. */
export function groqChat(env: Env, fetchImpl: Fetch = fetch): Complete {
  const key = env.get("GROQ_API_KEY");
  return async (system, user, opts = {}) => {
    if (!key) throw new ProviderError("GROQ_API_KEY is not set", 503);
    const call = (model: string) =>
      fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens ?? 2048,
          temperature: 0.2,
          ...(model.startsWith("openai/gpt-oss")
            ? { reasoning_effort: "low" }
            : model.startsWith("qwen/")
              ? { reasoning_format: "hidden" }
              : {}),
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
    const first = opts.model ?? GROQ_FAST_MODEL;
    let res = await call(first);
    // Groq retires models often; fall back to one that's always served.
    if (res.status === 404 && first !== GROQ_SMART_MODEL) {
      await res.body?.cancel();
      res = await call(GROQ_SMART_MODEL);
    }
    // Busy (rate limited or overloaded). Each Groq model has its own limits,
    // so try the sibling models first, then wait briefly and retry the first.
    if (res.status === 429 || res.status === 503) {
      const wait = Number(res.headers.get("retry-after"));
      await res.body?.cancel();
      for (const m of GROQ_BUSY_FALLBACKS.filter((m) => m !== first)) {
        res = await call(m);
        if (
          res.ok ||
          (res.status !== 429 && res.status !== 503 && res.status !== 404)
        )
          break;
        await res.body?.cancel();
      }
      if (!res.ok) {
        await new Promise((r) =>
          setTimeout(
            r,
            Number.isFinite(wait) && wait > 0 ? Math.min(wait, 4) * 1000 : 1500,
          ),
        );
        res = await call(first);
      }
    }
    if (!res.ok)
      throw new ProviderError(
        `Groq returned ${res.status}: ${await readError(res)}`,
        res.status,
      );
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = (data.choices?.[0]?.message?.content ?? "")
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .trim();
    if (!text) throw new ProviderError("Groq returned an empty reply", 502);
    return text;
  };
}

/** Which model family rewrites text: Claude when its key is set, else Groq. */
export function chatProvider(
  env: Env,
  fetchImpl: Fetch = fetch,
): {
  name: "claude" | "groq";
  complete: Complete;
  fast: string;
  smart: string;
} {
  if (env.get("ANTHROPIC_API_KEY"))
    return {
      name: "claude",
      complete: anthropic(env, fetchImpl),
      fast: env.get("CLAUDE_FAST_MODEL") ?? DEFAULT_FAST_MODEL,
      smart: env.get("CLAUDE_SMART_MODEL") ?? DEFAULT_SMART_MODEL,
    };
  return {
    name: "groq",
    complete: groqChat(env, fetchImpl),
    fast: env.get("GROQ_FAST_MODEL") ?? GROQ_FAST_MODEL,
    smart: env.get("GROQ_SMART_MODEL") ?? GROQ_SMART_MODEL,
  };
}

const STT = {
  groq: {
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    key: "GROQ_API_KEY",
    model: "whisper-large-v3",
  },
  openai: {
    url: "https://api.openai.com/v1/audio/transcriptions",
    key: "OPENAI_API_KEY",
    model: "gpt-4o-transcribe",
  },
} as const;

export type SttName = keyof typeof STT;

/** Configured STT providers, preferred first. */
export function sttOrder(env: Env): SttName[] {
  const preferred = (env.get("STT_PROVIDER") ?? "groq") as SttName;
  const all: SttName[] = [
    preferred,
    ...(Object.keys(STT) as SttName[]).filter((n) => n !== preferred),
  ];
  return all.filter((n) => n in STT && env.get(STT[n].key));
}

export function speechToText(env: Env, fetchImpl: Fetch = fetch): Transcribe {
  return async (audio, opts) => {
    const order = sttOrder(env);
    if (order.length === 0) {
      throw new ProviderError(
        "No speech-to-text key is set (GROQ_API_KEY or OPENAI_API_KEY)",
        503,
      );
    }
    let lastError: unknown;
    for (const name of order) {
      const p = STT[name];
      const form = new FormData();
      form.append("file", audio, "audio.wav");
      form.append(
        "model",
        env.get(`${name.toUpperCase()}_STT_MODEL`) ?? p.model,
      );
      // Whisper's verbose output says how likely each segment is to be
      // silence; gpt-4o-transcribe only does plain json.
      const verbose = name === "groq";
      form.append("response_format", verbose ? "verbose_json" : "json");
      form.append("temperature", "0");
      if (opts.language && opts.language !== "auto")
        form.append("language", opts.language);
      if (opts.prompt) form.append("prompt", opts.prompt);
      try {
        const res = await fetchImpl(p.url, {
          method: "POST",
          headers: { authorization: `Bearer ${env.get(p.key)}` },
          body: form,
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok)
          throw new ProviderError(
            `${name} returned ${res.status}: ${await readError(res)}`,
            res.status,
          );
        const data = (await res.json()) as {
          text?: string;
          language?: string;
          segments?: Array<{ no_speech_prob?: number; avg_logprob?: number }>;
        };
        const language = languageCode(data.language);
        return {
          text: (data.text ?? "").trim(),
          provider: name,
          ...(isSilent(data.segments) ? { silent: true } : {}),
          ...(language ? { language } : {}),
        };
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ProviderError(String(lastError), 502);
  };
}

/** Whisper's prompt biases spelling toward these words; it's capped near 224 tokens. */
/**
 * Whisper marks segments it thinks are not speech. When every segment is
 * likely silence (or noise decoded with very low confidence), the text is
 * invented and gets dropped.
 */
export function isSilent(
  segments:
    | Array<{ no_speech_prob?: number; avg_logprob?: number }>
    | undefined,
): boolean {
  if (!segments || segments.length === 0) return false;
  return segments.every(
    (s) =>
      (s.no_speech_prob ?? 0) > 0.6 ||
      ((s.no_speech_prob ?? 0) > 0.3 && (s.avg_logprob ?? 0) < -0.9),
  );
}

export function vocabularyPrompt(
  words: string[],
  maxChars = 600,
): string | undefined {
  let out = "";
  for (const w of words.map((x) => x.trim()).filter(Boolean)) {
    if (out.length + w.length + 2 > maxChars) break;
    out += (out ? ", " : "") + w;
  }
  return out || undefined;
}
