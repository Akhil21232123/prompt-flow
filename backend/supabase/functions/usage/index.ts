// GET /functions/v1/usage — today's request count and the daily limit.
import { handleOptions, handleUsage } from "../_shared/handlers.ts";
import { liveContext } from "../_shared/runtime.ts";

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const ctx = liveContext();

Deno.serve((req) =>
  req.method === "OPTIONS" ? handleOptions() : handleUsage(req, ctx),
);
