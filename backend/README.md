# PromptFlow backend

Supabase: Postgres for each user's settings, dictionary, snippets and
history (row-level security, so users only ever see their own rows), and
four edge functions the iPhone, Android and Mac apps call.

| Function        | What it does                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /dictate` | Audio in, finished text out: speech-to-text (Groq Whisper large-v3, OpenAI as backup), the silence filter, then Smart Polish, Prompt Engineer or Command Mode with Claude, then the fidelity guard |
| `POST /rewrite` | The same rewrite step for text you already have                                                                                                                                                    |
| `POST /learn`   | Takes your edit of a result and adds any corrected names or terms to your dictionary                                                                                                               |
| `GET /health`   | Shows which providers are configured. It never shows the keys                                                                                                                                      |

Models: `claude-haiku-5-5` handles cleanup and Command Mode (fast), and
`claude-sonnet-5-5` handles the Prompt Engineer (smart). You can override
them with the `CLAUDE_FAST_MODEL` and `CLAUDE_SMART_MODEL` secrets.

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
6-digit code.

## Develop

```bash
cd backend
bun install
bun test          # 35 tests, no network needed
bun run typecheck
```

The function code doesn't depend on Deno-only APIs, so Bun runs the tests
directly. `scripts/sync-prompts.py` copies the prompt texts from the desktop
app's Rust source into `_shared/prompt_texts.ts`, which keeps the two in
step. CI fails if they drift.
