import { describe, expect, test } from "bun:test";
import {
  decideAskBack,
  parseAskBack,
} from "../supabase/functions/_shared/askback.ts";
import { checkUser, parseCheck } from "../supabase/functions/_shared/check.ts";
import {
  findInventions,
  spokenNumbers,
} from "../supabase/functions/_shared/fidelity.ts";
import {
  parseJsonObject,
  stringList,
} from "../supabase/functions/_shared/json.ts";
import {
  guessLanguageFromScript,
  languageCode,
  needsEnglish,
  parseOutputLanguage,
  sttLanguage,
} from "../supabase/functions/_shared/languages.ts";
import {
  limitsFrom,
  parseUsageDecision,
  utcDay,
  wavSeconds,
} from "../supabase/functions/_shared/limits.ts";
import {
  extractMemories,
  isSensitive,
  parseMemories,
  usedMemories,
} from "../supabase/functions/_shared/memory.ts";
import {
  conventionsFor,
  detectTarget,
  formatFor,
} from "../supabase/functions/_shared/targets.ts";
import { wav } from "./fakes.ts";

describe("tolerant JSON", () => {
  test("finds the object in prose, fences, think blocks and trailing commas", () => {
    expect(parseJsonObject('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonObject('Sure!\n```json\n{"a": 1,}\n```')).toEqual({ a: 1 });
    expect(
      parseJsonObject('<think>maybe {"no": true}</think>Answer: {"a": "}"}'),
    ).toEqual({ a: "}" });
    expect(parseJsonObject("{“a”: 2}")).toEqual({ a: 2 });
    expect(parseJsonObject('noise {bad} then {"ok": true} end')).toEqual({
      ok: true,
    });
  });

  test("junk never throws", () => {
    for (const junk of [
      "",
      "no json here",
      "{",
      "[1,2]",
      "null",
      '{"a": ',
      "}{",
      undefined,
      42,
    ])
      expect(parseJsonObject(junk as string)).toBeUndefined();
  });

  test("string lists are trimmed, deduped and capped", () => {
    expect(
      stringList([" a ", "A", "", 3, null, "b".repeat(70), "c", "d"], 3, 60),
    ).toEqual(["a", "3", "c"]);
    expect(stringList("nope", 3, 10)).toEqual([]);
  });
});

describe("ask-back decisions", () => {
  test("parses a question with options", () => {
    expect(
      parseAskBack(
        '{"ask": true, "question": "Which language should the script use?", "options": ["Python", "JavaScript", "Go", "Rust", "C"]}',
      ),
    ).toEqual({
      ask: true,
      question: "Which language should the script use?",
      options: ["Python", "JavaScript", "Go", "Rust"],
    });
    expect(
      parseAskBack('{"ask": "true", "question": "Who is it for?"}'),
    ).toEqual({ ask: true, question: "Who is it for?", options: [] });
  });

  test("anything malformed means don't ask", () => {
    for (const r of [
      '{"ask": false, "question": "x?"}',
      '{"ask": true}',
      '{"ask": true, "question": ""}',
      `{"ask": true, "question": "${"x".repeat(300)}"}`,
      "ask: yes",
      '{"ask": true, "question": 5}',
      "",
    ])
      expect(parseAskBack(r).ask).toBe(false);
  });

  test("short requests, errors and slow models never ask", async () => {
    let called = 0;
    const ask = async () => {
      called++;
      return '{"ask": true, "question": "Which one?"}';
    };
    expect(
      (await decideAskBack({ transcript: "write a script" }, ask, "f")).ask,
    ).toBe(false);
    expect(called).toBe(0);
    const failing = async () => {
      throw new Error("down");
    };
    expect(
      (
        await decideAskBack(
          { transcript: "write me a script that renames my files" },
          failing,
          "f",
        )
      ).ask,
    ).toBe(false);
    const slow = () =>
      new Promise<string>((r) =>
        setTimeout(() => r('{"ask": true, "question": "Which?"}'), 200),
      );
    expect(
      (
        await decideAskBack(
          { transcript: "write me a script that renames my files" },
          slow,
          "f",
          20,
        )
      ).ask,
    ).toBe(false);
  });

  test("the question's language and the context reach the model", async () => {
    let seen = { system: "", user: "" };
    await decideAskBack(
      {
        transcript: "write me a script that renames my files",
        targetName: "Claude",
        memories: [{ id: "m", content: "Codes in Python" }],
        screen: { text: "ls output" },
        questionLanguage: "English",
      },
      async (system, user) => {
        seen = { system, user };
        return '{"ask": false}';
      },
      "f",
    );
    expect(seen.system).toContain("Write the question and answers in English.");
    expect(seen.user).toContain("The prompt is for Claude.");
    expect(seen.user).toContain("- Codes in Python");
    expect(seen.user).toContain("<screen_text>\nls output");
  });
});

describe("autopilot check", () => {
  test("missed answers get issues and a follow-up", () => {
    expect(
      parseCheck(
        '```json\n{"verdict": "missed", "issues": ["Used JavaScript; you asked for Python", "No tests", "a", "b"], "follow_up": "Please rewrite it in Python."}\n```',
      ),
    ).toEqual({
      verdict: "missed",
      issues: ["Used JavaScript; you asked for Python", "No tests", "a"],
      follow_up: "Please rewrite it in Python.",
    });
  });

  test("a follow-up is written from the issues when the model leaves it out", () => {
    expect(
      parseCheck('{"verdict": "MISSED", "issues": ["No sources"]}').follow_up,
    ).toBe("Please fix this: No sources");
  });

  test("junk, or 'missed' with no issues, is good (never nag)", () => {
    for (const r of [
      "",
      "the answer looks fine",
      '{"verdict": "missed", "issues": []}',
      '{"verdict": "great"}',
      '{"verdict": "good", "issues": ["x"], "follow_up": "y"}',
    ])
      expect(parseCheck(r)).toEqual({ verdict: "good", issues: [] });
  });

  test("long answers are cut at 12000 characters, with a note", () => {
    const u = checkUser("do it", "x".repeat(13_000), "Claude");
    expect(u).toContain("The AI: Claude");
    expect(u).toContain("cut off");
    expect(u.length).toBeLessThan(12_400);
  });
});

describe("memory", () => {
  test("parses facts, drops sensitive, long, duplicate and known ones", () => {
    const out = parseMemories(
      JSON.stringify({
        memories: [
          {
            content: "Building PromptFlow in Swift and Kotlin",
            kind: "project",
          },
          { content: "My password is hunter2", kind: "fact" },
          { content: "Card 4111 1111 1111 1111" },
          { content: "Was diagnosed with asthma" },
          { content: "x".repeat(281) },
          { content: "building promptflow in swift and kotlin" },
          { content: "Prefers British spelling", kind: "weird" },
          "Works with Diya on the music club",
          { content: "Already known fact" },
          { content: "Fourth one" },
        ],
      }),
      [{ id: "1", content: "Already known fact" }],
    );
    expect(out).toEqual([
      { content: "Building PromptFlow in Swift and Kotlin", kind: "project" },
      { content: "Prefers British spelling", kind: "fact" },
      { content: "Works with Diya on the music club", kind: "fact" },
    ]);
  });

  test("malformed replies store nothing", () => {
    for (const r of [
      "",
      "none",
      '{"memories": "x"}',
      '{"memories": [1, null]}',
      "[]",
    ])
      expect(parseMemories(r, [])).toEqual([]);
  });

  test("sensitive patterns", () => {
    for (const t of [
      "My bank account is with HDFC",
      "Phone 98765 43210",
      "Email me at a@b.co",
      "My salary is high",
      "Votes for a party",
      "My API key starts with sk",
    ])
      expect(isSensitive(t)).toBe(true);
    expect(isSensitive("Building a Kotlin app for freight forwarders")).toBe(
      false,
    );
  });

  test("extraction skips short dictations and survives model errors", async () => {
    let calls = 0;
    const complete = async () => {
      calls++;
      throw new Error("down");
    };
    expect(await extractMemories("ok thanks", [], complete, "f")).toEqual([]);
    expect(calls).toBe(0);
    expect(
      await extractMemories(
        "I am building a freight app in Kotlin",
        [],
        complete,
        "f",
      ),
    ).toEqual([]);
    expect(calls).toBe(1);
  });

  test("used memories are the ones whose distinctive words made it in", () => {
    const mems = [
      { id: "a", content: "Building PromptFlow in Swift and Kotlin" },
      { id: "b", content: "Has a dog called Bruno" },
      { id: "c", content: "Works at IP Group" },
    ];
    const used = usedMemories(
      mems,
      "write a readme for my app",
      "Write a README for PromptFlow, my app built in Swift and Kotlin.",
    );
    expect(used.map((m) => m.id)).toEqual(["a"]);
    // Words the user said themselves don't count as memory.
    expect(
      usedMemories(
        mems,
        "tell IP Group about it",
        "Tell IP Group about it.",
      ).map((m) => m.id),
    ).toEqual([]);
  });
});

describe("AI targets", () => {
  test("from bundle ids, sites, names and browser titles", () => {
    const id = (app: Parameters<typeof detectTarget>[0]) =>
      detectTarget(app)?.id;
    expect(id({ bundle_id: "com.anthropic.claudefordesktop" })).toBe("claude");
    expect(id({ bundle_id: "com.openai.chat", name: "ChatGPT" })).toBe(
      "chatgpt",
    );
    expect(
      id({
        bundle_id: "com.google.Chrome",
        url: "https://www.perplexity.ai/search",
      }),
    ).toBe("perplexity");
    expect(
      id({ bundle_id: "com.apple.Safari", title: "New chat - Claude" }),
    ).toBe("claude");
    expect(
      id({
        bundle_id: "com.apple.Safari",
        url: "https://gemini.google.com/app",
      }),
    ).toBe("gemini");
    expect(
      id({ bundle_id: "com.todesktop.230313mzl4w4u92", name: "Cursor" }),
    ).toBe("cursor");
    expect(
      id({ bundle_id: "com.microsoft.VSCode", title: "Copilot Chat" }),
    ).toBe("vscode");
    expect(id({ bundle_id: "com.microsoft.copilot" })).toBe("copilot");
    expect(id({ url: "https://lovable.dev/projects/1" })).toBe("lovable");
    expect(id({ url: "https://bolt.new/" })).toBe("bolt");
    expect(id({ url: "https://v0.app/chat" })).toBe("v0");
    expect(id({ url: "https://www.midjourney.com/imagine" })).toBe(
      "midjourney",
    );
    expect(id({ url: "https://ideogram.ai/" })).toBe("ideogram");
    expect(id({ url: "https://suno.com/create" })).toBe("suno");
    expect(id({ name: "DeepSeek" })).toBe("deepseek");
    expect(id({ bundle_id: "ai.x.grok" })).toBe("grok");
    expect(
      id({ bundle_id: "com.googlecode.iterm2", title: "✳ Claude Code" }),
    ).toBe("claude_code");
    expect(id({ bundle_id: "com.apple.Terminal", title: "codex" })).toBe(
      "codex",
    );
  });

  test("mail and chat titles don't count, unknown apps have no target", () => {
    expect(
      detectTarget({
        bundle_id: "com.google.Gmail",
        title: "Re: Claude pricing",
      }),
    ).toBeUndefined();
    expect(
      detectTarget({
        bundle_id: "com.apple.Safari",
        title: "Release v0.2 notes",
      }),
    ).toBeUndefined();
    expect(
      detectTarget({ bundle_id: "com.apple.Terminal", title: "zsh" }),
    ).toBeUndefined();
    expect(detectTarget({ name: "Notes" })).toBeUndefined();
    expect(detectTarget(undefined)).toBeUndefined();
  });

  test("each AI gets its own format", () => {
    const f = (id: string) =>
      formatFor(detectTarget({ url: `https://${id}` })!);
    expect(formatFor(detectTarget({ name: "Claude" })!)).toContain("XML tags");
    expect(formatFor(detectTarget({ name: "ChatGPT" })!)).toContain(
      "### headings",
    );
    expect(f("perplexity.ai")).toContain("search-style question");
    expect(f("midjourney.com")).toContain("--ar");
    expect(f("suno.com")).toContain("[Verse]");
    expect(f("leonardo.ai")).toContain("image generator");
    expect(f("lovable.dev")).toContain("app builder");
    expect(formatFor(detectTarget({ name: "Cursor" })!)).toContain(
      "Acceptance criteria",
    );
  });

  test("Midjourney's ratio flags are allowed only when a shape was said", () => {
    const mj = detectTarget({ url: "https://midjourney.com" });
    expect(conventionsFor(mj, "a landscape photo of Jaipur")).toContain("16:9");
    expect(conventionsFor(mj, "a photo of Jaipur")).toBe("");
    expect(conventionsFor(detectTarget({ name: "Claude" }), "landscape")).toBe(
      "",
    );
  });
});

describe("languages", () => {
  test("codes for Whisper", () => {
    expect(sttLanguage("hi")).toBe("hi");
    expect(sttLanguage("te-IN")).toBe("te");
    expect(sttLanguage("Tamil")).toBe("ta");
    expect(sttLanguage("auto")).toBeUndefined();
    expect(sttLanguage("klingon")).toBeUndefined();
    expect(sttLanguage(undefined)).toBeUndefined();
  });

  test("Whisper's names back to codes, and script guesses", () => {
    expect(languageCode("hindi")).toBe("hi");
    expect(languageCode("Telugu")).toBe("te");
    expect(languageCode("en")).toBe("en");
    expect(languageCode("bangla")).toBe("bn");
    expect(languageCode("")).toBeUndefined();
    expect(guessLanguageFromScript("నమస్కారం")).toBe("te");
    expect(guessLanguageFromScript("नमस्ते")).toBe("hi");
    expect(guessLanguageFromScript("hello")).toBeUndefined();
  });

  test("when to translate", () => {
    expect(needsEnglish("en", "hi", "kuch bhi")).toBe(true);
    expect(needsEnglish("en", "en", "hello")).toBe(false);
    expect(needsEnglish("en", undefined, "नमस्ते")).toBe(true);
    expect(needsEnglish("same", "hi", "नमस्ते")).toBe(false);
    expect(parseOutputLanguage("en-US")).toBe("en");
    expect(parseOutputLanguage("same")).toBe("same");
    expect(parseOutputLanguage(7)).toBeUndefined();
  });

  test("Indian-language numbers are traced by the fidelity guard", () => {
    expect(spokenNumbers("मुझे पांच सौ शब्दों का निबंध चाहिए")).toContain(
      "500",
    );
    expect(spokenNumbers("३ बजे")).toContain("3");
    expect(spokenNumbers("ఐదుగురు కోసం")).toContain("5");
    expect(
      findInventions("पांच उत्पाद दिखाओ", "Show the top 5 products."),
    ).toEqual([]);
    expect(findInventions("उत्पाद दिखाओ", "Show the top 5 products.")).toEqual([
      "number 5",
    ]);
  });
});

describe("limits", () => {
  test("usage decisions from the RPC, failing open", () => {
    expect(parseUsageDecision({ allowed: true, today: 4 })).toEqual({
      allowed: true,
      today: 4,
    });
    expect(
      parseUsageDecision({
        allowed: false,
        code: "quota",
        today: 300,
        retry_after_sec: 3600.2,
      }),
    ).toEqual({
      allowed: false,
      code: "quota",
      today: 300,
      retry_after_sec: 3601,
    });
    expect(parseUsageDecision([{ allowed: false, code: "x" }])).toMatchObject({
      code: "rate_limited",
      retry_after_sec: 60,
    });
    expect(parseUsageDecision(null).allowed).toBe(true);
    expect(parseUsageDecision("junk").allowed).toBe(true);
  });

  test("limits from env, defaults otherwise", () => {
    expect(limitsFrom({ get: () => undefined })).toEqual({
      perMinute: 20,
      perDay: 300,
    });
    expect(
      limitsFrom({
        get: (k) => ({ PF_PER_MINUTE: "5", PF_PER_DAY: "abc" })[k],
      }),
    ).toEqual({ perMinute: 5, perDay: 300 });
  });

  test("WAV length from the header", () => {
    expect(wavSeconds(wav(2))).toBeCloseTo(2, 3);
    const big = wav(1);
    expect(wavSeconds(big.slice(0, 44), 44 + 32000 * 400)).toBeCloseTo(1, 3);
    expect(wavSeconds(new Uint8Array(10))).toBeUndefined();
    expect(
      wavSeconds(new TextEncoder().encode("x".repeat(100))),
    ).toBeUndefined();
    expect(utcDay(new Date("2026-11-23T23:30:00-05:00"))).toBe("2026-11-24");
  });
});
