# Notices

PromptFlow is built on the following MIT-licensed projects.

## Handy

PromptFlow is a fork of Handy. Most of this repository (audio capture, local
transcription, shortcuts, pasting, history, the settings UI and the LLM
provider client) is Handy's code, imported from
`cjpais/Handy@939c957` (v0.10.1). Handy's original README is kept as
[README.handy.md](README.handy.md).

- https://github.com/cjpais/Handy
- MIT License, Copyright (c) 2025 CJ Pais (see [LICENSE](LICENSE))

## OpenTypeless

The approach to detecting the front app on macOS (asking System Events for the
frontmost process, bundle id and window title) and the idea of per-app writing
styles are adapted from OpenTypeless's `app_detector`.

- https://github.com/tover0314-w/opentypeless
- MIT License, Copyright (c) 2025 OpenTypeless Contributors

## FreeFlow

The dictionary rule in the cleanup prompt (correct only words that were
actually spoken, never insert names from context) and Command Mode's
edit-the-selection flow follow FreeFlow's design.

- https://github.com/zachlatta/freeflow
- MIT License, Copyright (c) 2026 Zach Latta

## OpenWhispr

Reviewed as a reference for Wispr Flow feature coverage.

- https://github.com/HeroTools/open-wispr
- MIT License, Copyright (c) 2024 OpenWhispr Team

## Prompting guidance

Prompt Engineer's rewrite and critique rubric follow Anthropic's
[Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
and OpenAI's [GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide).
