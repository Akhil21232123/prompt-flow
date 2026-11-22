// Minimal Supabase access over REST, with the caller's own JWT so row-level
// security applies: a user only ever reads and writes their own rows.

import type { Env } from "./providers.ts";
import {
  DEFAULT_SETTINGS,
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

export interface Db {
  session: Session;
  loadUserData(): Promise<UserData>;
  saveDictation(row: Record<string, unknown>): Promise<void>;
  addWords(words: string[], source: "learned" | "manual"): Promise<void>;
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
  };
}
