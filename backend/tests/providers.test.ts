import { describe, expect, test } from "bun:test";
import { groqChat } from "../supabase/functions/_shared/providers.ts";

const env = { get: (k: string) => (k === "GROQ_API_KEY" ? "test" : undefined) };

function fakeFetch(statusFor: (model: string) => number, seen: string[]) {
  return (async (_url: string, init: RequestInit) => {
    const model = JSON.parse(String(init.body)).model as string;
    seen.push(model);
    const status = statusFor(model);
    return new Response(
      status === 200
        ? JSON.stringify({
            choices: [{ message: { content: `<think>x</think>ok ${model}` } }],
          })
        : "{}",
      { status },
    );
  }) as unknown as typeof fetch;
}

describe("groqChat when busy", () => {
  test("a rate-limited model hands off to a sibling with its own quota", async () => {
    const seen: string[] = [];
    const complete = groqChat(
      env as never,
      fakeFetch((m) => (m === "openai/gpt-oss-120b" ? 429 : 200), seen),
    );
    expect(await complete("s", "u")).toBe("ok openai/gpt-oss-20b");
    expect(seen).toEqual(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
  });

  test("all busy: waits and retries the main model, then reports busy", async () => {
    const seen: string[] = [];
    const complete = groqChat(
      env as never,
      fakeFetch(() => 429, seen),
    );
    await expect(complete("s", "u")).rejects.toThrow("429");
    expect(seen[0]).toBe("openai/gpt-oss-120b");
    expect(seen.at(-1)).toBe("openai/gpt-oss-120b");
    expect(seen.length).toBe(4);
  });
});
