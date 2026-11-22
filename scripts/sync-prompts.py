#!/usr/bin/env python3
"""Copy the desktop app's prompt constants (Rust) into the backend (TypeScript).

Run after editing a prompt in src-tauri/src/flow/*.rs:
    python3 scripts/sync-prompts.py
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = ["polish.rs", "prompt_engineer.rs", "command_mode.rs"]
TARGET = ROOT / "backend/supabase/functions/_shared/prompt_texts.ts"

out = {}
for name in SOURCES:
    text = (ROOT / "src-tauri/src/flow" / name).read_text()
    for m in re.finditer(r'const ([A-Z_]+): &str = "((?:[^"\\]|\\.)*)";', text, re.S):
        body = re.sub(r"\\\n\s*", "", m.group(2))
        body = body.replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\")
        out[m.group(1)] = body

header = (
    "// Generated from the desktop app's Rust prompts (src-tauri/src/flow/*.rs)\n"
    "// by scripts/sync-prompts.py so every platform rewrites the same way.\n"
    "// Do not edit by hand.\n\n"
)
TARGET.write_text(
    header
    + "".join(f"export const {k} = {json.dumps(v, ensure_ascii=False)};\n\n" for k, v in out.items())
)
print(f"wrote {len(out)} prompts to {TARGET.relative_to(ROOT)}")
