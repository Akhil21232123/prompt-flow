#!/usr/bin/env python3
"""Quality eval of Prompt Engineer on the deployed backend.

Sends realistic transcripts (text, no audio) to /functions/v1/rewrite as a
throwaway user, each written for Claude, ChatGPT, Gemini in a Safari web
app, Cursor, Midjourney and no known AI, plus a few plain dictations and
edits. Checks the layout each AI should get, that the fidelity guard didn't
fall back, that key facts survive, and latency. Prints every output in full
so a person can read them, then a summary. Exits non-zero if a check fails.

Env: PF_URL, PF_ANON (publishable key) and PF_SERVICE (a secret /
service-role key, used only to create the test user; an sb_secret key is
sent only as apikey). Without PF_SERVICE it signs in anonymously, which
needs anonymous sign-ins switched on. The user deletes itself at the end.
"""

import concurrent.futures as cf
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request

URL = os.environ["PF_URL"].rstrip("/")
ANON = os.environ["PF_ANON"]
SERVICE = os.environ.get("PF_SERVICE", "")
WORKERS = int(os.environ.get("PF_EVAL_WORKERS", "3"))
# A single request slower than this fails; the p90 is reported.
MAX_MS = int(os.environ.get("PF_EVAL_MAX_MS", "40000"))
P90_MS = int(os.environ.get("PF_EVAL_P90_MS", "25000"))

KEPT_WORDS = "Kept your words"


def http(method, path, body=None, headers=None, timeout=120):
    h = {"apikey": ANON}
    h.update(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["content-type"] = "application/json"
    req = urllib.request.Request(URL + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(text)
        except ValueError:
            return e.code, {"error": text[:300]}
    except (urllib.error.URLError, TimeoutError) as e:
        return 0, {"error": str(e)}


def test_user():
    if not SERVICE:
        s, tok = http("POST", "/auth/v1/signup", {"data": {"quality_eval": True}})
        assert s == 200 and tok.get("access_token"), f"anonymous sign-in failed: {s} {tok}"
        return None, tok["access_token"], None
    email = f"quality-{secrets.token_hex(4)}@promptflow.test"
    password = secrets.token_urlsafe(18)
    admin = {"apikey": SERVICE}
    if SERVICE.startswith("eyJ"):
        admin["authorization"] = f"Bearer {SERVICE}"
    s, body = http("POST", "/auth/v1/admin/users", {"email": email, "password": password, "email_confirm": True}, headers=admin)
    assert s in (200, 201), f"create user failed: {s} {body}"
    s, tok = http("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": password})
    assert s == 200, f"sign-in failed: {s} {tok}"
    return body["id"], tok["access_token"], admin


WAITS = {"count": 0}
LOCK = threading.Lock()


def call(token, method, path, body=None, tries=6):
    """A signed-in call that waits out the per-minute limit like a client."""
    for attempt in range(tries):
        started = time.time()
        s, res = http(method, path, body, headers={"authorization": f"Bearer {token}"})
        ms = int((time.time() - started) * 1000)
        if s == 429 and res.get("code") == "rate_limited" and attempt < tries - 1:
            with LOCK:
                WAITS["count"] += 1
            time.sleep(min(65, int(res.get("retry_after_sec") or 10) + 1))
            continue
        res["_status"] = s
        res["_ms"] = ms
        return res
    return res


# ------------------------------------------------------------------ targets

TARGETS = {
    "claude": {"name": "Claude", "bundle_id": "com.anthropic.claudefordesktop"},
    "chatgpt": {"name": "ChatGPT", "bundle_id": "com.openai.chat"},
    "gemini-webapp": {
        "name": "Web App",
        "bundle_id": "com.apple.Safari.WebApp.6A1B2C3D-4E5F-4A7B-8C9D-0E1F2A3B4C5D",
        "title": "Gemini",
    },
    "cursor": {"name": "Cursor", "bundle_id": "com.todesktop.230313mzl4w4u92"},
    "midjourney": {"name": "Safari", "bundle_id": "com.apple.Safari", "title": "Midjourney", "url": "https://www.midjourney.com/imagine"},
    "none": None,
}

# (id, transcript, language, facts that must survive outside image prompts)
CASES = [
    ("telugu-shortcuts", "ఆప్షన్ స్పేస్ కి కంట్రోల్ ఆప్షన్ పి కి తేడా ఏంటి? రెండూ ఎప్పుడు వాడాలో సింపుల్ గా చెప్పు", "te", []),
    ("prd", "write a PRD for the PromptFlow Mac app, it's a voice dictation app that turns what you say into prompts for Claude and ChatGPT, cover onboarding, the dynamic island, memory and pricing, keep it practical", "en", ["PromptFlow"]),
    ("brand-peaceout", "I'm starting a puzzle brand called Peace Out, the website is peaceout.shop, help me build a brand strategy, the audience is people in their twenties who want to unplug from their phones, give me positioning, tone of voice and three launch ideas", "en", ["peaceout.shop", "Peace Out"]),
    ("meta-feedback", "okay so um the app is kind of great but like when I press option space it sometimes turns my words into a prompt which I didn't want, and the island thing disappears too fast, and also the memory thing, I don't really know what it's remembering, can you turn this into clear feedback for the developer", "en", []),
    ("hinglish-landlord", "yaar mujhe apne landlord ko ek message likhna hai ki rent next week tak de dunga, thoda polite rakhna aur sorry bhi bolna", "en", []),
    ("three-words", "summarize this article", "en", []),
    ("long-ramble", "so basically I've been thinking about the export business, we make Jaipuri block print bedsheets and cushion covers and I want to start selling to the US, but I'm confused about everything, like do I need an IEC code, how does shipping work, should I use Etsy or my own Shopify store, what about customs duty in the US, and also I heard about RoDTEP benefits, and honestly I also need a pricing strategy because my costs are around 900 rupees per bedsheet, and I want to know how to find my first wholesale buyers, maybe at trade fairs, so can you help me make a step by step plan for the next three months", "en", ["900", "RoDTEP"]),
    ("bug-fix", "fix the bug where the login button stays disabled after the user types their password, it's in login form dot tsx, we use react hook form and zod, add a test", "en", ["LoginForm.tsx|login-form.tsx|loginform.tsx|login form"]),
    ("sql", "write a postgres query that gives me daily active users for the last thirty days from a table called events with user id and created at columns", "en", ["events"]),
    ("research-recent", "what are the latest rules for exporting handicrafts from India to the US this year, I want sources", "en", []),
    ("image-poster", "a poster of a cozy reading nook on a rainy evening in Jaipur, warm lamp light, watercolor style, with the words Peace Out at the top, portrait", "en", ["Peace Out"]),
    ("song", "a lo-fi hindi song about missing home during monsoon, soft female vocals, with a chorus about the smell of rain", "en", []),
    ("data", "I have a CSV of my shop's orders with date, product and amount, help me find which products sell best by month and make a chart", "en", []),
    ("cover-letter", "write a cover letter for a product manager internship at Zomato, I've built a voice dictation app and run a handicrafts brand, keep it under one page", "en", ["Zomato"]),
    ("kid-explain", "explain how the internet works to a ten year old using a simple analogy", "en", ["10|ten"]),
    ("compare", "compare Supabase and Firebase for a small startup with about a hundred users, which one should I pick and why", "en", ["Supabase", "Firebase"]),
    ("interview", "help me prepare for a product sense interview, give me practice questions and how to structure my answers", "en", []),
    ("regex", "write a regex that matches Indian mobile numbers with or without plus ninety one", "en", []),
    ("investor-email", "draft an email to my investor saying we hit 100 beta users, retention is 40 percent after one week, and we need two lakh rupees more by the 15th of December", "en", ["100", "40", "15"]),
    ("hindi-devanagari", "मेरे लिए एक इंस्टाग्राम कैप्शन लिखो हमारे नए ब्लॉक प्रिंट कुशन कवर के लिए, पांच हैशटैग के साथ", "hi", ["5"]),
    ("refactor", "refactor the settings screen in swift ui so each section is its own view, keep the bindings working and don't change the design", "en", []),
    ("travel", "plan a three day trip to Udaipur for two people in January on a mid range budget, include food spots", "en", ["Udaipur"]),
    ("tweet", "write a tweet announcing PromptFlow, you just talk and it writes the perfect prompt for whatever AI you're using", "en", ["PromptFlow"]),
    ("vague-website", "make me a website", "en", []),
    ("meeting-notes", "turn these into meeting notes, we agreed to launch on friday, Diya handles the landing page, I do the onboarding emails, and we review metrics on monday", "en", ["Diya"]),
]

DICTATIONS = [
    ("dictate-whatsapp", "dictate", "hey um so I'll be there by like eight thirty, save me a seat okay", {"name": "WhatsApp", "bundle_id": "net.whatsapp.WhatsApp"}),
    ("dictate-gmail", "dictate", "hi sam thanks for the call today, I'll send the deck by thursday, best, krrish", {"name": "Gmail", "bundle_id": "com.google.Gmail"}),
    ("dictate-chatgpt-stays-words", "dictate", "can you explain the difference between a token bucket and a leaky bucket rate limiter with an example", TARGETS["chatgpt"]),
    ("dictate-slack", "dictate", "quick update the build is green and I'm shipping the mac app tonight", {"name": "Slack", "bundle_id": "com.tinyspeck.slackmacgap"}),
]

EDITS = [
    ("command-formal", "make this more formal", "hey can u send me the deck by tmrw, need it for the 3pm call thx"),
    ("command-shorter", "make it shorter and friendlier", "Dear team, I am writing to inform you that the deployment scheduled for this evening has been postponed until further notice due to unforeseen circumstances."),
]


def fact_ok(fact, text):
    return any(alt.lower() in text.lower() for alt in fact.split("|"))


def mostly_ascii(t):
    letters = [c for c in (t or "") if c.isalpha()]
    return bool(letters) and sum(c.isascii() for c in letters) / len(letters) > 0.9


def layout_checks(target, r):
    """(name, ok) checks for the layout each AI should get."""
    t = r.get("text", "")
    if target == "claude":
        tags = ["<task>", "<context>", "<requirements>", "<output_format>"]
        return [("Claude XML: starts with <task>, has all four tags", t.lstrip().startswith("<task>") and all(x in t for x in tags))]
    if target in ("chatgpt", "gemini-webapp", "none"):
        out = [("Markdown: has ### Task", "### Task" in t)]
        if target == "gemini-webapp":
            out.append(("Gemini web app detected", r.get("target") == "gemini" and r.get("label") == "Prompt · for Gemini"))
        return out
    if target == "cursor":
        return [("coding: Goal / Context / Constraints / Acceptance criteria", all(h in t for h in ["### Goal", "### Context", "### Constraints", "### Acceptance criteria"]))]
    if target == "midjourney":
        return [("image: one dense description, no headings or tags", "###" not in t and "<task>" not in t and len(t) > 20)]
    return []


def main():
    results = []
    lock = threading.Lock()

    def check(case, name, ok, detail=""):
        with lock:
            results.append((case, name, bool(ok), detail))

    uid, token, admin = test_user()
    timings = {}  # mode -> [ms]
    outputs = []
    deleted = False
    try:
        jobs = []
        for cid, text, lang, facts in CASES:
            for target, app in TARGETS.items():
                jobs.append(("engineer", cid, target, {"text": text, "mode": "engineer", "language": lang, **({"app": app} if app else {})}, facts, lang))
        for cid, mode, text, app in DICTATIONS:
            jobs.append((mode, cid, app.get("name") if app else "none", {"text": text, "mode": mode, "app": app}, [], "en"))
        for cid, instruction, selection in EDITS:
            jobs.append(("command", cid, "Gmail", {"text": instruction, "mode": "command", "selection": selection, "app": {"name": "Gmail", "bundle_id": "com.google.Gmail"}}, [], "en"))

        def run(job):
            mode, cid, target, body, facts, lang = job
            r = call(token, "POST", "/functions/v1/rewrite", body)
            return job, r

        with cf.ThreadPoolExecutor(WORKERS) as pool:
            for (mode, cid, target, body, facts, lang), r in pool.map(run, jobs):
                key = f"{cid} → {target}"
                t = r.get("text", "")
                timings.setdefault(mode, []).append(r["_ms"])
                outputs.append((key, mode, r))
                ok = r["_status"] == 200 and bool(t.strip())
                check(key, "200 with text", ok, f"{r['_status']} {r.get('code', '')} {r.get('error', '')}")
                if not ok:
                    continue
                check(key, f"under {MAX_MS // 1000}s", r["_ms"] <= MAX_MS, f"{r['_ms']} ms")
                label = r.get("label", "")
                if mode == "engineer":
                    check(key, "no fidelity fallback", not label.startswith(KEPT_WORDS), f"label={label!r} guarded={r.get('guarded')}")
                    if not label.startswith(KEPT_WORDS):
                        for name, passed in layout_checks(target, r):
                            check(key, name, passed, t[:80].replace("\n", " ⏎ "))
                    if target != "midjourney":
                        for f in facts:
                            check(key, f"keeps {f!r}", fact_ok(f, t), "")
                        if lang != "en":
                            check(key, "written in English", mostly_ascii(t), f"language={r.get('language')!r}")
                else:
                    check(key, "stays the user's words (no prompt layout)", r.get("mode") == mode and "### Task" not in t and "<task>" not in t, f"mode={r.get('mode')} label={label!r}")

        # Feedback round trip on one result.
        first = next((r for _, m, r in outputs if m == "engineer" and r.get("id")), None)
        if first:
            fb = call(token, "POST", "/functions/v1/feedback", {
                "dictation_id": first["id"], "rating": "up", "note": "quality eval", "mode": "engineer", "label": first.get("label")})
            check("feedback", "POST /feedback returns ok", fb["_status"] == 200 and fb.get("ok") is True, f"{fb['_status']} {fb.get('error', '')}")
            s, rows = http("GET", f"/rest/v1/feedback?select=rating,note,dictation_id&dictation_id=eq.{first['id']}",
                           headers={"authorization": f"Bearer {token}"})
            check("feedback", "stored with the dictation id", s == 200 and isinstance(rows, list) and rows and rows[0].get("rating") == "up", f"{s} {rows}")
            bad = call(token, "POST", "/functions/v1/feedback", {"rating": "meh"})
            check("feedback", "bad rating is a 400", bad["_status"] == 400, f"{bad['_status']}")
        else:
            check("feedback", "a finished response carries an id", False, "no engineer response had an id")

        # Latency: p90 across all prompts.
        eng = sorted(timings.get("engineer", []))
        if eng:
            p90 = eng[min(len(eng) - 1, int(len(eng) * 0.9))]
            check("latency", f"engineer p90 under {P90_MS // 1000}s", p90 <= P90_MS, f"p90={p90} ms")

        r = call(token, "POST", "/functions/v1/delete_account", {})
        deleted = r["_status"] == 200
        check("cleanup", "delete_account", deleted, f"{r['_status']} {r.get('error', '')}")
    finally:
        if uid and admin and not deleted:
            http("DELETE", f"/auth/v1/admin/users/{uid}", headers=admin)

    # Every output, in full, for a person to read.
    for key, mode, r in sorted(outputs, key=lambda o: o[0]):
        print(f"\n{'=' * 78}\n{key}  [{mode}]  {r['_status']}  {r['_ms']} ms  label={r.get('label')!r}  target={r.get('target')!r}  language={r.get('language')!r}")
        if r.get("guarded"):
            print(f"guarded: {r['guarded']}")
        print("-" * 78)
        print(r.get("text") or r.get("error") or "")

    def pct(xs, p):
        xs = sorted(xs)
        return xs[min(len(xs) - 1, int(len(xs) * p))] if xs else 0

    lines = ["", "## Latency (ms)", "", "| mode | n | p50 | p90 | max |", "|---|---|---|---|---|"]
    for mode, xs in sorted(timings.items()):
        lines.append(f"| {mode} | {len(xs)} | {pct(xs, 0.5)} | {pct(xs, 0.9)} | {max(xs)} |")
    passed = sum(1 for *_, ok, _ in results if ok)
    failed = [(c, n, d) for c, n, ok, d in results if not ok]
    lines += ["", f"## PromptFlow quality eval: {passed}/{len(results)} checks passed", ""]
    if WAITS["count"]:
        lines.append(f"(waited out the per-minute limit {WAITS['count']} time(s))\n")
    if failed:
        lines += ["| Case | Check | Detail |", "|---|---|---|"]
        for c, n, d in failed:
            lines.append(f"| {c} | {n} | {str(d).replace('|', '/')[:200]} |")
    report = "\n".join(lines)
    print(report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(report + "\n")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
