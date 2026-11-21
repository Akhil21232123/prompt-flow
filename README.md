# PromptFlow

**Wispr Flow-style dictation for macOS, plus a built-in prompt engineer.**
Hold a key, talk, let go: clean text lands in whatever app you're in. Hold a
different key and what you said becomes a prompt that gets the most out of
Claude, ChatGPT, Cursor or Claude Code, refined by a second critique pass.

PromptFlow is a fork of [Handy](https://github.com/cjpais/Handy) (MIT), with
ideas and pieces adapted from [OpenTypeless](https://github.com/tover0314-w/opentypeless),
[FreeFlow](https://github.com/zachlatta/freeflow) and
[OpenWhispr](https://github.com/HeroTools/open-wispr) (all MIT). See
[NOTICE.md](NOTICE.md).

## What it does

| Shortcut (macOS default)    | What happens                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Dictate** `⌥ Space`       | Speech → clean text, matched to the app you're in                                                                                          |
| **Prompt Engineer** `⌃ ⌥ P` | Speech → an engineered prompt for an AI                                                                                                    |
| **Command Mode** `⌃ ⌥ E`    | Select text, say "make this shorter" → selection replaced. Nothing selected: "write a reply declining Friday" → text written at the cursor |
| Cancel `Esc`                | Stops the current recording                                                                                                                |

All shortcuts work as hold-to-talk or tap-to-toggle (General → Shortcut activation), and can be changed in **PromptFlow → Shortcuts**.

### Wispr Flow features

- **Works in every app**: pastes at your cursor (Handy's paste engine).
- **Cleanup**: removes fillers; handles self-corrections ("5pm, actually 6" → "6pm", "scratch that"); spoken punctuation, "new line"/"new paragraph"; numbers, emails and URLs written properly; automatic numbered and bulleted lists.
- **Styles per app**: Formal / Casual / Very casual for Email, Work messages, Personal messages, Documents and Other. The front app is detected (Mail, Slack, WhatsApp, Notion, and browser tabs such as Gmail or claude.ai) and the tone and layout follow it.
- **Developer mode**: "camel case user id" → `userId`, "app dot tsx" → `app.tsx`, "at file auth dot ts" → `@auth.ts` in Cursor and Windsurf, correct spelling of Supabase, Next.js and other tool names, exact flags in terminals.
- **Dictionary**: your names and terms bias both the transcription and the cleanup (Handy's Custom Words).
- **Snippets**: say "my calendly link", get the saved URL. Snippets are swapped for tokens before the AI sees the text, so links are never paraphrased.
- **Command Mode**: voice edits of selected text.
- **100+ languages** with Whisper; output stays in the language you spoke.
- **History** of every dictation, showing both the raw transcript and the result.

### Beyond Wispr Flow

- **Prompt Engineer with a critique loop.** Your rambling request is rewritten
  for its target (coding agent, chat, research, writing, image generation, data
  analysis), following Anthropic's and OpenAI's current prompting guides. A
  separate critic pass then scores it 1–10 on fidelity, clarity, completeness,
  context and proportion, and rewrites it. In **Max** quality it repeats until
  the critic gives 9/10 or higher. The rubric makes sure nothing you said is
  dropped and nothing you didn't say is invented.
- **Auto prompt mode**: dictating normally into Claude, ChatGPT, Cursor or a
  terminal engineers the prompt automatically. Short replies ("yes, go ahead")
  are only cleaned up.
- **Works offline**: local Whisper/Parakeet transcription on Apple Silicon
  (Metal). Wispr Flow needs the cloud. Groq or OpenAI cloud transcription is an
  optional toggle that falls back to local.
- **Your choice of AI**: OpenAI, Anthropic, Groq, OpenRouter, Cerebras, AWS
  Bedrock, Apple Intelligence (on-device), or any OpenAI-compatible server such
  as Ollama or LM Studio.
- **Free, no word limits, no account.**

## Install and run on a Mac

Requirements: macOS 10.15 or later (Apple Silicon recommended), and about 10 GB of free disk space for the build.

```bash
# 1. Tools (skip any you already have)
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
curl -fsSL https://bun.sh/install | bash
brew install cmake

# 2. Get the code
git clone https://github.com/Akhil21232123/promptflow.git
cd promptflow
bun install

# 3. Run in development mode (first build takes 5–15 minutes)
bun run tauri dev

# or build the app bundle: src-tauri/target/release/bundle/macos/PromptFlow.app
bun run tauri build
```

On first launch:

1. Grant **Microphone** and **Accessibility** access when asked (System
   Settings → Privacy & Security). Accessibility is needed to paste and to
   read selected text.
2. The first time PromptFlow checks which app is in front, macOS asks to let
   it control **System Events**. Allow it; that's how styles follow the app.
3. Download a speech model in the **Models** page (Parakeet V3 or Whisper Large
   v3 Turbo are good picks).
4. Pick the AI for cleanup and prompts. In **PromptFlow**, turn on **Post
   Processing**, then in **Post Process** choose a provider, paste its API key
   and pick a model. Prompt Engineer uses the same AI unless you set a different
   one under PromptFlow → Prompt Engineer → AI model.

Good starting models: Claude Sonnet or Haiku (Anthropic) for the best
prompts, or Groq for the lowest latency. Prompt Engineer at **Balanced** makes
two model calls.

## Try it

- In **Notes**, hold `⌥ Space`: _"um so the meeting is at five, actually six, and bring the, uh, the Q3 deck"_ → `The meeting is at 6. Bring the Q3 deck.`
- In **Slack**, the same sentence comes out casual; in **Mail**, formal, with the greeting and sign-off on their own lines.
- In **Cursor** or **Claude**, hold `⌃ ⌥ P`: _"fix the login thing in auth dot ts, it crashes when the password's empty, add a test, we use vitest"_. You get a structured prompt with the goal, the file, observed vs expected behaviour, "read the code first, keep the change focused", the vitest requirement and a definition of done.
- Select a paragraph, hold `⌃ ⌥ E`: _"turn this into three bullets"_.

## How it fits together

```
shortcut ─► record ─► local Whisper/Parakeet  ─┐
   │                  (or Groq/OpenAI cloud)   │
   └─► detect front app (System Events)        ▼
                                  ┌── Command Mode? ──► edit selection / write
                                  ├── Prompt Engineer (or auto in AI apps)?
                                  │      architect ─► critic ─► (revise ×N)
                                  └── Dictate ─► snippets ─► smart cleanup ─► snippets back
                                                                      │
                                                               paste at cursor
```

New code lives in `src-tauri/src/flow/` (Rust) and
`src/components/settings/flow/` (settings UI). The hooks into Handy are in
`actions.rs` (shortcut modes, app capture, selection capture, cloud
transcription, output routing), `clipboard.rs` (`copy_selection`) and
`settings.rs` (the `flow` settings and new shortcuts).

```bash
cd src-tauri && cargo test --lib flow::   # 45 unit tests for the PromptFlow modules
```

## Status and limits

- Built and unit-tested on Linux; the macOS build and the live mic → paste
  flow still need a first run on a Mac. The Mac-specific pieces are small: the
  System Events call for app detection and Cmd+C for Command Mode.
- App detection is macOS-only for now; on Windows and Linux everything works
  with the "Other" style.
- Command Mode reads the selection with Cmd+C and restores your clipboard text
  afterwards. An image on the clipboard is not restored.
- Auto-update is off: there is no signed release feed for PromptFlow yet.
- The other 25 interface languages show the new PromptFlow settings in English.

## License

MIT, as are Handy and the projects it borrows from. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
