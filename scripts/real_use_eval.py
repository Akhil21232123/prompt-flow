#!/usr/bin/env python3
"""Replays real beta dictations that went wrong through the deployed backend.

Each case is a transcript a founder actually said, with the memories that
leaked into it. Checks that the Fn key's "auto" mode picks the right path,
that nothing is invented (no role, no app identifiers, no assumptions), that
short dictations stay short, and that no point is written twice. Prints every
output in full. Same env as quality_eval.py; the user deletes itself.
"""

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from quality_eval import ANON, URL, call, http, test_user  # noqa: E402

CLAUDE = {"name": "Claude", "bundle_id": "com.anthropic.claudefordesktop", "title": "Claude"}
GEMINI = {"name": "Gemini", "bundle_id": "com.apple.Safari.WebApp.8F2C", "title": "Google Gemini"}
MAIL = {"name": "Mail", "bundle_id": "com.apple.mail", "title": "Re: interest in pickone.com"}

BUG_REPORT = (
    "hey so there are a lot of bugs in the app like I don't know this Fn key not working and sometimes it is "
    "opening the feedback one when I hold some keys what is wrong with this there are a lot of bugs in this I "
    "don't know if this is working properly you made this like a very buggy one now what you should do is go "
    "through every feature test everything and then get me the one and by natively holding fn should turn the "
    "text into a structured prompt now it user don't need to press ctrl plus option plus p and for normal one "
    "like for normal speaking to get into a text one you should press command plus spacebar and for formal or "
    "whatever according to the app prompt flow should decide whether it should be prompt engineer or formal "
    "so that's the thing deploy agents do whatever you want and then complete the work"
)
SHORTCUT_QUESTION = (
    "Yeah, I tested the prompt flow now. It's doing good, I tested it with Telugu also. But what's the "
    "difference between option and space and control plus option plus P? I know second one is prompt "
    "engineering, but I did control plus option plus P in Gemini and gave it a prompt in Telugu and it didn't "
    "structure it."
)
PEACE_OUT = (
    "I came out of a puzzle brand called Peace Out. I am planning to start a same brand. I need a marketing "
    "strategy, brand strategy and everything. Peace Out is a domain called peaceout.shop. I want a good plan."
)
MAIL_REPLY = (
    "Thank you for your response but I'm not interested in buying it because that's a lot of price for me. "
    "So yeah. Surrender for now."
)

RESEARCH = (
    "I am testing out this prompt flow now. I am holding FNN and talking. Also, you need to test out manage cases "
    "and you need to test out the diary use cases and all and then you need to make the voice better in traffic and "
    "noises and sort of. And then we need to make differentiators that lets users switch from whisperflow to prompt "
    "flow. and yeah we should be with Perflown in every case possible yeah that's possible because they are only "
    "software solution they don't have big big manufacturing and sort of so they are a software and we are a "
    "software so we can obviously beat them in many aspects so think on what we can do research and yeah scan the "
    "GitHub for new repositories which we can add to make this even more better"
)

MEMORIES = [
    {"content": "I am a funding engineer", "kind": "fact"},
    {"content": "Testing PromptFlow with Telugu language inputs using Gemini", "kind": "project"},
    {"content": "Codes in Python and uses Supabase", "kind": "project"},
]

# Never in a prompt unless the user said it in that dictation.
INVENTED = [r"funding engineer", r"claude desktop", r"com\.anthropic", r"com\.apple", r"\bassum", r"bundle",
            r"window details", r"unrelated (code|shortcuts|features|refactor)"]


def words(t):
    return set(w for w in re.findall(r"[a-z0-9]+", (t or "").lower()) if len(w) > 2)


def repeated_points(t):
    """Pairs of list lines that say the same thing (80% shared words)."""
    lines = [l.strip("-•* \t") for l in (t or "").splitlines() if re.match(r"\s*([-•*]|\d+\.)\s", l)]
    out = []
    for i, a in enumerate(lines):
        for b in lines[i + 1:]:
            x, y = words(a), words(b)
            small = min(len(x), len(y))
            if small >= 3 and len(x & y) / small >= 0.8:
                out.append((a, b))
    return out


CASES = [
    # (id, body, expect_mode, must_contain(any-of groups), must_not, extra)
    ("bug report → prompt for Claude", {"text": BUG_REPORT, "mode": "auto", "app": CLAUDE}, "engineer",
     [["fn"], ["command", "⌘"], ["ctrl", "control"]], INVENTED + [r"telugu"], "no_repeats"),
    ("three words in Claude stay words (auto)", {"text": "so I'm prompting", "mode": "auto", "app": CLAUDE}, "dictate",
     [["prompting"]], [r"telugu", r"gemini", r"<task>"], "short"),
    ("three words in Claude stay words (prompt key)", {"text": "so I'm prompting", "mode": "engineer", "app": CLAUDE},
     "dictate", [["prompting"]], [r"telugu", r"gemini", r"<task>"], "short"),
    ("shortcut question → prompt, no app ids", {"text": SHORTCUT_QUESTION, "mode": "auto", "app": CLAUDE}, "engineer",
     [["option"], ["telugu"]], INVENTED, "no_repeats"),
    ("Peace Out in Gemini web app → prompt", {"text": PEACE_OUT, "mode": "auto", "app": GEMINI}, "engineer",
     [["peace out"], ["peaceout.shop"], ["marketing"]], INVENTED, "no_repeats"),
    ("mail reply stays a mail reply", {"text": MAIL_REPLY, "mode": "auto", "app": MAIL}, "dictate",
     [["interested"]], [r"<task>", r"###"], ""),
    ("selected text is edited", {"text": "make this formal", "mode": "auto", "app": MAIL,
                                 "selection": "hey can u send the deck by tmrw thx"}, "command",
     [["deck"]], [r"<task>"], ""),
    ("research request (24 Nov) → prompt, nothing added", {"text": RESEARCH, "mode": "auto", "app": CLAUDE}, "engineer",
     [["wispr flow"], ["promptflow"], ["github"], ["traffic", "noise"]],
     INVENTED + [r"whisperflow", r"\bfnn\b", r"hardware", r"proprietary", r"at least (?:two|three|four|five)",
                 r"(?:two|three|four|five) sections"], "no_repeats"),
    ("'my backend' uses the stack from memory", {"text": "write a readme for my backend project please", "mode": "auto",
                                                 "app": CLAUDE}, "engineer", [["supabase"]], INVENTED, "memory"),
]


def main():
    results = []
    uid, token, admin = test_user()
    try:
        for m in MEMORIES:
            s, _ = http("POST", "/rest/v1/memories", m,
                        headers={"authorization": f"Bearer {token}", "prefer": "return=minimal"})
            assert s in (200, 201, 204), f"seeding memory failed: {s}"
        for cid, body, mode, must, must_not, extra in CASES:
            r = call(token, "POST", "/functions/v1/rewrite", body)
            t = r.get("text", "") or ""
            low = t.lower()
            print(f"\n===== {cid} [{r.get('mode')}] {r.get('label')!r} {r['_ms']} ms =====")
            if r.get("guarded"):
                print(f"(guard flagged: {r['guarded']})")
            if r.get("fallback_reason"):
                print(f"(fell back: {r['fallback_reason']})")
            print(t)
            checks = [("200", r["_status"] == 200 and bool(t.strip()), f"{r['_status']} {r.get('error', '')}"),
                      (f"mode {mode}", r.get("mode") == mode, str(r.get("mode"))),
                      ("didn't fall back", "Kept your words" not in (r.get("label") or ""), r.get("fallback_reason", ""))]
            for group in must:
                checks.append((f"has {'/'.join(group)}", any(g in low for g in group), ""))
            for pat in must_not:
                hit = re.search(pat, low)
                checks.append((f"no /{pat}/", hit is None, hit.group(0) if hit else ""))
            if extra == "no_repeats":
                reps = repeated_points(t)
                checks.append(("no point written twice", not reps, repr(reps[:2])))
            if extra == "short":
                checks.append(("stays short", len(t.split()) <= 8, f"{len(t.split())} words"))
            if extra == "memory":
                used = [m.get("content") for m in r.get("memory_used") or []]
                checks.append(("memory_used is the stack only", used == ["Codes in Python and uses Supabase"], repr(used)))
            for name, ok, detail in checks:
                results.append((cid, name, ok, detail))
    finally:
        r = call(token, "POST", "/functions/v1/delete_account", {})
        results.append(("cleanup", "delete_account", r["_status"] == 200, str(r["_status"])))

    failed = [x for x in results if not x[2]]
    lines = [f"\n## Real-use replay: {len(results) - len(failed)}/{len(results)} checks passed"]
    for c, n, ok, d in results:
        if not ok:
            lines.append(f"| ❌ | {c} | {n} | {d} |")
    report = "\n".join(lines)
    print(report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(report + "\n")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
