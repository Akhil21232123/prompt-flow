// Fakes shared by the handler tests: an in-memory Db and a model that
// answers each kind of prompt (ask-back, memory, check, prompt engineer…).

import type { Ctx } from "../supabase/functions/_shared/handlers.ts";
import type {
  Limits,
  UsageDecision,
} from "../supabase/functions/_shared/limits.ts";
import type { NewMemory } from "../supabase/functions/_shared/memory.ts";
import type {
  ClarificationRow,
  Db,
} from "../supabase/functions/_shared/supabase.ts";
import {
  DEFAULT_SETTINGS,
  type Memory,
  type UserSettings,
} from "../supabase/functions/_shared/types.ts";

export interface Call {
  kind: string;
  system: string;
  user: string;
  model?: string;
}

/** Which prompt a system message belongs to. */
export function kindOf(system: string): string {
  if (system.startsWith("You decide whether")) return "ask";
  if (system.startsWith("You pick out durable facts")) return "extract";
  if (system.startsWith("You check an AI assistant")) return "check";
  if (system.startsWith("You are an expert prompt engineer"))
    return "architect";
  if (system.startsWith("You are a demanding reviewer")) return "critic";
  if (system.startsWith("You turn raw speech-to-text")) return "polish";
  if (system.startsWith("You edit text by voice")) return "edit";
  if (system.startsWith("The user spoke an instruction")) return "write";
  return "other";
}

export type Replies = Partial<
  Record<string, string | ((call: Call) => string | Promise<string>)>
>;

export const DEFAULT_REPLIES: Replies = {
  ask: '{"ask": false}',
  extract: '{"memories": []}',
  check: '{"verdict": "good", "issues": []}',
  architect: "<target>coding_agent</target><prompt>Write the script.</prompt>",
  critic:
    "<score>10</score><issues>- none</issues><prompt>Write the script.</prompt>",
  polish: "Hello there.",
  edit: "Edited.",
  write: "Written.",
};

export interface FakeDb extends Db {
  saved: Array<Record<string, unknown>>;
  words: string[][];
  memories: Memory[];
  newMemories: NewMemory[];
  usedIds: string[];
  clarifications: Map<string, ClarificationRow & { expires_at: string }>;
  usageCalls: Limits[];
  memoryQueries: string[];
  deleted: boolean;
}

export function fakeDb(
  opts: {
    settings?: Partial<UserSettings>;
    dictionary?: string[];
    memories?: Memory[];
    usage?: UsageDecision;
    /** Simulates the v2 tables not existing yet. */
    noClarifications?: boolean;
  } = {},
): FakeDb {
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  const db: FakeDb = {
    session: { userId: "u1", token: "t" },
    saved: [],
    words: [],
    memories: opts.memories ?? [],
    newMemories: [],
    usedIds: [],
    clarifications: new Map(),
    usageCalls: [],
    memoryQueries: [],
    deleted: false,
    loadUserData: async () => ({
      settings: { ...structuredClone(DEFAULT_SETTINGS), ...opts.settings },
      dictionary: opts.dictionary ?? ["Wispr Flow"],
      snippets: [],
    }),
    saveDictation: async (row) => void db.saved.push(row),
    addWords: async (w) => void db.words.push(w),
    consumeUsage: async (limits) => {
      db.usageCalls.push(limits);
      return opts.usage ?? { allowed: true, today: db.usageCalls.length };
    },
    usageToday: async () => 37,
    findMemories: async (q) => {
      db.memoryQueries.push(q);
      return db.memories;
    },
    saveMemories: async (items) => void db.newMemories.push(...items),
    markMemoriesUsed: async (ids) => void db.usedIds.push(...ids),
    createClarification: async (row) => {
      if (opts.noClarifications) return undefined;
      const id = uuid();
      db.clarifications.set(id, { id, ...row });
      return id;
    },
    takeClarification: async (id) => {
      const row = db.clarifications.get(id);
      db.clarifications.delete(id);
      if (!row || Date.parse(row.expires_at) < Date.now()) return undefined;
      return row;
    },
    deleteAccount: async () => {
      db.deleted = true;
    },
  };
  return db;
}

export function fakeCtx(
  opts: {
    db?: FakeDb;
    replies?: Replies;
    transcript?: string | (() => string);
    sttLanguage?: string;
    silent?: boolean;
  } = {},
) {
  const db = opts.db ?? fakeDb();
  const calls: Call[] = [];
  const sttCalls: Array<{ language?: string; prompt?: string }> = [];
  const pending: Array<Promise<unknown>> = [];
  const replies = { ...DEFAULT_REPLIES, ...opts.replies };
  const ctx: Ctx = {
    db: async () => db,
    transcribe: async (_audio, o) => {
      sttCalls.push(o);
      const text =
        typeof opts.transcript === "function"
          ? opts.transcript()
          : (opts.transcript ?? "hello there");
      return {
        text,
        provider: "groq",
        ...(opts.silent ? { silent: true } : {}),
        ...(opts.sttLanguage ? { language: opts.sttLanguage } : {}),
      };
    },
    complete: async (system, user, o) => {
      const call: Call = {
        kind: kindOf(system),
        system,
        user,
        model: o?.model,
      };
      calls.push(call);
      const r = replies[call.kind];
      if (r === undefined) throw new Error(`no reply for ${call.kind}`);
      return typeof r === "function" ? r(call) : r;
    },
    models: { fast: "fast-model", smart: "smart-model" },
    background: (p) => void pending.push(p),
  };
  /** Waits for background work (memory, history) to finish. */
  const settle = async () => {
    while (pending.length) await pending.shift();
  };
  return { ctx, db, calls, sttCalls, settle };
}

/** A 16 kHz mono PCM16 WAV of `seconds` of silence. */
export function wav(seconds = 1): Uint8Array {
  const dataBytes = Math.round(seconds * 32000);
  const buf = new Uint8Array(44 + dataBytes);
  const v = new DataView(buf.buffer);
  const tag = (o: number, s: string) =>
    [...s].forEach((c, i) => (buf[o + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, dataBytes, true);
  return buf;
}

export function dictateRequest(
  meta: Record<string, unknown>,
  audio: Uint8Array | null = wav(1),
) {
  const form = new FormData();
  if (audio)
    form.append(
      "audio",
      new Blob([audio as Uint8Array<ArrayBuffer>], { type: "audio/wav" }),
      "a.wav",
    );
  form.append("meta", JSON.stringify(meta));
  return new Request("http://x/dictate", {
    method: "POST",
    body: form,
    headers: { authorization: "Bearer t" },
  });
}

export function jsonRequest(path: string, body: unknown, method = "POST") {
  return new Request(`http://x/${path}`, {
    method,
    body: method === "GET" ? undefined : JSON.stringify(body),
    headers: { authorization: "Bearer t", "content-type": "application/json" },
  });
}
