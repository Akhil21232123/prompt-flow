// Wires handlers to the real Supabase and model providers inside Deno.

import type { Ctx } from "./handlers.ts";
import { chatProvider, type Env, speechToText } from "./providers.ts";
import { authenticate, database } from "./supabase.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

export const env: Env = { get: (name) => Deno.env.get(name) };

export function liveContext(): Ctx {
  const chat = chatProvider(env);
  return {
    db: async (req) => database(await authenticate(req, env), env),
    complete: chat.complete,
    transcribe: speechToText(env),
    models: { fast: chat.fast, smart: chat.smart },
  };
}
