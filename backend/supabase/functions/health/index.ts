// GET /functions/v1/health — reports which providers are configured, never the keys.
import { json } from "../_shared/handlers.ts";
import { sttOrder } from "../_shared/providers.ts";
import { env } from "../_shared/runtime.ts";

declare const Deno: { serve(handler: (req: Request) => Response | Promise<Response>): void };

Deno.serve(() =>
  json({
    ok: true,
    claude: Boolean(env.get("ANTHROPIC_API_KEY")),
    speech_to_text: sttOrder(env),
  }),
);
