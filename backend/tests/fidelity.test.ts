import { describe, expect, test } from "bun:test";
import {
  extractFacts,
  findInventions,
  spokenNumbers,
} from "../supabase/functions/_shared/fidelity.ts";
import { isLikelyHallucination } from "../supabase/functions/_shared/hallucination.ts";

// The real transcript from the first test on Akhil's Mac (22 Nov 2026).
const AKHIL_TRANSCRIPT =
  "okay I'm testing out the model right now so I don't think it is too good because whatever I'm saying it's not transcribing exactly as whisper flow does because whisper flow catches everything like it catches almost everything up but this is not catching everything up so is there any problem with that and also yeah this is like a V1 but we need like a really good thing that beats whisper flow we need to make whisper flow and then beat it this is not even a whisper flow level how do whisper flow catches that many words like exactly how i say why how";

// What llama3.1 produced from it.
const LLAMA_PROMPT = `Develop a comprehensive report detailing why our current model underperforms Whisper Flow in terms of accuracy.
<constraints>99% accurate text matching my natural pronunciation is necessary; the report must establish a goal of exceeding Whisper Flow's capabilities by at least 10%.</constraints>
<output_format>1-2 fully annotated pages documenting technical details</output_format>
<success_criteria>sets a concrete performance target (exceeding Whisper Flow's 95%+ accuracy mark)</success_criteria>`;

describe("fidelity guard", () => {
  test("catches every number llama3.1 invented in the live test", () => {
    const problems = findInventions(AKHIL_TRANSCRIPT, LLAMA_PROMPT);
    expect(problems).toEqual([
      "number 99",
      "number 10",
      "number 2",
      "number 95",
    ]);
  });

  test("V1 is spoken, so its 1 is allowed", () => {
    expect(findInventions("this is a V1", "This is V1.")).toEqual([]);
  });

  test("spoken numbers in words are allowed in digits", () => {
    const said =
      "meet at five thirty, bring twenty five percent of the budget and two hundred and fifty chairs";
    expect(
      findInventions(
        said,
        "Meet at 5:30. Bring 25% of the budget and 250 chairs.",
      ),
    ).toEqual([]);
  });

  test("self-correction to a spoken number is fine; a new number is not", () => {
    const said = "let's meet at five actually six";
    expect(findInventions(said, "Let's meet at 6.")).toEqual([]);
    expect(findInventions(said, "Let's meet at 7.")).toEqual(["number 7"]);
  });

  test("list markers added by formatting are not facts", () => {
    const said = "three things apples bananas and oranges";
    expect(
      findInventions(said, "Three things:\n1. Apples\n2. Bananas\n3. Oranges"),
    ).toEqual([]);
    expect(findInventions("first wash second dry", "1. Wash\n2. Dry")).toEqual(
      [],
    );
  });

  test("years and hundreds spoken in words", () => {
    expect(findInventions("in twenty twenty six", "In 2026")).toEqual([]);
    expect(
      findInventions("about fifteen hundred users", "About 1500 users"),
    ).toEqual([]);
    expect(findInventions("two lakh rupees", "200000 rupees")).toEqual([]);
  });

  test("emails, links, files and mentions must come from speech", () => {
    const said =
      "email john at gmail dot com and check auth dot ts and ping at sam";
    expect(
      findInventions(
        said,
        "Email john@gmail.com and check `auth.ts`, ping @sam.",
      ),
    ).toEqual([]);
    expect(
      findInventions(
        said,
        "Email jane@gmail.com about login.tsx at https://evil.example",
      ),
    ).toEqual([
      "email jane@gmail.com",
      "link https://evil.example",
      "file login.tsx",
    ]);
  });

  test("spokenNumbers covers ordinals and common quantities", () => {
    const n = spokenNumbers("the first two and a half dozen");
    for (const v of ["1", "2", "0.5", "12"]) expect(n.has(v)).toBe(true);
  });

  test("extractFacts ignores numbers inside file names and links", () => {
    expect(extractFacts("open v2.ts at https://x.io/a/3").numbers).toEqual([]);
  });
});

describe("hallucination filter", () => {
  test("drops stock phrases from short clips", () => {
    expect(isLikelyHallucination("Thank you.", 1.25)).toBe(true);
    expect(isLikelyHallucination(" Thanks for watching! ", 0.8)).toBe(true);
    expect(isLikelyHallucination("", 3)).toBe(true);
  });

  test("keeps real speech and long deliberate thanks", () => {
    expect(isLikelyHallucination("Thank you.", 4)).toBe(false);
    expect(isLikelyHallucination("Thank you for the update.", 1.2)).toBe(false);
    expect(isLikelyHallucination("Thank you.", undefined)).toBe(false);
  });
});

test("punctuation ends a spoken number", () => {
  const said = "budget fifteen hundred, two thousand twenty six plan";
  expect(findInventions(said, "Budget: 1,500. 2026 plan.")).toEqual([]);
});
