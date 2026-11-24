// From the 24 Nov dictation: misheard names and requirements nobody said.
import { describe, expect, test } from "bun:test";
import { spokenNumbers } from "../supabase/functions/_shared/fidelity.ts";
import { pickHeard } from "../supabase/functions/_shared/handlers.ts";
import {
  fixKnownNames,
  namesOnScreen,
} from "../supabase/functions/_shared/names.ts";
import {
  dropInventedCounts,
  groundParts,
} from "../supabase/functions/_shared/structured.ts";

const SAID =
  "I am testing out this prompt flow now. I am holding FNN and talking. Tell me if it makes a structured prompt. Also, you need to test out manage cases and you need to test out the diary use cases and all and then you need to make the voice better in traffic and noises and sort of. And then we need to make differentiators that lets users switch from whisperflow to prompt flow. and yeah we should be with Perflown in every case possible yeah that's possible because they are only software solution they don't have big big manufacturing and sort of so they are a software and we are a software so we can obviously beat them in many aspects so think on what we can do research and yeah scan the GitHub for new repositories which we can add to make this even more better";

describe("known mishearings are fixed before any model sees them", () => {
  test("the real dictation", () => {
    const t = fixKnownNames(SAID);
    expect(t).toContain("holding Fn and talking");
    expect(t).toContain("switch from Wispr Flow to PromptFlow");
    expect(t).toContain("testing out this PromptFlow now");
    expect(t).not.toMatch(/whisperflow|FNN/);
  });
  test.each([
    ["users switch to Comflow", "users switch to PromptFlow"],
    ["use prom flow daily", "use PromptFlow daily"],
    ["press the FN key", "press the Fn key"],
    ["hold fn to talk", "hold Fn to talk"],
    ["ask chat GBT", "ask ChatGPT"],
    ["open cloud code", "open Claude Code"],
    ["push it to git hub", "push it to GitHub"],
    ["Whisper Flow is slow", "Wispr Flow is slow"],
  ])("%s", (said, fixed) => expect(fixKnownNames(said)).toBe(fixed));
  test.each([
    "upload it to the cloud",
    "the FN SCAR rifle", // not a key
    "a whisper",
    "the prompt flows into the next step",
    "save it in iCloud",
  ])("leaves '%s' alone", (said) => expect(fixKnownNames(said)).toBe(said));
});

describe("names on screen help speech recognition", () => {
  test("names from a mail thread, not sentence-start words", () => {
    expect(
      namesOnScreen([
        "Re: interest in pickone.com",
        "Hi Krishna, thanks for asking. The Supabase invoice and the PromptFlow beta are attached.",
      ]),
    ).toEqual(["Krishna", "Supabase", "PromptFlow"]);
  });
});

describe("requirements must come from what was said", () => {
  const parts = {
    task: "Research differentiators and identify new GitHub repositories we could integrate.",
    context: "",
    requirements: [
      "Do not suggest hardware solutions; focus on software approaches.",
      "Provide at least three differentiators with brief explanations, comparing PromptFlow to Wispr Flow.",
      "Describe how PromptFlow can support manage cases and diary use cases, with brief examples.",
      "List at least three GitHub repositories (with URLs) that could be integrated to improve noise robustness.",
      "Include a short assessment of how each repository could help.",
      "Do not include any proprietary or non-open-source tools.",
      "The differentiators are actionable software features, not hardware specs.",
    ],
    output_format:
      "A plain text response with four sections: 1) Differentiators 2) Manage and Diary Use Cases 3) Noise 4) GitHub repositories",
    acceptance_criteria: [],
    examples: [],
    prose: "",
  };
  const source = fixKnownNames(SAID);
  const p = groundParts(parts, source, spokenNumbers(source));
  test("invented rules are dropped", () => {
    expect(p.requirements.join("\n")).not.toMatch(/proprietary|hardware/i);
  });
  test("counts nobody said are removed", () => {
    expect(p.requirements.join("\n")).not.toMatch(/three/);
    expect(p.output_format).not.toMatch(/four/);
    expect(p.requirements).toContain(
      "Provide differentiators with brief explanations, comparing PromptFlow to Wispr Flow.",
    );
  });
  test("what was asked stays", () => {
    expect(p.requirements.length).toBe(4);
    expect(p.requirements.join("\n")).toMatch(/diary use cases/);
    expect(p.requirements.join("\n")).toMatch(/GitHub repositories/);
  });
  test("a count that was said stays", () => {
    expect(dropInventedCounts("List three repositories", new Set(["3"]))).toBe(
      "List three repositories",
    );
    expect(dropInventedCounts("Keep it under 200 words", new Set())).toBe(
      "Keep it under words",
    );
  });
});

describe("in heavy noise the surer of two recordings wins", () => {
  const h = (confidence: number, dropped?: "silence") => ({
    text: `t${confidence}`,
    ms: 1,
    confidence,
    ...(dropped ? { dropped } : {}),
  });
  test("the filtered copy wins only when clearly surer", () => {
    expect(pickHeard(h(-0.6), h(-0.3)).from).toBe("clean");
    expect(pickHeard(h(-0.3), h(-0.6)).from).toBe("raw");
    expect(pickHeard(h(-0.3), h(-0.28)).from).toBe("raw");
    // Café at 5 dB in the live test: -0.09 raw vs -0.048 filtered, filtered right.
    expect(pickHeard(h(-0.09), h(-0.048)).from).toBe("clean");
  });
  test("a copy that heard nothing never wins", () => {
    expect(pickHeard(h(-0.6), h(-0.1, "silence")).from).toBe("raw");
    expect(pickHeard(h(-0.1, "silence"), h(-0.6)).from).toBe("clean");
    expect(pickHeard(h(-0.4), undefined).from).toBe("raw");
  });
});
