// POST /functions/v1/delete_account — deletes the caller and all their rows.
import { handleDeleteAccount, handleOptions } from "../_shared/handlers.ts";
import { liveContext } from "../_shared/runtime.ts";

declare const Deno: {
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

const ctx = liveContext();

Deno.serve((req) =>
  req.method === "OPTIONS" ? handleOptions() : handleDeleteAccount(req, ctx),
);
