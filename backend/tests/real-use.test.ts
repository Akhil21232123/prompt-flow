// Cases taken from real beta dictations that went wrong.
import { describe, expect, test } from "bun:test";
import { autoMode } from "../supabase/functions/_shared/handlers.ts";
import { relevantMemories } from "../supabase/functions/_shared/memory.ts";
import { dedupeParts } from "../supabase/functions/_shared/structured.ts";

const BUG_REPORT =
  "hey so there are a lot of bugs in the app like this Fn key not working and sometimes it is opening the feedback one when I hold some keys, go through every feature test everything, and by natively holding fn should turn the text into a structured prompt so the user doesn't need to press ctrl plus option plus p";
const FUNDING = {
  id: "m1",
  content: "I am a funding engineer",
  kind: "fact" as const,
};
const TELUGU = {
  id: "m2",
  content: "Testing PromptFlow with Telugu language inputs using Gemini",
  kind: "project" as const,
};
const STACK = { id: "m3", content: "Codes in Python and uses Supabase" };
const BRITISH = {
  id: "m4",
  content: "Wants answers in British English",
  kind: "preference" as const,
  pinned: true,
};

describe("memory only joins a request it is about", () => {
  test("one shared common word ('engineer') doesn't bring in a fact", () => {
    expect(relevantMemories([FUNDING, TELUGU], BUG_REPORT)).toEqual([]);
  });
  test("a three-word dictation gets no memories at all", () => {
    expect(
      relevantMemories([FUNDING, TELUGU, STACK], "so I'm prompting"),
    ).toEqual([]);
  });
  test("pinned preferences always apply", () => {
    expect(relevantMemories([BRITISH, FUNDING], "so I'm prompting")).toEqual([
      BRITISH,
    ]);
  });
  test("'my backend' brings in the stack", () => {
    expect(
      relevantMemories(
        [STACK, FUNDING],
        "write a readme for my backend project please",
      ),
    ).toEqual([STACK]);
  });
  test("a bio brings in who the user is", () => {
    expect(relevantMemories([FUNDING], "write a short bio for me")).toEqual([
      FUNDING,
    ]);
  });
  test("two distinctive shared words bring in a project", () => {
    expect(
      relevantMemories(
        [TELUGU],
        "make a prompt to test telugu inputs in gemini properly",
      ),
    ).toEqual([TELUGU]);
  });
});

describe("Fn (auto) decides by the app", () => {
  const claude = {
    name: "Claude",
    bundle_id: "com.anthropic.claudefordesktop",
  };
  const mail = { name: "Mail", bundle_id: "com.apple.mail" };
  test("an AI app gets a prompt", () => {
    expect(autoMode(claude, undefined, BUG_REPORT)).toBe("engineer");
  });
  test("mail gets your words, written for mail", () => {
    expect(
      autoMode(mail, undefined, "thanks for your reply I am not interested"),
    ).toBe("dictate");
  });
  test("a few words in an AI app are just typed", () => {
    expect(autoMode(claude, undefined, "so I'm prompting")).toBe("dictate");
  });
  test("selected text is edited", () => {
    expect(autoMode(mail, "some draft", "make this formal")).toBe("command");
  });
});

describe("no point is written twice", () => {
  test("criteria that restate requirements are dropped", () => {
    const p = dedupeParts({
      task: "Fix the Mac app",
      context: "",
      requirements: [
        "Command + Spacebar must switch the UI to plain-text input mode",
        "The app must no longer require Ctrl + Option + P for prompt-engineering mode",
      ],
      output_format: "",
      acceptance_criteria: [
        "Command + Space switches to text input mode",
        "Ctrl + Option + P is no longer needed for prompt-engineering mode",
        "The app launches without runtime errors",
      ],
      examples: [],
      prose: "",
    });
    expect(p.acceptance_criteria).toEqual([
      "The app launches without runtime errors",
    ]);
    expect(p.requirements.length).toBe(2);
  });
});

describe("'my project' brings in only on-topic project memories", () => {
  test("the stack yes, an unrelated project no", () => {
    expect(
      relevantMemories(
        [STACK, TELUGU],
        "write a readme for my backend project please",
      ),
    ).toEqual([STACK]);
  });
});
