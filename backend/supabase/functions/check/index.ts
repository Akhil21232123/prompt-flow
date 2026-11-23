// POST /functions/v1/check (Autopilot) — see _shared/handlers.ts for the contract.
import { handleCheck, handleOptions } from "../_shared/handlers.ts";
import { liveContext } from "../_shared/runtime.ts";

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const ctx = liveContext();

Deno.serve((req) =>
  req.method === "OPTIONS" ? handleOptions() : handleCheck(req, ctx),
);
