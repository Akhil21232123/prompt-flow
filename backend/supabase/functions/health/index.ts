// GET /functions/v1/health reports which providers are configured, never the
// keys. Add ?check=1 to also ask Groq which of the models we use the key can
// reach.
import { json } from "../_shared/handlers.ts";
import { chatProvider, sttOrder } from "../_shared/providers.ts";
import { env } from "../_shared/runtime.ts";

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

Deno.serve(async (req) => {
  const chat = chatProvider(env);
  const body: Record<string, unknown> = {
    ok: true,
    claude: Boolean(env.get("ANTHROPIC_API_KEY")),
    rewrite_with: chat.name,
    models: { fast: chat.fast, smart: chat.smart },
    speech_to_text: sttOrder(env),
  };
  if (new URL(req.url).searchParams.get("check") === "1")
    body.groq_models = await groqModels();
  return json(body);
});
