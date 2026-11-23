# PromptFlow backend

Supabase: Postgres for each user's settings, dictionary, snippets and
history (row-level security, so users only ever see their own rows), and
four edge functions the iPhone, Android and Mac apps call.

| Function               | What it does                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /dictate`        | Audio in, finished text out: speech-to-text (Groq Whisper large-v3, OpenAI as backup), the silence filter, ask-back, then Smart Polish, Prompt Engineer or Command Mode, then the fidelity guard |
| `POST /rewrite`        | The same rewrite step for text you already have                                                                                                                                                  |
| `POST /check`          | Autopilot: checks an AI's answer against what you asked and writes a follow-up when it missed something                                                                                          |
| `POST /learn`          | Takes your edit of a result and adds any corrected names or terms to your dictionary                                                                                                             |
| `POST /feedback`       | A 👍/👎 (and optional note) on a result; capped at 30 an hour per user                                                                                                                           |
| `GET /usage`           | Today's request count and the daily limit                                                                                                                                                        |
| `POST /delete_account` | Deletes the account and every row that belongs to it                                                                                                                                             |
| `GET /health`          | Shows which providers and v2 features are set up (and whether the v2 migration has run). It never shows the keys                                                                                 |

`docs/v2-contract.md` defines every request and response.

Models: Claude when `ANTHROPIC_API_KEY` is set (`claude-haiku-5-5` fast,
`claude-sonnet-5-5` smart; override with `CLAUDE_FAST_MODEL` and
`CLAUDE_SMART_MODEL`), otherwise Groq's `openai/gpt-oss-120b`. The fast model
handles cleanup, Command Mode, ask-back decisions and memory extraction; the
smart one handles Prompt Engineer and `/check`.

## v2 features

- **Memory** (`public.memories`): after each finished dictation the fast
  model picks at most 3 durable facts (a code filter also drops anything that
  looks sensitive), in the background. Prompt Engineer and Command Mode get
  the pinned memories plus the 6 best full-text matches (`match_memories`),
  as trusted context. At most 300 per user. Off when the user's
  `memory_enabled` setting is false.
- **Ask-back** (`public.clarifications`): a vague Prompt Engineer request
  (6+ words) may get one question, answerable for 10 minutes and only once.
- **Prompt layout is the server's job**: Prompt Engineer's model returns the
  prompt's parts as JSON (task, context, requirements, output format,
  acceptance criteria, examples, or one `prose` description for image and
  music prompts) and `_shared/structured.ts` lays them out per AI, so the
  format never depends on the model following instructions.
- **AI-specific prompts**: `_shared/targets.ts` spots Claude, ChatGPT,
  Gemini, Perplexity, Copilot, DeepSeek, Grok, Cursor, Windsurf, VS Code,
  Claude Code, Codex, v0, Lovable, Bolt, Midjourney, DALL·E, Ideogram,
  Leonardo, Firefly and Suno, and writes the prompt in that AI's best format.
- **Limits**: 20 requests a minute and 300 a day per user across `/dictate`,
  `/rewrite` and `/check`, counted atomically by `consume_usage`. Change them
  with the `PF_PER_MINUTE` and `PF_PER_DAY` function secrets.
- **Settings merges**: clients can save part of their settings with
  `POST /rest/v1/rpc/merge_settings` and `{"patch": {...}}`. Nested objects
  merge, `null` removes a key, and the merged settings come back.
- **Emails**: `supabase/templates/` has the branded magic-link and signup
  emails, each showing the link and the 6-digit code. Paste them into
  Authentication → Emails once custom SMTP is set up.

## Beta monitoring

`20261123120000_v2_1.sql` adds the `feedback` table and two views only the
service role can read (open them in the SQL editor):

- `beta_stats_daily`: per UTC day, active users, dictations by mode, how
  often Prompt Engineer fell back to the user's words, average and p90
  latency, and 👍/👎 counts.
- `beta_feedback_recent`: the latest 200 feedback rows with what was said,
  what was pasted and the label.

`scripts/quality_eval.py` (the manual "quality eval" workflow) runs about 25
realistic requests against every kind of AI, prints every prompt in full and
checks layout, facts, fallbacks and latency.

If the v2 migration hasn't been run yet, these features switch themselves
off (no memory, no questions, no limits) instead of failing requests.

## Deploy

From the repo root on a Mac:

```bash
./scripts/deploy-backend.sh
```

The script installs the Supabase CLI, signs you in, links the project, and
asks for your keys with hidden input. It stores them as Supabase secrets,
creates the tables, deploys the functions and checks that they're live. At
the end it prints the **Server URL** and **anon key** to put in the apps.

What you need:

- A Supabase project (the free tier is enough).
- An Anthropic API key.
- A Groq API key, used for speech-to-text. There's a free tier at console.groq.com. Claude doesn't transcribe audio.
- Optional: an OpenAI API key, used as backup speech-to-text.

To sign in by email code, open Supabase → Authentication → Emails. Make sure
the "Magic Link" template includes `{{ .Token }}` so the email shows the
6-digit code; `supabase/templates/magic_link.html` does.

Without a database password secret the deploy workflow can't run
migrations: paste each new file in `supabase/migrations/` into the Supabase
SQL editor instead. Every migration is safe to run again.

## Develop

```bash
cd backend
bun install
bun test          # no network needed; the SQL tests run Postgres in WASM (PGlite)
bun run typecheck
```

The function code doesn't depend on Deno-only APIs, so Bun runs the tests
directly. `scripts/sync-prompts.py` copies the prompt texts from the desktop
app's Rust source into `_shared/prompt_texts.ts`, which keeps the two in
step. CI fails if they drift.
