import { describe, expect, test } from "bun:test";
import { classify } from "../supabase/functions/_shared/categories.ts";
import { learnFromEdit } from "../supabase/functions/_shared/learn.ts";
import { rewrite, type Deps } from "../supabase/functions/_shared/pipeline.ts";
import * as S from "../supabase/functions/_shared/snippets.ts";
import {
  DEFAULT_SETTINGS,
  type UserData,
} from "../supabase/functions/_shared/types.ts";

/** Replays canned replies and records every call. */
function fakeModel(replies: string[]) {
  const calls: Array<{ system: string; user: string; model?: string }> = [];
  const queue = [...replies];
  const deps: Deps = {
    models: { fast: "fast-model", smart: "smart-model" },
    complete: async (system, user, opts) => {
      calls.push({ system, user, model: opts?.model });
      const next = queue.shift();
      if (next === undefined) throw new Error("no more replies");
      return next;
    },
  };
  return { deps, calls };
}

const user = (over: Partial<UserData> = {}): UserData => ({
  settings: structuredClone(DEFAULT_SETTINGS),
  dictionary: ["Dayoph", "Supabase"],
  snippets: [],
  ...over,
});

describe("polish", () => {
  test("uses the fast model, app style and dictionary", async () => {
    const { deps, calls } = fakeModel([
      "Hi Sam,\n\nThe meeting is at 6.\n\nThanks,\nAkhil",
    ]);
    const out = await rewrite(
      {
        text: "hi sam the meeting is at five actually six thanks akhil",
        mode: "dictate",
        app: { name: "Gmail", bundle_id: "com.google.android.gm" },
      },
      user(),
      deps,
    );
    expect(out.mode).toBe("dictate");
    expect(out.category).toBe("email");
    expect(out.text).toContain("6");
    expect(calls[0].model).toBe("fast-model");
    expect(calls[0].system).toContain("Tone: formal");
    expect(calls[0].system).toContain("Dayoph, Supabase");
    expect(calls[0].user).toContain("<transcript>");
  });

  test("retries once when the model invents, then keeps the speaker's words", async () => {
    const { deps, calls } = fakeModel(["Meet at 7.", "Meet at 8."]);
    const out = await rewrite(
      { text: "meet at six", mode: "dictate" },
      user(),
      deps,
    );
    expect(calls.length).toBe(2);
    expect(calls[1].system).toContain(
      "added details the speaker never said: number 7",
    );
    expect(out.text).toBe("meet at six");
    expect(out.guarded).toEqual(["number 8"]);
  });

  test("snippets survive the model untouched", async () => {
    const { deps, calls } = fakeModel(["Book here: [[SNIPPET_1]]"]);
    const out = await rewrite(
      { text: "book here my calendly link", mode: "dictate" },
      user({
        snippets: [
          {
            trigger: "my calendly link",
            expansion: "https://calendly.com/akhil",
          },
        ],
      }),
      deps,
    );
    expect(calls[0].user).toContain("[[SNIPPET_1]]");
    expect(out.text).toBe("Book here: https://calendly.com/akhil");
  });
});

describe("prompt engineer", () => {
  const long =
    "fix the login bug in auth dot ts it crashes when the password is empty and add a test we use vitest";

  test("auto-engineers long dictation in AI apps, with a critique round", async () => {
    const { deps, calls } = fakeModel([
      "<target>coding_agent</target><prompt>Fix auth.ts</prompt>",
      "<score>9</score><issues>- none</issues><prompt>Fix the crash in `auth.ts` when the password is empty. Add a vitest test.</prompt>",
    ]);
    const out = await rewrite(
      {
        text: long,
        mode: "dictate",
        app: { name: "Claude", bundle_id: "com.anthropic.claude" },
      },
      user(),
      deps,
    );
    expect(out.mode).toBe("engineer");
    expect(out.label).toBe("Prompt · for Claude");
    expect(out.target).toBe("claude");
    expect(calls[0].system).toContain("This prompt is for Claude");
    expect(out.text).toContain("vitest");
    expect(calls.every((c) => c.model === "smart-model")).toBe(true);
    expect(calls[0].system).toContain("Never add numbers");
  });

  test("without a known AI the label names the playbook and score", async () => {
    const { deps } = fakeModel([
      "<target>coding_agent</target><prompt>Fix auth.ts</prompt>",
      "<score>9</score><issues>- none</issues><prompt>Fix the crash in `auth.ts` when the password is empty. Add a vitest test.</prompt>",
    ]);
    const out = await rewrite({ text: long, mode: "engineer" }, user(), deps);
    expect(out.label).toBe(
      "Prompt Engineer · coding_agent · 1 critique round(s) · score 9/10",
    );
    expect(out.target).toBeUndefined();
  });

  test("short replies in AI apps are only polished", async () => {
    const { deps } = fakeModel(["Yes, go ahead."]);
    const out = await rewrite(
      {
        text: "yes go ahead",
        mode: "dictate",
        app: { bundle_id: "com.openai.chatgpt" },
      },
      user(),
      deps,
    );
    expect(out.mode).toBe("dictate");
  });

  test("repairs an invented target, then accepts the clean version", async () => {
    const { deps, calls } = fakeModel([
      "<target>writing</target><prompt>Write a report. Aim for 99% accuracy.</prompt>",
      "<score>9</score><prompt>Write a report. Aim for 99% accuracy.</prompt>",
      "<score>9</score><prompt>Write a report on why accuracy lags.</prompt>",
    ]);
    const out = await rewrite(
      { text: "write a report on why our accuracy lags", mode: "engineer" },
      user(),
      deps,
    );
    expect(calls.length).toBe(3);
    expect(calls[2].system).toContain("number 99");
    expect(out.text).toBe("Write a report on why accuracy lags.");
    expect(out.guarded).toEqual(["number 99"]);
  });

  test("falls back to safe polish if the repair still invents", async () => {
    const { deps } = fakeModel([
      "<prompt>Hit 99%.</prompt>",
      "<score>9</score><prompt>Hit 99%.</prompt>",
      "<prompt>Hit 95%.</prompt>",
      "Write a report on accuracy.",
    ]);
    const out = await rewrite(
      { text: "write a report on accuracy", mode: "engineer" },
      user(),
      deps,
    );
    expect(out.mode).toBe("dictate");
    expect(out.text).toBe("Write a report on accuracy.");
    expect(out.label).toContain("blocked an invented detail");
  });

  test("model failure falls back to polish", async () => {
    const { deps } = fakeModel([]);
    deps.complete = async (_s, _u, opts) => {
      if (opts?.model === "smart-model") throw new Error("500");
      return "Plain text.";
    };
    const out = await rewrite(
      { text: "plain text", mode: "engineer" },
      user(),
      deps,
    );
    expect(out.text).toBe("Plain text.");
  });
});

describe("command mode", () => {
  test("edits the selection with the edit prompt", async () => {
    const { deps, calls } = fakeModel(['"Thanks for your patience."']);
    const out = await rewrite(
      { text: "make it formal", mode: "command", selection: "thx for waiting" },
      user(),
      deps,
    );
    expect(out.text).toBe("Thanks for your patience.");
    expect(calls[0].system).toContain("You edit text by voice command");
    expect(calls[0].user).toContain("<selected_text>\nthx for waiting");
  });

  test("without a selection it writes new text", async () => {
    const { deps, calls } = fakeModel(["I can't make it Friday."]);
    await rewrite(
      { text: "decline friday politely", mode: "command" },
      user(),
      deps,
    );
    expect(calls[0].system).toContain("text to write at their cursor");
  });
});

describe("categories, snippets, learning", () => {
  test("mobile package names and browser titles", () => {
    expect(classify({ bundle_id: "com.whatsapp" })).toBe("personal_chat");
    expect(classify({ bundle_id: "com.anthropic.claude" })).toBe("ai_chat");
    expect(
      classify({ bundle_id: "com.android.chrome", title: "New chat - Claude" }),
    ).toBe("ai_chat");
    expect(classify({ bundle_id: "com.unknown.app", category: "email" })).toBe(
      "email",
    );
    expect(classify(undefined)).toBe("other");
  });

  test("snippet tokens never match inside earlier tokens", () => {
    const p = S.protect("snippet and my link", [
      { trigger: "snippet", expansion: "A" },
      { trigger: "my link", expansion: "B" },
    ]);
    expect(S.expand(p.text, p.tokens)).toBe("A and B");
  });

  test("learns misheard names from a correction, ignores rewording", () => {
    expect(learnFromEdit("we beat whisper flow", "we beat Wispr Flow")).toEqual(
      ["Wispr"],
    );
    expect(learnFromEdit("deploy on super base", "deploy on Supabase")).toEqual(
      ["Supabase"],
    );
    expect(
      learnFromEdit(
        "I think we should go",
        "Let's definitely head out now then",
      ),
    ).toEqual([]);
    expect(learnFromEdit("ping dayof", "ping Dayoph", ["dayoph"])).toEqual([]);
  });
});

test("rewrites with Groq until a Claude key is added", async () => {
  const { chatProvider } =
    await import("../supabase/functions/_shared/providers.ts");
  const seen: string[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push(String(url));
    const body = JSON.parse(String(init.body));
    seen.push(body.model);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "Hi." } }] }),
    );
  }) as unknown as typeof fetch;
  const groqOnly = chatProvider(
    { get: (k: string) => (k === "GROQ_API_KEY" ? "g" : undefined) },
    fakeFetch,
  );
  expect(groqOnly.name).toBe("groq");
  expect(await groqOnly.complete("sys", "hi", { model: groqOnly.fast })).toBe(
    "Hi.",
  );
  expect(seen).toEqual([
    "https://api.groq.com/openai/v1/chat/completions",
    "openai/gpt-oss-120b",
  ]);
  const withClaude = chatProvider({
    get: (k: string) => (k === "ANTHROPIC_API_KEY" ? "a" : "g"),
  });
  expect(withClaude.name).toBe("claude");
});

describe("style presets (double-tap)", () => {
  test("a preset replaces the app tone and never auto-engineers", async () => {
    const { rewrite } =
      await import("../supabase/functions/_shared/pipeline.ts");
    const { DEFAULT_SETTINGS } =
      await import("../supabase/functions/_shared/types.ts");
    const systems: string[] = [];
    const deps = {
      complete: async (system: string) => {
        systems.push(system);
        return "Ship it Friday.";
      },
      models: { fast: "f", smart: "s" },
    };
    const user = {
      settings: { ...DEFAULT_SETTINGS, custom_style: "sound like a pirate" },
      dictionary: [],
      snippets: [],
    };
    const long =
      "so basically I think we should probably ship the thing on friday if that works for everyone";
    const out = await rewrite(
      {
        text: long,
        mode: "dictate",
        preset: "short",
        app: { name: "ChatGPT", bundle_id: "com.openai.chat" },
      },
      user,
      deps,
    );
    expect(out.mode).toBe("dictate");
    expect(out.label).toBe("Style · Short & punchy");
    expect(systems[0]).toContain("short and punchy");
    await rewrite(
      { text: long, mode: "dictate", preset: "custom" },
      user,
      deps,
    );
    expect(systems[1]).toContain("sound like a pirate");
  });
});
