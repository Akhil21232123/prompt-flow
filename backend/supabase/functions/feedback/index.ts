// POST /functions/v1/feedback — a 👍/👎 (and optional note) on a result.
import { handleFeedback, handleOptions } from "../_shared/handlers.ts";
import { liveContext } from "../_shared/runtime.ts";

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const ctx = liveContext();

Deno.serve((req) =>
  req.method === "OPTIONS" ? handleOptions() : handleFeedback(req, ctx),
);
