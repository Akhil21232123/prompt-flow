// Minimal Supabase access over REST, with the caller's own JWT so row-level
// security applies: a user only ever reads and writes their own rows.

import {
  type Limits,
  parseUsageDecision,
  type UsageDecision,
  utcDay,
} from "./limits.ts";
import { MEMORY_CAP, type NewMemory } from "./memory.ts";
import type { Env } from "./providers.ts";
import {
  DEFAULT_SETTINGS,
  type Memory,
  type Snippet,
  type UserData,
  type UserSettings,
} from "./types.ts";

type Fetch = typeof fetch;

export class AuthError extends Error {}

export interface Session {
  userId: string;
  token: string;
}

/** A pending ask-back question, stored for 10 minutes. */
export interface ClarificationRow {
  id: string;
  transcript: string;
  question: string;
  options: string[];
  /** The request's meta when the question was asked. */
  meta: Record<string, unknown>;
  language?: string | null;
}

export interface Db {
  session: Session;
  loadUserData(): Promise<UserData>;
  saveDictation(row: Record<string, unknown>): Promise<void>;
  addWords(words: string[], source: "learned" | "manual"): Promise<void>;
  /** Counts one request against the limits. Fails open if the counter is missing. */
  consumeUsage(limits: Limits): Promise<UsageDecision>;
  /** Requests counted today (UTC); 0 when unknown. */
  usageToday(): Promise<number>;
  /** Pinned memories plus the most relevant to `query`; [] when unavailable. */
  findMemories(query: string, count: number): Promise<Memory[]>;
  /** Adds learned memories (duplicates ignored) and keeps the newest 300. */
  saveMemories(items: NewMemory[]): Promise<void>;
  markMemoriesUsed(ids: string[]): Promise<void>;
  /** Stores an ask-back question; undefined when it can't be stored. */
  createClarification(
    row: Omit<ClarificationRow, "id"> & { expires_at: string },
  ): Promise<string | undefined>;
  /** Fetches and deletes a live question (single use); undefined if gone. */
  takeClarification(id: string): Promise<ClarificationRow | undefined>;
  /** Deletes the auth user; every row of theirs goes with it (cascade). */
  deleteAccount(): Promise<void>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID_RE.test(v);

/**
 * The project's secret key for admin calls: a new-style sb_secret key (sent
 * only as apikey) or the legacy service_role JWT (also sent as a Bearer).
 */
export function adminHeaders(env: Env): Record<string, string> | undefined {
  let key: string | undefined;
  try {
    const keys = JSON.parse(env.get("SUPABASE_SECRET_KEYS") ?? "{}") as Record<
      string,
      unknown
    >;
    const value = keys.default ?? Object.values(keys)[0];
    if (typeof value === "string" && value) key = value;
  } catch {
    key = undefined;
  }
  key ??= env.get("SUPABASE_SERVICE_ROLE_KEY") || undefined;
  if (!key) return undefined;
  return key.startsWith("eyJ")
    ? { apikey: key, authorization: `Bearer ${key}` }
    : { apikey: key };
}

export function projectUrl(env: Env): string | undefined {
  return env.get("SUPABASE_URL")?.replace(/\/$/, "");
}

function base(env: Env): { url: string; anon: string } {
  const url = env.get("SUPABASE_URL");
  // Legacy anon key if present, else the project's first publishable key.
  let anon = env.get("SUPABASE_ANON_KEY");
  if (!anon) {
    try {
      const keys = JSON.parse(env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}");
      anon = Object.values(keys).find((k) => typeof k === "string") as
        | string
        | undefined;
    } catch {
      anon = undefined;
    }
  }
  if (!url || !anon)
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set");
  return { url: url.replace(/\/$/, ""), anon };
}

export async function authenticate(
  req: Request,
  env: Env,
  fetchImpl: Fetch = fetch,
): Promise<Session> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new AuthError("Sign in to use PromptFlow");
  const { url, anon } = base(env);
  const res = await fetchImpl(`${url}/auth/v1/user`, {
    headers: { authorization: `Bearer ${token}`, apikey: anon },
  });
  if (!res.ok) throw new AuthError("Your session has expired; sign in again");
  const user = (await res.json()) as { id?: string };
  if (!user.id) throw new AuthError("Your session has expired; sign in again");
  return { userId: user.id, token };
}

/** Old clients stored the spoken language as `language`. */
function spokenLanguage(s: Partial<UserSettings>): string {
  if (typeof s.spoken_language === "string" && s.spoken_language)
    return s.spoken_language;
  if (typeof s.language === "string" && s.language) return s.language;
  return DEFAULT_SETTINGS.spoken_language;
}

/** Deep-merge stored settings over the defaults so old rows stay valid. */
export function mergeSettings(stored: unknown): UserSettings {
  const s = (
    stored && typeof stored === "object" ? stored : {}
  ) as Partial<UserSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    styles: { ...DEFAULT_SETTINGS.styles, ...(s.styles ?? {}) },
    engineer: { ...DEFAULT_SETTINGS.engineer, ...(s.engineer ?? {}) },
    spoken_language: spokenLanguage(s),
    memory_enabled: s.memory_enabled !== false,
    ask_back: s.ask_back !== false,
    prompts_in_english: s.prompts_in_english !== false,
    custom_style: typeof s.custom_style === "string" ? s.custom_style : "",
  };
}

export function database(
  session: Session,
  env: Env,
  fetchImpl: Fetch = fetch,
): Db {
  const { url, anon } = base(env);
  const headers = {
    authorization: `Bearer ${session.token}`,
    apikey: anon,
    "content-type": "application/json",
  };
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchImpl(`${url}/rest/v1/${path}`, { headers });
    if (!res.ok) throw new Error(`database read failed (${res.status})`);
    return (await res.json()) as T;
  };
  /** A REST call whose failure (missing table, network) is logged, not thrown. */
  const soft = async (
    what: string,
    path: string,
    init: RequestInit,
  ): Promise<Response | undefined> => {
    try {
      const res = await fetchImpl(`${url}/rest/v1/${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) },
      });
      if (res.ok) return res;
      console.warn(
        `${what} failed (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`,
      );
    } catch (e) {
      console.warn(`${what} failed: ${e instanceof Error ? e.message : e}`);
    }
    return undefined;
  };
  const inList = (ids: string[]) => `in.(${ids.filter(isUuid).join(",")})`;
  return {
    session,
    async loadUserData() {
      const [settings, words, snippets] = await Promise.all([
        get<Array<{ settings: unknown }>>(
          "user_settings?select=settings&limit=1",
        ),
        get<Array<{ word: string }>>(
          "dictionary_words?select=word&order=created_at.desc&limit=500",
        ),
        get<Snippet[]>("snippets?select=trigger,expansion&limit=200"),
      ]);
      return {
        settings: mergeSettings(settings[0]?.settings),
        dictionary: words.map((w) => w.word),
        snippets,
      };
    },
    async saveDictation(row) {
      await fetchImpl(`${url}/rest/v1/dictations`, {
        method: "POST",
        headers: { ...headers, prefer: "return=minimal" },
        body: JSON.stringify({ user_id: session.userId, ...row }),
      });
    },
    async addWords(words, source) {
      if (!words.length) return;
      await fetchImpl(
        `${url}/rest/v1/dictionary_words?on_conflict=user_id,word_key`,
        {
          method: "POST",
          headers: {
            ...headers,
            prefer: "resolution=ignore-duplicates,return=minimal",
          },
          body: JSON.stringify(
            words.map((word) => ({ user_id: session.userId, word, source })),
          ),
        },
      );
    },
    async consumeUsage(limits) {
      const res = await soft("usage counter", "rpc/consume_usage", {
        method: "POST",
        body: JSON.stringify({
          daily_limit: limits.perDay,
          minute_limit: limits.perMinute,
        }),
      });
      if (!res) return { allowed: true, today: 0 };
      return parseUsageDecision(await res.json().catch(() => null));
    },
    async usageToday() {
      const res = await soft(
        "usage read",
        `usage_daily?select=count&day=eq.${utcDay()}&limit=1`,
        { method: "GET" },
      );
      if (!res) return 0;
      const rows = (await res.json().catch(() => [])) as Array<{
        count?: number;
      }>;
      return typeof rows[0]?.count === "number" ? rows[0].count : 0;
    },
    async findMemories(query, count) {
      const res = await soft(
        "memory search",
        "rpc/match_memories?select=id,content,kind,pinned",
        {
          method: "POST",
          body: JSON.stringify({
            query: query.slice(0, 4000),
            match_count: count,
          }),
        },
      );
      if (!res) return [];
      const rows = (await res.json().catch(() => [])) as Memory[];
      return Array.isArray(rows)
        ? rows.filter((m) => isUuid(m?.id) && typeof m.content === "string")
        : [];
    },
    async saveMemories(items) {
      if (!items.length) return;
      const saved = await soft(
        "memory save",
        "memories?on_conflict=user_id,content_key",
        {
          method: "POST",
          headers: { prefer: "resolution=ignore-duplicates,return=minimal" },
          body: JSON.stringify(
            items.map((m) => ({
              user_id: session.userId,
              content: m.content,
              kind: m.kind,
              source: "auto",
            })),
          ),
        },
      );
      if (!saved) return;
      // Keep the newest 300; pinned ones sort first so they stay.
      const over = await soft(
        "memory cap",
        `memories?select=id&order=pinned.desc,updated_at.desc,id.desc&offset=${MEMORY_CAP}&limit=100`,
        { method: "GET" },
      );
      const extra = over
        ? ((await over.json().catch(() => [])) as Array<{ id: string }>)
        : [];
      if (Array.isArray(extra) && extra.length)
        await soft(
          "memory trim",
          `memories?id=${inList(extra.map((r) => r.id))}`,
          { method: "DELETE", headers: { prefer: "return=minimal" } },
        );
    },
    async markMemoriesUsed(ids) {
      if (!ids.some(isUuid)) return;
      await soft("memory touch", `memories?id=${inList(ids)}`, {
        method: "PATCH",
        headers: { prefer: "return=minimal" },
        body: JSON.stringify({ last_used_at: new Date().toISOString() }),
      });
    },
    async createClarification(row) {
      // Clear this user's expired questions while we're here.
      void soft(
        "clarification cleanup",
        `clarifications?expires_at=lt.${new Date().toISOString()}`,
        { method: "DELETE", headers: { prefer: "return=minimal" } },
      );
      const res = await soft("clarification save", "clarifications?select=id", {
        method: "POST",
        headers: { prefer: "return=representation" },
        body: JSON.stringify({ user_id: session.userId, ...row }),
      });
      if (!res) return undefined;
      const rows = (await res.json().catch(() => [])) as Array<{ id?: string }>;
      return isUuid(rows[0]?.id) ? rows[0].id : undefined;
    },
    async takeClarification(id) {
      if (!isUuid(id)) return undefined;
      const res = await soft(
        "clarification read",
        `clarifications?id=eq.${id}&expires_at=gt.${new Date().toISOString()}&select=id,transcript,question,options,meta,language`,
        { method: "DELETE", headers: { prefer: "return=representation" } },
      );
      if (!res) return undefined;
      const rows = (await res.json().catch(() => [])) as ClarificationRow[];
      const row = rows[0];
      if (!row || typeof row.transcript !== "string") return undefined;
      return {
        ...row,
        options: Array.isArray(row.options) ? row.options : [],
        meta: row.meta && typeof row.meta === "object" ? row.meta : {},
      };
    },
    async deleteAccount() {
      const admin = adminHeaders(env);
      if (!admin)
        throw new Error(
          "Account deletion isn't set up on the server yet (no secret key)",
        );
      const res = await fetchImpl(
        `${url}/auth/v1/admin/users/${session.userId}`,
        { method: "DELETE", headers: admin },
      );
      // 404: already gone, which is what the user wanted.
      if (!res.ok && res.status !== 404)
        throw new Error(
          `Couldn't delete the account (${res.status}); please try again`,
        );
    },
  };
}
