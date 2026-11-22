// Wires handlers to the real Supabase and model providers inside Deno.

import type { Ctx } from "./handlers.ts";
import {
  anthropic,
  DEFAULT_FAST_MODEL,
  DEFAULT_SMART_MODEL,
  type Env,
  speechToText,
} from "./providers.ts";
import { authenticate, database } from "./supabase.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

export const env: Env = { get: (name) => Deno.env.get(name) };

export function liveContext(): Ctx {
  return {
    db: async (req) => database(await authenticate(req, env), env),
    complete: anthropic(env),
    transcribe: speechToText(env),
    models: {
      fast: env.get("CLAUDE_FAST_MODEL") ?? DEFAULT_FAST_MODEL,
      smart: env.get("CLAUDE_SMART_MODEL") ?? DEFAULT_SMART_MODEL,
    },
  };
}
