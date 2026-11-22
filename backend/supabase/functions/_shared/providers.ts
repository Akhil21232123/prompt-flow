// Model providers: Claude (Anthropic) for every rewrite; Groq or OpenAI for
// speech-to-text. Plain fetch, no SDKs, so the same code runs in Deno and Bun.

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
      form.append("response_format", "json");
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
        const data = (await res.json()) as { text?: string };
        return { text: (data.text ?? "").trim(), provider: name };
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
