import { describe, expect, test } from "bun:test";
import {
  handleCheck,
  handleDeleteAccount,
  handleDictate,
  handleRewrite,
  handleUsage,
} from "../supabase/functions/_shared/handlers.ts";
import { rewrite } from "../supabase/functions/_shared/pipeline.ts";
import { speechToText } from "../supabase/functions/_shared/providers.ts";
import {
  adminHeaders,
  database,
  mergeSettings,
} from "../supabase/functions/_shared/supabase.ts";
import { DEFAULT_SETTINGS } from "../supabase/functions/_shared/types.ts";
import {
  type Call,
  dictateRequest,
  draft,
  review,
  fakeCtx,
  fakeDb,
  jsonRequest,
  wav,
} from "./fakes.ts";

const CLAUDE = { name: "Claude", bundle_id: "com.anthropic.claudefordesktop" };
const CHATGPT = { name: "ChatGPT", bundle_id: "com.openai.chat" };
const VAGUE = "write me a script that renames all my files";
const ASK =
  '{"ask": true, "question": "Which language should the script use?", "options": ["Python", "Bash", "Go"]}';

const architectInputs = (calls: Call[]) =>
  calls.filter((c) => c.kind === "architect").map((c) => c.user);

describe("dictate: finished response", () => {
  test("has target, label, memory_used, language and timing", async () => {
    const db = fakeDb({
      memories: [
        {
          id: "00000000-0000-4000-8000-0000000000aa",
          content: "Codes in Python and uses Supabase",
        },
      ],
    });
    const { ctx, calls, settle } = fakeCtx({
      db,
      transcript: "write a readme for my backend project please",
      sttLanguage: "english",
      replies: {
        architect: draft("Write a README for my backend, which uses Supabase."),
        critic: review(
          10,
          "Write a README for my backend, which uses Supabase.",
        ),
      },
    });
    const res = await handleDictate(
      dictateRequest({ mode: "engineer", app: CLAUDE }),
      ctx,
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      raw: "write a readme for my backend project please",
      text: expect.stringContaining(
        "<task>\nWrite a README for my backend, which uses Supabase.\n</task>",
      ),
      mode: "engineer",
      category: "ai_chat",
      label: "Prompt · for Claude",
      target: "claude",
      guarded: [],
      memory_used: [
        {
          id: "00000000-0000-4000-8000-0000000000aa",
          content: "Codes in Python and uses Supabase",
        },
      ],
      language: "en",
    });
    expect(typeof body.timing.stt_ms).toBe("number");
    expect(typeof body.timing.total_ms).toBe("number");
    // Memory is trusted context for the architect and the critic.
    expect(architectInputs(calls)[0]).toContain("Known about the user");
    expect(calls.find((c) => c.kind === "critic")!.user).toContain(
      "Codes in Python and uses Supabase",
    );
    await settle();
    expect(db.usedIds).toEqual(["00000000-0000-4000-8000-0000000000aa"]);
    expect(db.usageCalls).toEqual([{ perMinute: 20, perDay: 300 }]);
  });

  test("the server lays the same parts out per AI", async () => {
    const parts = {
      context: "I run Postgres for a SaaS app.",
      requirements: ["1. Cover token buckets", "- Mention pg_cron"],
      output_format: "A short explanation with one example.",
    };
    const apps: Array<[Record<string, string>, (t: string) => void]> = [
      [
        CLAUDE,
        (t) =>
          expect(t).toBe(
            "<task>\nExplain how rate limits work in Postgres.\n</task>\n<context>\nI run Postgres for a SaaS app.\n</context>\n<requirements>\n- Cover token buckets\n- Mention pg_cron\n</requirements>\n<output_format>\nA short explanation with one example.\n</output_format>",
          ),
      ],
      [
        CHATGPT,
        (t) =>
          expect(t).toBe(
            "### Task\nExplain how rate limits work in Postgres.\n\n### Context\nI run Postgres for a SaaS app.\n\n### Requirements\n- Cover token buckets\n- Mention pg_cron\n\n### Output format\nA short explanation with one example.",
          ),
      ],
      [
        {
          name: "Web App",
          bundle_id:
            "com.apple.Safari.WebApp.1F2E3D4C-0000-4000-8000-000000000001",
          title: "Gemini",
        },
        (t) => expect(t.startsWith("### Task\n")).toBe(true),
      ],
      [
        { name: "Perplexity", bundle_id: "ai.perplexity.mac" },
        (t) =>
          expect(t).toBe(
            "Explain how rate limits work in Postgres.\n\nInclude:\n- Cover token buckets\n- Mention pg_cron\n- A short explanation with one example.",
          ),
      ],
      [
        { name: "Cursor", bundle_id: "com.todesktop.230313mzl4w4u92" },
        (t) => {
          expect(t).toContain(
            "### Goal\nExplain how rate limits work in Postgres.",
          );
          expect(t).toContain("### Constraints\n- Cover token buckets");
          expect(t).toContain(
            "### Acceptance criteria\n- A short explanation with one example.",
          );
        },
      ],
    ];
    for (const [app, check] of apps) {
      const { ctx } = fakeCtx({
        transcript: "explain how rate limits work in postgres",
        replies: {
          architect: draft("Explain how rate limits work in Postgres.", parts),
          critic: review(
            10,
            "Explain how rate limits work in Postgres.",
            parts,
          ),
        },
      });
      const body = await (
        await handleDictate(
          dictateRequest({ mode: "engineer", app, ask_back: false }),
          ctx,
        )
      ).json();
      check(body.text);
    }
  });

  test("silence and hallucinations are dropped with a reason", async () => {
    const silent = fakeCtx({ transcript: "Thanks for watching", silent: true });
    expect(
      await (
        await handleDictate(dictateRequest({ duration_sec: 2 }), silent.ctx)
      ).json(),
    ).toMatchObject({ dropped: true, raw: "", reason: "silence" });
    const ghost = fakeCtx({ transcript: "Thank you." });
    expect(
      await (
        await handleDictate(dictateRequest({ duration_sec: 1 }), ghost.ctx)
      ).json(),
    ).toMatchObject({ dropped: true, raw: "", reason: "hallucination" });
    expect(ghost.calls).toEqual([]);
  });

  test("plain dictation never gets memory, and never asks", async () => {
    const db = fakeDb({
      memories: [{ id: "00000000-0000-4000-8000-000000000001", content: "x" }],
    });
    const { ctx, calls } = fakeCtx({
      db,
      transcript: "hey sam the meeting moved to friday afternoon",
    });
    const body = await (
      await handleDictate(
        dictateRequest({ mode: "dictate", app: { bundle_id: "com.whatsapp" } }),
        ctx,
      )
    ).json();
    expect(body.memory_used).toEqual([]);
    expect(calls.find((c) => c.kind === "polish")!.user).not.toContain(
      "Known about",
    );
    expect(calls.some((c) => c.kind === "ask")).toBe(false);
  });
});

describe("dictate: languages", () => {
  test("language codes go to Whisper; auto omits; settings are the default", async () => {
    const a = fakeCtx();
    await handleDictate(dictateRequest({ language: "te-IN" }), a.ctx);
    expect(a.sttCalls[0].language).toBe("te");
    const b = fakeCtx();
    await handleDictate(dictateRequest({ language: "auto" }), b.ctx);
    expect(b.sttCalls[0].language).toBeUndefined();
    const c = fakeCtx({ db: fakeDb({ settings: { spoken_language: "hi" } }) });
    await handleDictate(dictateRequest({}), c.ctx);
    expect(c.sttCalls[0].language).toBe("hi");
  });

  test("Hindi speech becomes an English prompt; the detected language is returned", async () => {
    const { ctx, calls } = fakeCtx({
      transcript: "मेरे लिए पांच उत्पादों की सूची बनाने वाली स्क्रिप्ट लिखो",
      sttLanguage: "hindi",
      replies: {
        architect: draft("Write a script that lists my top 5 products."),
        critic: review(10, "Write a script that lists my top 5 products."),
      },
    });
    const body = await (
      await handleDictate(
        dictateRequest({
          mode: "engineer",
          language: "auto",
          app: CHATGPT,
          ask_back: false,
        }),
        ctx,
      )
    ).json();
    expect(body.language).toBe("hi");
    expect(body.text).toContain("Write a script that lists my top 5 products.");
    expect(body.guarded).toEqual([]);
    const sys = calls.find((c) => c.kind === "architect")!.system;
    expect(sys).toContain("write the finished prompt in English");
    expect(sys).toContain("The speaker used Hindi");
  });

  test("dictation keeps the spoken language unless output_language is en", async () => {
    const same = fakeCtx({
      transcript: "कल की मीटिंग पांच बजे है",
      sttLanguage: "hindi",
    });
    await handleDictate(
      dictateRequest({ mode: "dictate", language: "hi" }),
      same.ctx,
    );
    expect(same.calls[0].system).not.toContain("in English");
    const en = fakeCtx({
      transcript: "कल की मीटिंग पांच बजे है",
      sttLanguage: "hindi",
    });
    await handleDictate(
      dictateRequest({
        mode: "dictate",
        language: "hi",
        output_language: "en",
      }),
      en.ctx,
    );
    expect(en.calls[0].system).toContain("write the result in English");
  });

  test("prompts_in_english off keeps Telugu prompts in Telugu", async () => {
    const { ctx, calls } = fakeCtx({
      db: fakeDb({ settings: { prompts_in_english: false } }),
      transcript: "నా కోసం ఒక కథ రాయి దయచేసి ఇప్పుడే",
      sttLanguage: "telugu",
    });
    await handleDictate(
      dictateRequest({ mode: "engineer", ask_back: false }),
      ctx,
    );
    expect(calls.find((c) => c.kind === "architect")!.system).not.toContain(
      "in English",
    );
  });
});

describe("dictate: ask-back", () => {
  test("a vague engineer request gets one question, stored for 10 minutes", async () => {
    const db = fakeDb();
    const { ctx } = fakeCtx({ db, transcript: VAGUE, replies: { ask: ASK } });
    const res = await handleDictate(
      dictateRequest({
        mode: "engineer",
        app: CLAUDE,
        screen: { text: "files.txt", source: "window" },
      }),
      ctx,
    );
    const body = await res.json();
    expect(body).toMatchObject({
      needs_clarification: true,
      question: "Which language should the script use?",
      options: ["Python", "Bash", "Go"],
      raw: VAGUE,
    });
    expect(body.text).toBeUndefined();
    const row = db.clarifications.get(body.clarify_session)!;
    expect(row.transcript).toBe(VAGUE);
    expect(row.meta).toMatchObject({
      mode: "engineer",
      screen: { text: "files.txt" },
    });
    const ttl = Date.parse(row.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
  });

  test("answering by text writes the prompt with the answer, without counting again", async () => {
    const db = fakeDb();
    const { ctx, calls } = fakeCtx({
      db,
      transcript: VAGUE,
      replies: {
        ask: ASK,
        architect: draft("Write a Python script that renames all my files."),
        critic: review(10, "Write a Python script that renames all my files."),
      },
    });
    const first = await (
      await handleDictate(
        dictateRequest({ mode: "engineer", app: CLAUDE }),
        ctx,
      )
    ).json();
    calls.length = 0;
    const res = await handleDictate(
      dictateRequest(
        { clarify_session: first.clarify_session, answer_text: "Python" },
        null,
      ),
      ctx,
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      raw: VAGUE,
      text: expect.stringContaining(
        "<task>\nWrite a Python script that renames all my files.\n</task>",
      ),
      mode: "engineer",
      target: "claude",
      label: "Prompt · for Claude",
    });
    expect(calls.some((c) => c.kind === "ask")).toBe(false);
    expect(architectInputs(calls)[0]).toContain("The user answered: Python");
    expect(architectInputs(calls)[0]).toContain(
      "Which language should the script use?",
    );
    expect(db.usageCalls.length).toBe(1);
    // Single use.
    const again = await handleDictate(
      dictateRequest(
        { clarify_session: first.clarify_session, answer_text: "Go" },
        null,
      ),
      ctx,
    );
    expect(again.status).toBe(400);
    expect((await again.json()).code).toBe("bad_request");
  });

  test("skipping writes the prompt straight away", async () => {
    const { ctx, calls } = fakeCtx({
      transcript: VAGUE,
      replies: { ask: ASK },
    });
    const first = await (
      await handleDictate(dictateRequest({ mode: "engineer" }), ctx)
    ).json();
    calls.length = 0;
    const body = await (
      await handleDictate(
        dictateRequest(
          { clarify_session: first.clarify_session, skip_clarify: true },
          null,
        ),
        ctx,
      )
    ).json();
    expect(body.text).toContain("Write the script.");
    expect(architectInputs(calls)[0]).not.toContain("<clarification>");
  });

  test("answering by voice transcribes the answer", async () => {
    let n = 0;
    const { ctx, calls } = fakeCtx({
      transcript: () => (n++ === 0 ? VAGUE : "bash please"),
      replies: { ask: ASK },
    });
    const first = await (
      await handleDictate(dictateRequest({ mode: "engineer" }), ctx)
    ).json();
    const body = await (
      await handleDictate(
        dictateRequest({ clarify_session: first.clarify_session }),
        ctx,
      )
    ).json();
    expect(body.text).toContain("Write the script.");
    expect(architectInputs(calls).at(-1)).toContain(
      "The user answered: bash please",
    );
  });

  test("expired or unknown sessions are a clear 400", async () => {
    const db = fakeDb();
    const { ctx } = fakeCtx({ db, transcript: VAGUE, replies: { ask: ASK } });
    const first = await (
      await handleDictate(dictateRequest({ mode: "engineer" }), ctx)
    ).json();
    db.clarifications.get(first.clarify_session)!.expires_at = new Date(
      Date.now() - 1000,
    ).toISOString();
    const res = await handleDictate(
      dictateRequest(
        { clarify_session: first.clarify_session, answer_text: "Python" },
        null,
      ),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("expired");
    const missing = await handleDictate(
      dictateRequest({ clarify_session: "nope" }, null),
      ctx,
    );
    expect(missing.status).toBe(400);
  });

  test("never asks outside engineer mode, when switched off, or for short requests", async () => {
    const cases: Array<
      [Record<string, unknown>, string, Partial<typeof DEFAULT_SETTINGS>?]
    > = [
      [{ mode: "dictate", app: CHATGPT }, VAGUE],
      [{ mode: "command" }, VAGUE],
      [{ mode: "engineer", ask_back: false }, VAGUE],
      [{ mode: "engineer" }, VAGUE, { ask_back: false }],
      [{ mode: "engineer" }, "write a script"],
    ];
    for (const [meta, transcript, settings] of cases) {
      const { ctx, calls } = fakeCtx({
        db: fakeDb({ settings }),
        transcript,
        replies: { ask: ASK },
      });
      const body = await (
        await handleDictate(dictateRequest(meta), ctx)
      ).json();
      expect(body.needs_clarification).toBeUndefined();
      expect(calls.some((c) => c.kind === "ask")).toBe(false);
    }
  });

  test("a failing decision or a missing table falls back to the prompt", async () => {
    const broken = fakeCtx({
      transcript: VAGUE,
      replies: { ask: "garbage {" },
    });
    expect(
      (
        await (
          await handleDictate(dictateRequest({ mode: "engineer" }), broken.ctx)
        ).json()
      ).text,
    ).toContain("Write the script.");
    const noTable = fakeCtx({
      db: fakeDb({ noClarifications: true }),
      transcript: VAGUE,
      replies: { ask: ASK },
    });
    expect(
      (
        await (
          await handleDictate(dictateRequest({ mode: "engineer" }), noTable.ctx)
        ).json()
      ).text,
    ).toContain("Write the script.");
  });

  test("audio is required unless answering", async () => {
    const { ctx } = fakeCtx();
    const res = await handleDictate(
      dictateRequest({ mode: "engineer" }, null),
      ctx,
    );
    expect(res.status).toBe(400);
    const noAnswer = await handleDictate(
      dictateRequest(
        { clarify_session: "00000000-0000-4000-8000-000000000001" },
        null,
      ),
      ctx,
    );
    expect(noAnswer.status).toBe(400);
  });
});

describe("dictate: this, memory learning, limits", () => {
  test("screen text is context the prompt is about, and trusted", async () => {
    const screen = "Error: connection refused on port 5432 after 30 retries";
    const { ctx, calls } = fakeCtx({
      transcript: "explain this error and how to fix it",
      replies: {
        architect: draft("Explain the error below and how to fix it."),
        critic: review(
          10,
          "Explain the error below and how to fix it. It mentions port 5432.",
        ),
      },
    });
    const body = await (
      await handleDictate(
        dictateRequest({
          mode: "engineer",
          app: CHATGPT,
          ask_back: false,
          screen: { text: screen + "x".repeat(9000), source: "window" },
        }),
        ctx,
      )
    ).json();
    expect(body.guarded).toEqual([]);
    expect(body.text).toContain("5432");
    const input = architectInputs(calls)[0];
    expect(input).toContain("<screen_text>");
    expect(input).toContain("they mean the text on their screen");
    expect(input.length).toBeLessThan(10_000);
  });

  test("facts are learned in the background, never when memory is off", async () => {
    const reply =
      '{"memories": [{"content": "Building PromptFlow in Swift and Kotlin", "kind": "project"}, {"content": "My PIN is 4321"}]}';
    const on = fakeCtx({
      transcript:
        "I'm building PromptFlow in Swift and Kotlin, write the release notes",
      replies: { extract: reply },
    });
    await handleDictate(dictateRequest({ mode: "dictate" }), on.ctx);
    await on.settle();
    expect(on.db.newMemories).toEqual([
      { content: "Building PromptFlow in Swift and Kotlin", kind: "project" },
    ]);
    expect(on.calls.find((c) => c.kind === "extract")!.model).toBe(
      "fast-model",
    );
    const off = fakeCtx({
      db: fakeDb({ settings: { memory_enabled: false } }),
      transcript:
        "I'm building PromptFlow in Swift and Kotlin, write the release notes",
      replies: { extract: reply },
    });
    await handleDictate(
      dictateRequest({ mode: "engineer", ask_back: false }),
      off.ctx,
    );
    await off.settle();
    expect(off.db.newMemories).toEqual([]);
    expect(off.db.memoryQueries).toEqual([]);
    expect(off.calls.some((c) => c.kind === "extract")).toBe(false);
  });

  test("limits refuse with code and retry_after_sec", async () => {
    for (const code of ["rate_limited", "quota"] as const) {
      const { ctx, sttCalls } = fakeCtx({
        db: fakeDb({
          usage: { allowed: false, code, today: 300, retry_after_sec: 42 },
        }),
      });
      const res = await handleDictate(dictateRequest({}), ctx);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("42");
      expect(await res.json()).toMatchObject({ code, retry_after_sec: 42 });
      expect(sttCalls).toEqual([]);
      const rw = await handleRewrite(
        jsonRequest("rewrite", { text: "hi" }),
        ctx,
      );
      expect(rw.status).toBe(429);
      const ck = await handleCheck(
        jsonRequest("check", { intent: "a", answer: "b" }),
        ctx,
      );
      expect(ck.status).toBe(429);
    }
  });

  test("recordings over 6 minutes are refused", async () => {
    const { ctx, sttCalls } = fakeCtx();
    expect(
      (await handleDictate(dictateRequest({ duration_sec: 400 }), ctx)).status,
    ).toBe(400);
    expect(
      (await handleDictate(dictateRequest({}, wav(370)), ctx)).status,
    ).toBe(400);
    expect(sttCalls).toEqual([]);
    expect(
      (await handleDictate(dictateRequest({ duration_sec: 359 }, wav(2)), ctx))
        .status,
    ).toBe(200);
  });

  test("bad meta is a 400, not a crash", async () => {
    const { ctx } = fakeCtx();
    const form = new FormData();
    form.append(
      "audio",
      new Blob([wav(1) as Uint8Array<ArrayBuffer>]),
      "a.wav",
    );
    form.append("meta", "{not json");
    const res = await handleDictate(
      new Request("http://x", { method: "POST", body: form }),
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("rewrite", () => {
  test("returns response 1 with memory, screen and target", async () => {
    const { ctx, calls, settle, db } = fakeCtx({
      replies: {
        architect: draft("Summarise this for me."),
        critic: review(10, "Summarise this for me."),
      },
    });
    const body = await (
      await handleRewrite(
        jsonRequest("rewrite", {
          text: "summarise this for me in plain words",
          mode: "engineer",
          app: { name: "Gemini" },
          screen: { text: "A long article", source: "selection" },
        }),
        ctx,
      )
    ).json();
    expect(body).toMatchObject({
      raw: "summarise this for me in plain words",
      text: expect.stringContaining("### Task\nSummarise this for me."),
      target: "gemini",
      label: "Prompt · for Gemini",
      memory_used: [],
      language: "en",
    });
    expect(architectInputs(calls)[0]).toContain("the text they selected");
    await settle();
    expect(db.saved.length).toBe(1);
    expect(db.usageCalls.length).toBe(1);
  });

  test("command mode gets memory and screen text", async () => {
    const { ctx, calls } = fakeCtx({
      db: fakeDb({
        memories: [
          {
            id: "00000000-0000-4000-8000-000000000009",
            content: "Director at IP Group",
          },
        ],
      }),
    });
    await handleRewrite(
      jsonRequest("rewrite", {
        text: "write a short bio for me",
        mode: "command",
        screen: { text: "LinkedIn profile page" },
      }),
      ctx,
    );
    const w = calls.find((c) => c.kind === "write")!;
    expect(w.user).toContain("Director at IP Group");
    expect(w.user).toContain("LinkedIn profile page");
  });
});

describe("check, usage, delete_account", () => {
  test("check returns good or missed with a follow-up, using the smart model", async () => {
    const good = fakeCtx();
    expect(
      await (
        await handleCheck(
          jsonRequest("check", {
            intent: "write it in python",
            answer: "def f(): pass",
            app: { name: "Claude" },
          }),
          good.ctx,
        )
      ).json(),
    ).toEqual({ verdict: "good", issues: [] });
    expect(good.calls[0].model).toBe("smart-model");
    expect(good.calls[0].user).toContain("The AI: Claude");
    const missed = fakeCtx({
      replies: {
        check:
          '{"verdict":"missed","issues":["Used JavaScript; you asked for Python"],"follow_up":"Please rewrite it in Python."}',
      },
    });
    expect(
      await (
        await handleCheck(
          jsonRequest("check", {
            intent: "write it in python",
            answer: "function f() {}",
          }),
          missed.ctx,
        )
      ).json(),
    ).toEqual({
      verdict: "missed",
      issues: ["Used JavaScript; you asked for Python"],
      follow_up: "Please rewrite it in Python.",
    });
  });

  test("check validates input", async () => {
    const { ctx } = fakeCtx();
    expect(
      (await handleCheck(jsonRequest("check", { intent: "x" }), ctx)).status,
    ).toBe(400);
    expect(
      (
        await handleCheck(
          new Request("http://x", { method: "POST", body: "nope" }),
          ctx,
        )
      ).status,
    ).toBe(400);
  });

  test("usage and delete_account", async () => {
    const { ctx, db } = fakeCtx();
    expect(
      await (await handleUsage(jsonRequest("usage", null, "GET"), ctx)).json(),
    ).toEqual({
      today: 37,
      daily_limit: 300,
      plan: "beta",
    });
    expect(
      (
        await handleDeleteAccount(
          jsonRequest("delete_account", null, "GET"),
          ctx,
        )
      ).status,
    ).toBe(400);
    expect(db.deleted).toBe(false);
    expect(
      await (
        await handleDeleteAccount(jsonRequest("delete_account", {}), ctx)
      ).json(),
    ).toEqual({
      deleted: true,
    });
    expect(db.deleted).toBe(true);
  });
});

describe("REST layer", () => {
  const env = (vars: Record<string, string>) => ({
    get: (k: string) => vars[k],
  });
  const base = {
    SUPABASE_URL: "https://p.supabase.co",
    SUPABASE_ANON_KEY: "anon",
  };
  const session = {
    userId: "00000000-0000-4000-8000-000000000001",
    token: "jwt",
  };

  function recorder(respond: (url: string, init: RequestInit) => Response) {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      seen.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof fetch;
    return { seen, f };
  }

  test("missing v2 tables degrade instead of failing", async () => {
    const { f } = recorder(
      () => new Response('{"code":"PGRST205"}', { status: 404 }),
    );
    const db = database(session, env(base), f);
    expect(await db.consumeUsage({ perMinute: 20, perDay: 300 })).toEqual({
      allowed: true,
      today: 0,
    });
    expect(await db.usageToday()).toBe(0);
    expect(await db.findMemories("x", 6)).toEqual([]);
    expect(
      await db.createClarification({
        transcript: "t",
        question: "q",
        options: [],
        meta: {},
        expires_at: "x",
      }),
    ).toBeUndefined();
    expect(
      await db.takeClarification("00000000-0000-4000-8000-000000000002"),
    ).toBeUndefined();
    await db.saveMemories([{ content: "a", kind: "fact" }]);
    await db.markMemoriesUsed(["00000000-0000-4000-8000-000000000002"]);
  });

  test("usage RPC is called with the limits and its refusal is passed on", async () => {
    const { seen, f } = recorder(
      () =>
        new Response(
          JSON.stringify({
            allowed: false,
            code: "quota",
            today: 300,
            retry_after_sec: 100,
          }),
        ),
    );
    const d = await database(session, env(base), f).consumeUsage({
      perMinute: 20,
      perDay: 300,
    });
    expect(d).toEqual({
      allowed: false,
      code: "quota",
      today: 300,
      retry_after_sec: 100,
    });
    expect(seen[0].url).toBe("https://p.supabase.co/rest/v1/rpc/consume_usage");
    expect(JSON.parse(String(seen[0].init.body))).toEqual({
      daily_limit: 300,
      minute_limit: 20,
    });
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe(
      "Bearer jwt",
    );
  });

  test("memories: search RPC, upsert ignoring duplicates, trim past 300", async () => {
    const id = "00000000-0000-4000-8000-0000000000ab";
    const { seen, f } = recorder((url, init) => {
      if (url.includes("match_memories"))
        return new Response(
          JSON.stringify([
            { id, content: "Uses Supabase", pinned: false },
            { id: "bad", content: "x" },
          ]),
        );
      if (url.includes("offset=300"))
        return new Response(JSON.stringify([{ id }]));
      return new Response(init.method === "POST" ? "" : "[]", {
        status: init.method === "POST" ? 201 : 200,
      });
    });
    const db = database(session, env(base), f);
    expect(await db.findMemories("supabase", 6)).toEqual([
      { id, content: "Uses Supabase", pinned: false },
    ]);
    await db.saveMemories([{ content: "Uses Supabase", kind: "fact" }]);
    const save = seen.find((s) =>
      s.url.includes("on_conflict=user_id,content_key"),
    )!;
    expect((save.init.headers as Record<string, string>).prefer).toContain(
      "ignore-duplicates",
    );
    expect(JSON.parse(String(save.init.body))).toEqual([
      {
        user_id: session.userId,
        content: "Uses Supabase",
        kind: "fact",
        source: "auto",
      },
    ]);
    const del = seen.find((s) => s.init.method === "DELETE")!;
    expect(del.url).toBe(
      `https://p.supabase.co/rest/v1/memories?id=in.(${id})`,
    );
  });

  test("clarifications are taken with one DELETE that checks expiry", async () => {
    const id = "00000000-0000-4000-8000-0000000000cd";
    const { seen, f } = recorder(
      () =>
        new Response(
          JSON.stringify([
            { id, transcript: "t", question: "q", options: null, meta: null },
          ]),
        ),
    );
    const row = await database(session, env(base), f).takeClarification(id);
    expect(row).toMatchObject({ id, transcript: "t", options: [], meta: {} });
    expect(seen[0].init.method).toBe("DELETE");
    expect(seen[0].url).toContain(`id=eq.${id}&expires_at=gt.`);
    const none = recorder(() => new Response("[]"));
    expect(
      await database(session, env(base), none.f).takeClarification(
        "not-a-uuid",
      ),
    ).toBeUndefined();
    expect(none.seen).toEqual([]);
  });

  test("delete_account uses the secret key the right way", async () => {
    expect(
      adminHeaders(env({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}' })),
    ).toEqual({
      apikey: "sb_secret_x",
    });
    expect(adminHeaders(env({ SUPABASE_SERVICE_ROLE_KEY: "eyJabc" }))).toEqual({
      apikey: "eyJabc",
      authorization: "Bearer eyJabc",
    });
    expect(adminHeaders(env({ SUPABASE_SECRET_KEYS: "junk" }))).toBeUndefined();
    const { seen, f } = recorder(() => new Response(null, { status: 200 }));
    await database(
      session,
      env({ ...base, SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}' }),
      f,
    ).deleteAccount();
    expect(seen[0].url).toBe(
      `https://p.supabase.co/auth/v1/admin/users/${session.userId}`,
    );
    expect(seen[0].init.method).toBe("DELETE");
    expect(seen[0].init.headers).toEqual({ apikey: "sb_secret_x" });
    const gone = recorder(() => new Response("", { status: 404 }));
    await database(
      session,
      env({ ...base, SUPABASE_SECRET_KEYS: '{"a":"sb_secret_y"}' }),
      gone.f,
    ).deleteAccount();
    const fail = recorder(() => new Response("", { status: 500 }));
    await expect(
      database(
        session,
        env({ ...base, SUPABASE_SECRET_KEYS: '{"a":"sb_secret_y"}' }),
        fail.f,
      ).deleteAccount(),
    ).rejects.toThrow();
    await expect(
      database(session, env(base), fail.f).deleteAccount(),
    ).rejects.toThrow("secret key");
  });

  test("settings: new defaults, and old 'language' becomes the spoken language", () => {
    const s = mergeSettings({ language: "hi" });
    expect(s).toMatchObject({
      memory_enabled: true,
      ask_back: true,
      spoken_language: "hi",
      prompts_in_english: true,
      custom_style: "",
    });
    expect(
      mergeSettings({ spoken_language: "te", memory_enabled: false })
        .spoken_language,
    ).toBe("te");
    expect(mergeSettings(null).spoken_language).toBe("en");
    expect(mergeSettings({ memory_enabled: false }).memory_enabled).toBe(false);
  });

  test("Whisper's detected language comes back as a code", async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({ text: "नमस्ते", language: "hindi", segments: [] }),
      )) as unknown as typeof fetch;
    const stt = speechToText(env({ GROQ_API_KEY: "g" }), f);
    expect(await stt(new Blob(["x"]), {})).toEqual({
      text: "नमस्ते",
      provider: "groq",
      language: "hi",
    });
  });
});

describe("pipeline v2", () => {
  const user = () => ({
    settings: structuredClone(DEFAULT_SETTINGS),
    dictionary: [],
    snippets: [],
  });

  test("a number from memory is not an invention", async () => {
    const replies = [
      draft("Plan my 3 product launches."),
      review(10, "Plan my 3 product launches."),
    ];
    const out = await rewrite(
      {
        text: "plan my product launches",
        mode: "engineer",
        memories: [
          { id: "m1", content: "Has 3 product launches planned for 2027" },
        ],
      },
      user(),
      {
        complete: async () => replies.shift()!,
        models: { fast: "f", smart: "s" },
      },
    );
    expect(out.guarded).toBeUndefined();
    expect(out.text).toContain("Plan my 3 product launches.");
    expect(out.memory_used).toEqual([
      { id: "m1", content: "Has 3 product launches planned for 2027" },
    ]);
  });

  test("Midjourney: --ar 16:9 passes when a shape was said, is blocked otherwise", async () => {
    const run = (text: string) => {
      const replies = [
        draft(
          "",
          { prose: "Jaipur at dusk, warm light --ar 16:9" },
          "image_generation",
        ),
        review(10, "", { prose: "Jaipur at dusk, warm light --ar 16:9" }),
        review(10, "", { prose: "Jaipur at dusk, warm light" }),
      ];
      return rewrite(
        {
          text,
          mode: "engineer",
          app: { url: "https://www.midjourney.com/imagine" },
        },
        user(),
        {
          complete: async () => replies.shift()!,
          models: { fast: "f", smart: "s" },
        },
      );
    };
    const wide = await run("a landscape shot of jaipur at dusk");
    expect(wide.text).toContain("--ar 16:9");
    expect(wide.target).toBe("midjourney");
    const plain = await run("a shot of jaipur at dusk");
    expect(plain.text).toBe("Jaipur at dusk, warm light");
    expect(plain.guarded).toEqual(["number 16", "number 9"]);
  });

  test("an engineer fallback to polish stays in English for a Hindi request", async () => {
    const systems: string[] = [];
    const out = await rewrite(
      { text: "एक रिपोर्ट लिखो", mode: "engineer", language: "hi" },
      user(),
      {
        complete: async (system, _u, o) => {
          systems.push(system);
          if (o?.model === "s") throw new Error("down");
          return "Write a report.";
        },
        models: { fast: "f", smart: "s" },
      },
    );
    expect(out.text).toBe("Write a report.");
    expect(systems.at(-1)).toContain("write the result in English");
  });
});
