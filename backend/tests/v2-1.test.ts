// Round two: deterministic prompt layout, enumerator-safe fidelity guard,
// browser web apps, plain labels, dictation ids and /feedback.

import { describe, expect, test } from "bun:test";
import { classify } from "../supabase/functions/_shared/categories.ts";
import {
  findInventions,
  stripEnumerators,
} from "../supabase/functions/_shared/fidelity.ts";
import {
  handleDictate,
  handleFeedback,
  handleRewrite,
} from "../supabase/functions/_shared/handlers.ts";
import { feedbackRetryAfter } from "../supabase/functions/_shared/limits.ts";
import {
  KEPT_WORDS_ERROR_LABEL,
  rewrite,
} from "../supabase/functions/_shared/pipeline.ts";
import * as P from "../supabase/functions/_shared/prompts.ts";
import {
  cleanItem,
  parseDraft,
  parseReview,
  type PromptParts,
  renderPrompt,
  withJsonReply,
} from "../supabase/functions/_shared/structured.ts";
import { database } from "../supabase/functions/_shared/supabase.ts";
import { detectTarget } from "../supabase/functions/_shared/targets.ts";
import { DEFAULT_SETTINGS } from "../supabase/functions/_shared/types.ts";
import {
  dictateRequest,
  draft,
  fakeCtx,
  fakeDb,
  jsonRequest,
  review,
} from "./fakes.ts";

const PARTS: PromptParts = {
  task: "Write a PRD for the PromptFlow Mac app.",
  context: "It's for the first 100 beta users.",
  requirements: ["Cover onboarding", "Keep it under two pages"],
  output_format: "A Markdown document with headings.",
  acceptance_criteria: [],
  examples: [],
  prose: "",
};

describe("structured prompts: parsing", () => {
  test("reads the JSON draft, tolerating fences, nesting and other keys", () => {
    expect(
      parseDraft("```json\n" + draft("Do it", {}, "writing") + "\n```"),
    ).toEqual({
      parts: {
        task: "Do it",
        context: "",
        requirements: [],
        output_format: "",
        acceptance_criteria: [],
        examples: [],
        prose: "",
      },
      target: "writing",
    });
    const nested = parseDraft(
      JSON.stringify({
        target: "Coding Agent",
        prompt: {
          goal: "Fix the crash",
          constraints: "1. Keep the API\n2) Add a test",
          success_criteria: ["- tests pass"],
          format: "a diff",
        },
      }),
    )!;
    expect(nested.target).toBe("coding_agent");
    expect(nested.parts.task).toBe("Fix the crash");
    expect(nested.parts.requirements).toEqual(["Keep the API", "Add a test"]);
    expect(nested.parts.acceptance_criteria).toEqual(["tests pass"]);
    expect(nested.parts.output_format).toBe("a diff");
    expect(
      parseDraft('{"prose": "a red fox", "target": "image"}')?.parts.prose,
    ).toBe("a red fox");
  });

  test("junk, empty prompts and old tag replies are not drafts", () => {
    for (const r of [
      "",
      "Sure, here's your prompt",
      "<target>writing</target><prompt>Write it</prompt>",
      '{"task": ""}',
      '{"requirements": ["x"]}',
      "[1, 2]",
      "{",
    ])
      expect(parseDraft(r)).toBeUndefined();
  });

  test("reviews give a clamped score and the improved parts", () => {
    expect(parseReview(review(9, "Better"))).toMatchObject({
      score: 9,
      parts: { task: "Better" },
    });
    expect(parseReview('{"score": 42}')).toEqual({
      score: 10,
      parts: undefined,
    });
    expect(parseReview("no")).toEqual({});
  });

  test("enumerators are stripped from items", () => {
    for (const [raw, clean] of [
      ["1. Cover onboarding", "Cover onboarding"],
      ["2) Add a test", "Add a test"],
      ["(3) Keep it short", "Keep it short"],
      ["[4] Cite sources", "Cite sources"],
      ["- Bullet", "Bullet"],
      ["• Dot", "Dot"],
      ["Step 5: Ship it", "Ship it"],
      ["**6.** Bold number", "Bold number"],
      ["1. - Doubled", "Doubled"],
      ["5 products max", "5 products max"],
      ["1.5x speed", "1.5x speed"],
    ])
      expect(cleanItem(raw)).toBe(clean);
  });

  test("the desktop's tag reply shape is swapped for JSON", () => {
    const sys = P.architectSystem(DEFAULT_SETTINGS.engineer, "", false);
    expect(sys).not.toContain("Reply in exactly this shape");
    expect(sys).not.toContain("<prompt>");
    expect(sys).toContain('"task"');
    const critic = P.criticSystem(DEFAULT_SETTINGS.engineer, "", false);
    expect(critic).toContain('{"score": N');
    expect(withJsonReply("base", "SPEC")).toBe("base\n\nSPEC");
  });
});

describe("structured prompts: rendering", () => {
  test("Claude: exactly the four XML sections, examples only when given", () => {
    expect(renderPrompt(PARTS, "xml")).toBe(
      "<task>\nWrite a PRD for the PromptFlow Mac app.\n</task>\n<context>\nIt's for the first 100 beta users.\n</context>\n<requirements>\n- Cover onboarding\n- Keep it under two pages\n</requirements>\n<output_format>\nA Markdown document with headings.\n</output_format>",
    );
    const withEx = renderPrompt(
      { ...PARTS, examples: ["Like Linear's PRDs"] },
      "xml",
    );
    expect(
      withEx.endsWith(
        "<examples>\n<example>\nLike Linear's PRDs\n</example>\n</examples>",
      ),
    ).toBe(true);
  });

  test("every section is always there, with neutral filler", () => {
    const bare = renderPrompt(
      { ...PARTS, context: "", requirements: [], output_format: "" },
      "xml",
    );
    for (const tag of [
      "<task>",
      "<context>",
      "<requirements>",
      "<output_format>",
    ])
      expect(bare).toContain(tag);
    expect(findInventions("write a prd", bare)).toEqual([]);
    const md = renderPrompt({ ...PARTS, context: "" }, "markdown");
    expect(md).toContain("### Context\nNo further background was given.");
  });

  test("Markdown, search, coding, plain and prose forms", () => {
    expect(renderPrompt(PARTS, "markdown")).toBe(
      "### Task\nWrite a PRD for the PromptFlow Mac app.\n\n### Context\nIt's for the first 100 beta users.\n\n### Requirements\n- Cover onboarding\n- Keep it under two pages\n\n### Output format\nA Markdown document with headings.",
    );
    expect(renderPrompt(PARTS, "search")).toBe(
      "Write a PRD for the PromptFlow Mac app.\n\nInclude:\n- Cover onboarding\n- Keep it under two pages\n- A Markdown document with headings.",
    );
    const code = renderPrompt(
      { ...PARTS, acceptance_criteria: ["It builds"] },
      "coding",
    );
    expect(code).toBe(
      "### Goal\nWrite a PRD for the PromptFlow Mac app.\n\n### Context\nIt's for the first 100 beta users.\n\n### Constraints\n- Cover onboarding\n- Keep it under two pages\n\n### Acceptance criteria\n- It builds",
    );
    expect(renderPrompt(PARTS, "plain")).toContain(
      "Requirements:\n- Cover onboarding",
    );
    expect(
      renderPrompt({ ...PARTS, prose: "A fox at dawn --ar 16:9" }, "prose"),
    ).toBe("A fox at dawn --ar 16:9");
    expect(renderPrompt({ ...PARTS, requirements: [] }, "prose")).toBe(
      "Write a PRD for the PromptFlow Mac app. It's for the first 100 beta users.",
    );
  });

  test("screen text is attached verbatim, per layout", () => {
    const screen = {
      text: "TypeError: x is undefined",
      source: "window" as const,
    };
    expect(renderPrompt(PARTS, "xml", screen)).toContain(
      "</context>\n<screen_text>\nTypeError: x is undefined\n</screen_text>\n<requirements>",
    );
    expect(
      renderPrompt(PARTS, "markdown", { text: "a ``` b", source: "selection" }),
    ).toContain("### Selected text\n````\na ``` b\n````");
    expect(renderPrompt(PARTS, "search", screen)).toContain(
      'About this text:\n"""\nTypeError',
    );
  });
});

describe("fidelity guard: enumeration isn't invention", () => {
  const said =
    "explain the difference between option space and control option p in two sections, first a brief answer and then the details";
  test("real cases from the beta", () => {
    for (const out of [
      "1. **Brief answer**: what each shortcut does.\n2. **Details**: when to use which.",
      "Answer in two sections: 1. a brief answer 2. the details.",
      "Step 1: explain ⌥Space. Step 2: explain ⌃⌥P.",
      "Write (1) a brief answer and (2) the details.",
      "#1 is the brief answer.",
      "Section 6 covers edge cases.",
      "### 1. Brief answer\n### 2. Details",
      "- 3) a third point",
      "**1.** Brief answer",
      "Answer: 3. Then details.",
      "The 1st part is brief.",
    ])
      expect(findInventions(said, out)).toEqual([]);
  });

  test("real numbers still count", () => {
    expect(findInventions(said, "Give 5 examples.")).toEqual(["number 5"]);
    expect(findInventions(said, "It costs 7. Then pay.")).toEqual(["number 7"]);
    expect(findInventions(said, "Keep it under 20 words.")).toEqual([
      "number 20",
    ]);
    expect(findInventions(said, "Step 12: ship.")).toEqual(["number 12"]);
    expect(findInventions(said, "Aim for 99% accuracy.")).toEqual([
      "number 99",
    ]);
  });

  test("stripping leaves the words", () => {
    expect(stripEnumerators("Section 6 covers it")).toBe("Section covers it");
  });
});

describe("browser web apps", () => {
  test("Safari and Chromium web apps read like browsers", () => {
    const gemini = {
      name: "Web App",
      bundle_id: "com.apple.Safari.WebApp.1F2E3D4C-5B6A-4798-8000-0123456789AB",
      title: "Gemini",
    };
    expect(classify(gemini)).toBe("ai_chat");
    expect(detectTarget(gemini)?.id).toBe("gemini");
    expect(
      detectTarget({
        bundle_id: "com.google.Chrome.app.abcdefghijklmnop",
        url: "https://chatgpt.com/",
      })?.id,
    ).toBe("chatgpt");
    expect(
      detectTarget({
        bundle_id: "com.microsoft.edgemac.app.xyz",
        title: "Microsoft Copilot",
      })?.id,
    ).toBe("copilot");
    expect(
      detectTarget({ bundle_id: "com.brave.Browser.app.qq", name: "Claude" })
        ?.id,
    ).toBe("claude");
    for (const title of ["DeepSeek - Into the Unknown", "Grok", "Perplexity"])
      expect(
        detectTarget({
          bundle_id: "com.apple.Safari.WebApp.X",
          name: "Web App",
          title,
        }),
      ).toBeDefined();
  });

  test("a web app with nothing to go on has no target", () => {
    const anon = { name: "Web App", bundle_id: "com.apple.Safari.WebApp.ABC" };
    expect(classify(anon)).toBe("other");
    expect(detectTarget(anon)).toBeUndefined();
  });
});

describe("plain labels and shortcut semantics", () => {
  const user = () => ({
    settings: structuredClone(DEFAULT_SETTINGS),
    dictionary: [],
    snippets: [],
  });
  const deps = (reply: string | (() => string)) => ({
    complete: async () => (typeof reply === "function" ? reply() : reply),
    models: { fast: "f", smart: "s" },
  });

  test("cleanup says what it did, in plain words", async () => {
    const mail = await rewrite(
      {
        text: "hi sam see you friday",
        mode: "dictate",
        app: { bundle_id: "com.google.android.gm" },
      },
      user(),
      deps("Hi Sam, see you Friday."),
    );
    expect(mail.label).toBe("Cleaned up · formal");
    const chat = await rewrite(
      {
        text: "yo see you friday",
        mode: "dictate",
        app: { bundle_id: "com.whatsapp" },
      },
      user(),
      deps("yo see you friday"),
    );
    expect(chat.label).toBe("Cleaned up · casual");
    const preset = await rewrite(
      { text: "see you friday", mode: "dictate", preset: "formal" },
      user(),
      deps("See you on Friday."),
    );
    expect(preset.label).toBe("Style · Formal");
  });

  test("dictation never becomes a prompt by default, even long, in ChatGPT", async () => {
    const out = await rewrite(
      {
        text: "write me a detailed plan for launching the beta to a hundred users next week",
        mode: "dictate",
        app: { bundle_id: "com.openai.chat" },
      },
      user(),
      deps(
        "Write me a detailed plan for launching the beta to a hundred users next week.",
      ),
    );
    expect(out.mode).toBe("dictate");
    expect(DEFAULT_SETTINGS.engineer.auto_in_ai_apps).toBe(false);
  });

  test("an engineer model failure keeps the user's words, labelled plainly", async () => {
    const out = await rewrite(
      { text: "write a prd for my food app", mode: "engineer" },
      user(),
      {
        complete: async (_s, _u, o) => {
          if (o?.model === "s") throw new Error("down");
          return "Write a PRD.";
        },
        models: { fast: "f", smart: "s" },
      },
    );
    expect(out.label).toBe(KEPT_WORDS_ERROR_LABEL);
  });
});

describe("dictation ids and /feedback", () => {
  const UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test("finished responses carry the stored row's id", async () => {
    const { ctx, db, settle } = fakeCtx();
    const body = await (await handleDictate(dictateRequest({}), ctx)).json();
    expect(body.id).toMatch(UUID);
    const rw = await (
      await handleRewrite(jsonRequest("rewrite", { text: "hello there" }), ctx)
    ).json();
    expect(rw.id).toMatch(UUID);
    await settle();
    expect(db.saved.map((r) => r.id)).toEqual([body.id, rw.id]);
  });

  test("no id when history is off", async () => {
    const { ctx, db, settle } = fakeCtx({
      db: fakeDb({ settings: { store_history: false } }),
    });
    const body = await (await handleDictate(dictateRequest({}), ctx)).json();
    expect(body.id).toBeUndefined();
    await settle();
    expect(db.saved).toEqual([]);
  });

  test("feedback is stored and validated", async () => {
    const { ctx, db } = fakeCtx();
    const id = "00000000-0000-4000-8000-0000000000f1";
    const res = await handleFeedback(
      jsonRequest("feedback", {
        dictation_id: id,
        rating: "down",
        note: "x".repeat(1500),
        app: { name: "Claude", bundle_id: "com.anthropic.claudefordesktop" },
        mode: "engineer",
        label: "Prompt · for Claude",
      }),
      ctx,
    );
    expect(await res.json()).toEqual({ ok: true });
    expect(db.feedback[0]).toMatchObject({
      dictation_id: id,
      rating: "down",
      app: { name: "Claude", bundle_id: "com.anthropic.claudefordesktop" },
      mode: "engineer",
      label: "Prompt · for Claude",
    });
    expect((db.feedback[0].note as string).length).toBe(1000);
    await handleFeedback(
      jsonRequest("feedback", { rating: "up", app: "ChatGPT" }),
      ctx,
    );
    expect(db.feedback[1]).toMatchObject({
      dictation_id: null,
      note: null,
      app: { name: "ChatGPT" },
    });
    for (const bad of [
      { rating: "meh" },
      {},
      { rating: "up", dictation_id: "nope" },
    ]) {
      const r = await handleFeedback(jsonRequest("feedback", bad), ctx);
      expect(r.status).toBe(400);
    }
    expect(db.usageCalls).toEqual([]); // not counted in the limits
  });

  test("feedback is capped at 30 an hour", async () => {
    const db = fakeDb();
    const now = Date.now();
    db.feedbackTimes.push(
      ...Array.from({ length: 30 }, (_, i) =>
        new Date(now - 3_000_000 + i * 1000).toISOString(),
      ),
    );
    const { ctx } = fakeCtx({ db });
    const res = await handleFeedback(
      jsonRequest("feedback", { rating: "up" }),
      ctx,
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("rate_limited");
    expect(body.retry_after_sec).toBeGreaterThan(500);
    expect(body.retry_after_sec).toBeLessThanOrEqual(600);
    expect(feedbackRetryAfter([], now)).toBe(0);
    expect(
      feedbackRetryAfter([new Date(now - 4_000_000).toISOString()], now, 1),
    ).toBe(0);
  });

  test("a missing feedback table is a 503, not a crash", async () => {
    const { ctx } = fakeCtx({ db: fakeDb({ noFeedback: true }) });
    const res = await handleFeedback(
      jsonRequest("feedback", { rating: "up" }),
      ctx,
    );
    expect(res.status).toBe(503);
  });

  test("REST: feedback reads the last hour and inserts with the user's id", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      seen.push({ url, init });
      return init.method === "POST"
        ? new Response(null, { status: 201 })
        : new Response(
            JSON.stringify([{ created_at: "2026-11-23T10:00:00Z" }]),
          );
    }) as unknown as typeof fetch;
    const db = database(
      { userId: "00000000-0000-4000-8000-000000000001", token: "jwt" },
      {
        get: (k: string) =>
          ({ SUPABASE_URL: "https://p.supabase.co", SUPABASE_ANON_KEY: "a" })[
            k
          ],
      },
      f,
    );
    expect(await db.recentFeedback()).toEqual(["2026-11-23T10:00:00Z"]);
    expect(seen[0].url).toContain("feedback?select=created_at&created_at=gt.");
    expect(await db.saveFeedback({ rating: "up" })).toBe(true);
    expect(JSON.parse(String(seen[1].init.body))).toEqual({
      user_id: "00000000-0000-4000-8000-000000000001",
      rating: "up",
    });
  });
});
