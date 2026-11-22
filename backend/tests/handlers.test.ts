import { describe, expect, test } from "bun:test";
import { handleDictate, handleLearn, handleRewrite, type Ctx } from "../supabase/functions/_shared/handlers.ts";
import { anthropic, speechToText, sttOrder } from "../supabase/functions/_shared/providers.ts";
import { AuthError, mergeSettings, type Db } from "../supabase/functions/_shared/supabase.ts";
import { DEFAULT_SETTINGS } from "../supabase/functions/_shared/types.ts";

function ctx(opts: { transcript?: string; reply?: string; signedIn?: boolean } = {}) {
  const saved: Array<Record<string, unknown>> = [];
  const added: string[][] = [];
  const db: Db = {
    session: { userId: "u1", token: "t" },
    loadUserData: async () => ({ settings: structuredClone(DEFAULT_SETTINGS), dictionary: ["Wispr Flow"], snippets: [] }),
    saveDictation: async (row) => void saved.push(row),
    addWords: async (w) => void added.push(w),
  };
  const sttCalls: Array<{ language?: string; prompt?: string }> = [];
  const c: Ctx = {
    db: async () => {
      if (opts.signedIn === false) throw new AuthError("Sign in to use PromptFlow");
      return db;
    },
    transcribe: async (_audio, o) => {
      sttCalls.push(o);
      return { text: opts.transcript ?? "hello there", provider: "groq" };
    },
    complete: async () => opts.reply ?? "Hello there.",
    models: { fast: "f", smart: "s" },
  };
  return { c, saved, added, sttCalls };
}

function dictateRequest(meta: Record<string, unknown>, bytes = 1000) {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "a.wav");
  form.append("meta", JSON.stringify(meta));
  return new Request("http://x/dictate", { method: "POST", body: form, headers: { authorization: "Bearer t" } });
}

describe("dictate", () => {
  test("transcribes with the dictionary as a prompt, rewrites, saves history", async () => {
    const { c, saved, sttCalls } = ctx();
    const res = await handleDictate(dictateRequest({ mode: "dictate", duration_sec: 2, app: { bundle_id: "com.whatsapp" } }), c);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.raw).toBe("hello there");
    expect(body.text).toBe("Hello there.");
    expect(body.category).toBe("personal_chat");
    expect(sttCalls[0]).toEqual({ language: "en", prompt: "Wispr Flow" });
    await Promise.resolve();
    expect(saved[0].stt_provider).toBe("groq");
  });

  test("drops a hallucinated 'Thank you.' from a short clip", async () => {
    const { c, saved } = ctx({ transcript: "Thank you." });
    const body = await (await handleDictate(dictateRequest({ duration_sec: 1.2 }), c)).json();
    expect(body.text).toBe("");
    expect(body.dropped).toBe(true);
    expect(saved.length).toBe(0);
  });

  test("signed-out callers get 401", async () => {
    const { c } = ctx({ signedIn: false });
    const res = await handleDictate(dictateRequest({}), c);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("auth");
  });

  test("rejects a bad mode and missing audio", async () => {
    const { c } = ctx();
    expect((await handleDictate(dictateRequest({ mode: "sing" }), c)).status).toBe(400);
    expect((await handleDictate(dictateRequest({}, 0), c)).status).toBe(400);
  });
});

describe("rewrite and learn", () => {
  test("rewrite returns the result with an empty guard list", async () => {
    const { c } = ctx({ reply: "Yes." });
    const req = new Request("http://x/rewrite", { method: "POST", body: JSON.stringify({ text: "yes", mode: "dictate" }) });
    const body = await (await handleRewrite(req, c)).json();
    expect(body.text).toBe("Yes.");
    expect(body.guarded).toEqual([]);
  });

  test("learn adds misheard words", async () => {
    const { c, added } = ctx();
    const req = new Request("http://x/learn", {
      method: "POST",
      body: JSON.stringify({ original: "ship on super base", edited: "ship on Supabase" }),
    });
    expect((await (await handleLearn(req, c)).json()).learned).toEqual(["Supabase"]);
    expect(added[0]).toEqual(["Supabase"]);
  });
});

describe("providers", () => {
  const env = (vars: Record<string, string>) => ({ get: (k: string) => vars[k] });

  test("Claude request shape", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }));
    }) as unknown as typeof fetch;
    const complete = anthropic(env({ ANTHROPIC_API_KEY: "sk-ant" }), fake);
    expect(await complete("sys", "hi", { model: "claude-haiku-5-5" })).toBe("ok");
    const body = JSON.parse(String(seen!.init.body));
    expect(seen!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(body).toMatchObject({ model: "claude-haiku-5-5", system: "sys", messages: [{ role: "user", content: "hi" }] });
    expect((seen!.init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant");
  });

  test("missing Claude key is a 503 provider error", async () => {
    await expect(anthropic(env({}))("s", "u")).rejects.toMatchObject({ status: 503 });
  });

  test("speech-to-text falls back from Groq to OpenAI", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      if (url.includes("groq")) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ text: " hi " }));
    }) as unknown as typeof fetch;
    const stt = speechToText(env({ GROQ_API_KEY: "g", OPENAI_API_KEY: "o" }), fake);
    expect(await stt(new Blob(["x"]), { language: "en" })).toEqual({ text: "hi", provider: "openai" });
    expect(urls.length).toBe(2);
    expect(sttOrder(env({ OPENAI_API_KEY: "o" }))).toEqual(["openai"]);
  });

  test("stored settings merge over defaults", () => {
    const s = mergeSettings({ language: "hi", engineer: { quality: "max" } });
    expect(s.language).toBe("hi");
    expect(s.engineer.quality).toBe("max");
    expect(s.engineer.min_score).toBe(9);
    expect(s.styles.email).toBe("formal");
  });
});
