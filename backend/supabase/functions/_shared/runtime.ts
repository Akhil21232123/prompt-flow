// Wires handlers to the real Supabase and model providers inside Deno.

import type { Ctx } from "./handlers.ts";
import { limitsFrom } from "./limits.ts";
import { chatProvider, type Env, speechToText } from "./providers.ts";
import { authenticate, database } from "./supabase.ts";

declare const Deno: { env: { get(name: string): string | undefined } };

export const env: Env = { get: (name) => Deno.env.get(name) };

interface EdgeRuntimeApi {
  waitUntil(work: Promise<unknown>): void;
}

/**
 * Supabase keeps the worker alive for promises handed to
 * EdgeRuntime.waitUntil; elsewhere the work simply runs on its own.
 */
export function keepAlive(work: Promise<unknown>): void {
  const rt = (globalThis as { EdgeRuntime?: EdgeRuntimeApi }).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(work);
}

export function liveContext(): Ctx {
  const chat = chatProvider(env);
  return {
    db: async (req) => database(await authenticate(req, env), env),
    complete: chat.complete,
    transcribe: speechToText(env),
    models: { fast: chat.fast, smart: chat.smart },
    limits: limitsFrom(env),
    background: keepAlive,
  };
}
