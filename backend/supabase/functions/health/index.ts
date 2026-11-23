// GET /functions/v1/health reports which providers and features are
// configured, never the keys. Add ?check=1 to also ask Groq which models
// the key can reach and make one tiny live call per model.
import { json } from "../_shared/handlers.ts";
import { LANGUAGE_NAMES } from "../_shared/languages.ts";
import { limitsFrom } from "../_shared/limits.ts";
import { chatProvider, sttOrder } from "../_shared/providers.ts";
import { env } from "../_shared/runtime.ts";
import { adminHeaders, projectUrl } from "../_shared/supabase.ts";

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

async function groqModels(): Promise<unknown> {
  const key = env.get("GROQ_API_KEY");
  if (!key) return "no GROQ_API_KEY";
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res.ok)
    return `Groq returned ${res.status}: ${(await res.text()).slice(0, 200)}`;
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return (data.data ?? []).map((m) => m.id).sort();
}

/** Whether the v2 tables and functions exist (the migration has been run). */
async function database(): Promise<Record<string, boolean> | string> {
  const url = projectUrl(env);
  const admin = adminHeaders(env);
  if (!url || !admin) return "no secret key to check with";
  const probe = async (path: string, init: RequestInit = {}) => {
    try {
      const res = await fetch(`${url}/rest/v1/${path}`, {
        ...init,
        headers: { ...admin, "content-type": "application/json" },
        signal: AbortSignal.timeout(4000),
      });
      await res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  };
  const [memories, clarifications, usage, search] = await Promise.all([
    probe("memories?select=id&limit=0"),
    probe("clarifications?select=id&limit=0"),
    probe("usage_daily?select=day&limit=0"),
    // With no signed-in user it matches nothing, but it must exist.
    probe("rpc/match_memories", {
      method: "POST",
      body: JSON.stringify({ query: "health", match_count: 1 }),
    }),
  ]);
  return {
    memories,
    memory_search: search,
    clarifications,
    usage_daily: usage,
  };
}

Deno.serve(async (req) => {
  const chat = chatProvider(env);
  const limits = limitsFrom(env);
  const db = await database();
  const ok = (k: string) => typeof db === "object" && db[k] === true;
  const body: Record<string, unknown> = {
    ok: true,
    claude: Boolean(env.get("ANTHROPIC_API_KEY")),
    rewrite_with: chat.name,
    models: { fast: chat.fast, smart: chat.smart },
    speech_to_text: sttOrder(env),
    database: db,
    features: {
      memory: ok("memories") && ok("memory_search"),
      ask_back: ok("clarifications"),
      ai_targets: true,
      languages: Object.keys(LANGUAGE_NAMES),
      screen_context: true,
      autopilot_check: true,
      limits: ok("usage_daily")
        ? { per_minute: limits.perMinute, per_day: limits.perDay }
        : false,
      delete_account: Boolean(adminHeaders(env)),
    },
  };
  if (new URL(req.url).searchParams.get("check") === "1") {
    body.groq_models = await groqModels();
    // One tiny live call per model, so a retired model shows up here first.
    for (const [role, model] of Object.entries({
      fast: chat.fast,
      smart: chat.smart,
    })) {
      const started = Date.now();
      try {
        const reply = await chat.complete("Reply with exactly: OK", "ping", {
          model,
          maxTokens: 300,
        });
        body[`${role}_test`] = {
          reply: reply.trim().slice(0, 40),
          ms: Date.now() - started,
        };
      } catch (e) {
        body[`${role}_test`] = {
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
  }
  return json(body);
});
