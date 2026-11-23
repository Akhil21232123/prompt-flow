// Runs every migration in a real Postgres (PGlite, Postgres compiled to
// WASM) with a stand-in for Supabase's auth schema, then exercises the v2
// tables and functions as signed-in users, row-level security included.

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "../supabase/migrations");
const MIGRATIONS = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(DIR, f), "utf8"));
const V2 = readFileSync(join(DIR, "20261123000000_v2.sql"), "utf8");

const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
`;

const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;

/** Runs `sql` as a signed-in user, the way PostgREST does. */
async function as<T = Record<string, unknown>>(
  uid: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [
    uid,
  ]);
  await db.exec("set role authenticated");
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec("reset role");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const m of MIGRATIONS) await db.exec(m);
  // Idempotent: the lead may run it again.
  await db.exec(V2);
  await db.query("insert into auth.users (id) values ($1), ($2)", [ALICE, BOB]);
});

describe("v2 migration", () => {
  test("new users get settings; user_id defaults to the caller", async () => {
    await as(
      ALICE,
      "insert into public.snippets (trigger, expansion) values ('sig', 'Thanks')",
    );
    const rows = await as<{ user_id: string }>(
      ALICE,
      "select user_id from public.snippets",
    );
    expect(rows).toEqual([{ user_id: ALICE }]);
    expect(await as(BOB, "select * from public.snippets")).toEqual([]);
  });

  test("memories: own rows only, unique per user ignoring case", async () => {
    await as(
      ALICE,
      "insert into public.memories (content, kind) values ('Building PromptFlow in Swift and Kotlin', 'project')",
    );
    await expect(
      as(
        ALICE,
        "insert into public.memories (content) values ('  building promptflow in swift and kotlin ')",
      ),
    ).rejects.toThrow();
    // The backend's upsert skips duplicates instead.
    await as(
      ALICE,
      "insert into public.memories (content, source) values ('BUILDING PROMPTFLOW IN SWIFT AND KOTLIN', 'auto') on conflict (user_id, content_key) do nothing",
    );
    await as(
      BOB,
      "insert into public.memories (content) values ('Building PromptFlow in Swift and Kotlin')",
    );
    expect((await as(ALICE, "select id from public.memories")).length).toBe(1);
    await expect(
      as(
        ALICE,
        "insert into public.memories (user_id, content) values ($1, 'sneaky')",
        [BOB],
      ),
    ).rejects.toThrow();
    await expect(
      as(ALICE, "insert into public.memories (content) values ($1)", [
        "x".repeat(281),
      ]),
    ).rejects.toThrow();
    await expect(
      as(
        ALICE,
        "insert into public.memories (content, kind) values ('x', 'secret')",
      ),
    ).rejects.toThrow();
  });

  test("match_memories: pinned plus the best full-text matches, OR semantics", async () => {
    await as(
      ALICE,
      `insert into public.memories (content, pinned) values
        ('Prefers British spelling', true),
        ('Works at IP Group, a freight forwarder', false),
        ('Uses Supabase for every backend', false),
        ('Has a dog called Bruno', false)`,
    );
    const rows = await as<{ content: string; pinned: boolean }>(
      ALICE,
      "select content, pinned from public.match_memories($1, 6)",
      ["write the supabase migration for our backend, it's urgent"],
    );
    expect(rows[0]).toEqual({
      content: "Prefers British spelling",
      pinned: true,
    });
    expect(rows.map((r) => r.content)).toContain(
      "Uses Supabase for every backend",
    );
    expect(rows.map((r) => r.content)).not.toContain("Has a dog called Bruno");
    // Stemming: "building" finds "Building".
    const stem = await as<{ content: string }>(
      ALICE,
      "select content from public.match_memories('what am I build', 6) where not pinned",
    );
    expect(stem.map((r) => r.content)).toContain(
      "Building PromptFlow in Swift and Kotlin",
    );
    // Only stop words, quotes and backslashes: still just the pinned ones.
    const junk = await as(ALICE, "select * from public.match_memories($1, 6)", [
      "the and it's \\ 'or' | & !",
    ]);
    expect(junk.length).toBe(1);
    // Bob never sees Alice's memories.
    const bob = await as<{ content: string }>(
      BOB,
      "select content from public.match_memories('supabase backend dog british', 6)",
    );
    expect(bob.map((r) => r.content)).toEqual([]);
    expect(
      (
        await as(
          ALICE,
          "select * from public.match_memories('supabase', 0) where not pinned",
        )
      ).length,
    ).toBe(0);
  });

  test("updated_at moves on edits, not on use", async () => {
    const [m] = await as<{ id: string; updated_at: Date }>(
      ALICE,
      "insert into public.memories (content) values ('Likes short answers') returning id, updated_at",
    );
    await new Promise((r) => setTimeout(r, 15));
    const [used] = await as<{ updated_at: Date }>(
      ALICE,
      "update public.memories set last_used_at = now() where id = $1 returning updated_at",
      [m.id],
    );
    expect(used.updated_at.getTime()).toBe(m.updated_at.getTime());
    const [edited] = await as<{ updated_at: Date }>(
      ALICE,
      "update public.memories set content = 'Likes very short answers' where id = $1 returning updated_at",
      [m.id],
    );
    expect(edited.updated_at.getTime()).toBeGreaterThan(m.updated_at.getTime());
  });

  test("clarifications: own rows, single use via delete … returning", async () => {
    const [c] = await as<{ id: string }>(
      ALICE,
      "insert into public.clarifications (transcript, question, options) values ('write a script', 'Which language?', '[\"Python\"]') returning id",
    );
    expect(
      await as(
        BOB,
        "delete from public.clarifications where id = $1 returning id",
        [c.id],
      ),
    ).toEqual([]);
    expect(
      await as(
        ALICE,
        "delete from public.clarifications where id = $1 and expires_at > now() returning transcript",
        [c.id],
      ),
    ).toEqual([{ transcript: "write a script" }]);
    expect(
      await as(
        ALICE,
        "delete from public.clarifications where id = $1 returning id",
        [c.id],
      ),
    ).toEqual([]);
  });

  test("consume_usage: per-minute bucket, daily quota, atomic counting", async () => {
    const call = (uid: string, day: number, minute: number) =>
      as<{ r: Record<string, unknown> }>(
        uid,
        "select public.consume_usage($1, $2) as r",
        [day, minute],
      ).then((rows) => rows[0].r);
    const first = await call(BOB, 300, 3);
    expect(first).toMatchObject({ allowed: true, today: 1, daily_limit: 300 });
    await call(BOB, 300, 3);
    await call(BOB, 300, 3);
    const limited = await call(BOB, 300, 3);
    expect(limited).toMatchObject({
      allowed: false,
      code: "rate_limited",
      today: 3,
    });
    expect(limited.retry_after_sec as number).toBeGreaterThan(0);
    expect(limited.retry_after_sec as number).toBeLessThanOrEqual(60);
    // A refused request isn't counted; a new minute resets the bucket.
    await db.exec(
      `update public.usage_daily set minute_start = minute_start - interval '1 minute' where user_id = '${BOB}'`,
    );
    expect(await call(BOB, 300, 3)).toMatchObject({ allowed: true, today: 4 });
    const quota = await call(BOB, 4, 20);
    expect(quota).toMatchObject({ allowed: false, code: "quota", today: 4 });
    expect(quota.retry_after_sec as number).toBeGreaterThan(0);
    expect(quota.retry_after_sec as number).toBeLessThanOrEqual(86_400);
    // Users can read their counter but not change it.
    const rows = await as<{ count: number }>(
      BOB,
      "select count from public.usage_daily",
    );
    expect(rows).toEqual([{ count: 4 }]);
    await expect(
      as(BOB, "update public.usage_daily set count = 0"),
    ).rejects.toThrow();
    await expect(
      as(
        BOB,
        "insert into public.usage_daily (user_id, day) values ($1, current_date + 1)",
        [BOB],
      ),
    ).rejects.toThrow();
    expect(await as(ALICE, "select * from public.usage_daily")).toEqual([]);
  });

  test("merge_settings: deep merge, null removes, creates the row if missing", async () => {
    const merge = (uid: string, patch: unknown) =>
      as<{ s: Record<string, unknown> }>(
        uid,
        "select public.merge_settings($1::jsonb) as s",
        [JSON.stringify(patch)],
      ).then((r) => r[0].s);
    await db.exec(
      `delete from public.user_settings where user_id = '${ALICE}'`,
    );
    expect(
      await merge(ALICE, {
        memory_enabled: false,
        engineer: { quality: "max" },
      }),
    ).toEqual({
      memory_enabled: false,
      engineer: { quality: "max" },
    });
    expect(
      await merge(ALICE, {
        engineer: { min_score: 8 },
        ask_back: true,
        memory_enabled: null,
      }),
    ).toEqual({ engineer: { quality: "max", min_score: 8 }, ask_back: true });
    expect(await merge(BOB, { custom_style: "pirate" })).toEqual({
      custom_style: "pirate",
    });
    await expect(merge(ALICE, ["not", "an", "object"])).rejects.toThrow();
    const stored = await as<{ settings: unknown }>(
      ALICE,
      "select settings from public.user_settings",
    );
    expect(stored).toEqual([
      {
        settings: {
          engineer: { quality: "max", min_score: 8 },
          ask_back: true,
        },
      },
    ]);
  });

  test("deleting the auth user removes every row (cascade)", async () => {
    await db.query("delete from auth.users where id = $1", [BOB]);
    for (const t of [
      "memories",
      "usage_daily",
      "user_settings",
      "clarifications",
    ]) {
      const { rows } = await db.query(
        `select count(*)::int as n from public.${t} where user_id = $1`,
        [BOB],
      );
      expect(rows).toEqual([{ n: 0 }]);
    }
  });
});
