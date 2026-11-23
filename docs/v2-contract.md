# PromptFlow v2: the contract every surface builds against

This is the source of truth for the v2 build. The backend implements it;
the iPhone, Android and Mac apps call it. Don't change a shape here without
updating every client.

Base URL: `https://fhslwvrspzdcvokajvno.supabase.co`
Public key (publishable, safe to ship): `sb_publishable_havZ6UNdxBtt0AtqpBZaaw_Y_lr8Lss`

Every request sends `apikey: <publishable key>`. Signed-in requests also send
`Authorization: Bearer <access_token>`. Signed-out requests never send a
Bearer header with the publishable key (it isn't a JWT).

## What v2 adds

| Feature                   | One line                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accounts everywhere       | The Mac signs in like the phones. No API keys for users, ever.                                                                                   |
| Ask-back                  | A vague Prompt Engineer request gets one quick question first, then the full prompt.                                                             |
| AI-specific prompts       | The prompt is written for the AI app you're in (Claude, ChatGPT, Gemini, Cursor, image generators…).                                             |
| Speak any Indian language | Speak Hindi, Telugu, Tamil… and get an English prompt (or keep your language for messages).                                                      |
| Memory you own            | PromptFlow remembers durable facts about you and quietly adds the relevant ones to prompts, in every AI. You can see, edit and delete all of it. |
| "This" (Mac)              | Hold the key and say "explain this": the selected text, or the screen's text (read on-device), goes into the prompt.                             |
| Autopilot (Mac)           | After an AI answers, PromptFlow checks the answer against what you asked and offers a one-click fix.                                             |
| Fair use                  | Per-user rate limits and daily caps so 100 users can't exhaust the AI budget.                                                                    |
| Delete account            | Required by the App Store.                                                                                                                       |

## Auth

Unchanged: email sign-in through Supabase GoTrue.

- `POST /auth/v1/otp?redirect_to=promptflow%3A%2F%2Fauth` with
  `{"email": "...", "create_user": true}` sends a sign-in email. Once custom
  SMTP is set up, the email carries **both** a link and a 6-digit code.
- Link: opens `promptflow://auth#access_token=…&refresh_token=…&expires_in=…`.
  Clients trade the `refresh_token` at
  `POST /auth/v1/token?grant_type=refresh_token` for a full session.
- Code: `POST /auth/v1/verify` with `{"type": "email", "email": "...", "token": "123456"}`.
- Refresh: `POST /auth/v1/token?grant_type=refresh_token`.

The Mac registers the `promptflow://` scheme too. A link opened on the Mac
signs the Mac in; a link opened on a phone signs the phone in. Always offer
the 6-digit code as well, since people often read email on another device.

## POST /functions/v1/dictate

Multipart: `audio` (WAV, 16 kHz mono PCM16) and `meta` (JSON). `audio` may be
omitted only when answering an ask-back (`clarify_session`) with `answer_text` or `skip_clarify: true`.

```jsonc
// meta
{
  "mode": "engineer" | "dictate" | "command",
  "duration_sec": 4.2,
  "preset": "clean" | "formal" | "short" | "casual" | "bullets" | "custom", // dictate only
  "language": "en" | "hi" | "te" | "ta" | "kn" | "ml" | "mr" | "bn" | "gu" | "pa" | "ur" | "auto",
  "output_language": "en" | "same",        // default: "en" for engineer, "same" for dictate/command
  "app": { "name": "ChatGPT", "bundle_id": "com.openai.chat", "title": "…", "surrounding_text": "…", "url": "https://chatgpt.com/…" },
  "selection": "…",                         // command mode: the text to edit
  "screen": { "text": "…", "source": "selection" | "window" | "ocr" }, // "this": ≤ 8000 chars
  "ask_back": true,                         // client can show a question; default true
  "clarify_session": "uuid",                // answering an earlier ask-back
  "answer_text": "Python",                  // tapped option (instead of audio)
  "skip_clarify": false,                    // "just write it" without answering
  "device": "ios" | "android" | "mac"
}
```

Responses (HTTP 200):

```jsonc
// 1. Finished text: paste it.
{
  "raw": "what you said",
  "text": "what to paste",
  "mode": "engineer",
  "category": "ai_chat",
  "label": "Prompt · for Claude",
  "target": "claude",                       // which AI it was written for, if any
  "guarded": [],                            // facts the fidelity guard removed
  "memory_used": [ { "id": "uuid", "content": "Building PromptFlow in Swift and Kotlin" } ],
  "language": "te",                         // detected spoken language
  "timing": { "stt_ms": 410, "total_ms": 1630 }
}

// 2. Nothing heard: show "Didn't catch that", paste nothing.
{ "dropped": true, "raw": "", "reason": "silence" | "hallucination" }

// 3. Ask-back: show the question; don't paste anything yet.
{
  "needs_clarification": true,
  "clarify_session": "uuid",                // valid for 10 minutes
  "question": "Which language should the script use?",
  "options": ["Python", "JavaScript", "Go"], // 0–4 short tappable answers
  "raw": "write me a script that…",
  "timing": { "stt_ms": 380, "total_ms": 900 }
}
```

Ask-back rules (backend): only in `engineer` mode, only when `ask_back` is
true, only when the request is missing something that would clearly change the
answer (language, audience, format, scope), at most one question per request,
and never for requests under 6 words. Answering (by tapping an option, by
voice, or by skipping) returns response 1.

Errors: HTTP 4xx/5xx with `{"error": "message for the user", "code": "auth" | "bad_request" | "provider" | "rate_limited" | "quota"}`.
`rate_limited` and `quota` include `"retry_after_sec"`.

## POST /functions/v1/rewrite

Same as before (`{text, mode, preset?, app?, selection?, screen?, language?, output_language?}`) → response 1.

## POST /functions/v1/check (Autopilot)

```jsonc
// request
{ "intent": "the prompt the user sent", "answer": "the AI's reply (≤ 12000 chars)", "app": { "name": "Claude" } }
// response
{
  "verdict": "good" | "missed",
  "issues": ["Used JavaScript; you asked for Python"],   // ≤ 3, short
  "follow_up": "Please rewrite it in Python, and…"       // only when verdict is "missed"
}
```

## Memory

Table `public.memories` (row-level security: own rows only), reached through
PostgREST at `/rest/v1/memories`:

| column                               | type        | notes                                            |
| ------------------------------------ | ----------- | ------------------------------------------------ |
| id                                   | uuid        |                                                  |
| content                              | text        | one short fact, ≤ 280 chars, in the user's words |
| kind                                 | text        | `fact` \| `preference` \| `project` \| `person`  |
| source                               | text        | `auto` (learned) \| `manual` (typed by the user) |
| pinned                               | bool        | always included in prompts                       |
| created_at, updated_at, last_used_at | timestamptz |                                                  |

Clients: list (`GET ?select=*&order=pinned.desc,updated_at.desc`), add
(`POST`), edit (`PATCH ?id=eq.<id>`), delete (`DELETE ?id=eq.<id>`), and a
**Memory** on/off switch stored in settings as `memory_enabled` (default true).

Backend: after each finished dictation it extracts at most 3 durable facts
(never secrets, passwords, health, money or other sensitive details) and
upserts them, keeping at most 300 per user. Before a rewrite it adds the
pinned memories plus the 6 most relevant (Postgres full-text search) as
trusted context. The fidelity guard treats memory as trusted, so facts from
memory are allowed in prompts. `memory_used` lists what was used.

## Settings additions (`user_settings.settings` JSON)

```jsonc
{
  "memory_enabled": true,
  "ask_back": true,
  "spoken_language": "en", // default for "language"
  "prompts_in_english": true, // engineer output in English whatever you speak
  "custom_style": "…",
}
```

## Account

- `GET /functions/v1/usage` → `{ "today": 37, "daily_limit": 300, "plan": "beta" }`
- `POST /functions/v1/delete_account` → deletes the user and all their rows.

## Limits (beta)

- 20 dictations per minute and 300 per day per user (`rate_limited` / `quota`).
- Audio up to 6 minutes.
