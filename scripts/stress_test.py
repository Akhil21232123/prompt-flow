#!/usr/bin/env python3
"""Live stress test of the deployed PromptFlow backend.

Speaks test sentences with macOS `say`, adds silence and noise clips, and
runs them all through /functions/v1/dictate as a throwaway test user, in
every mode and style, then in parallel. Then the v2 features: ask-back,
AI-specific prompts, Indian languages, memory, "this", Autopilot /check,
limits, server-side settings merges and account deletion. Prints a report
and exits non-zero if any check fails.

Env: PF_URL, PF_ANON (publishable key), and optionally PF_SERVICE (a
secret / service-role key, to create a password test user). Without it the
test signs in anonymously, which needs anonymous sign-ins switched on. The
user deletes itself through /delete_account at the end.
"""

import concurrent.futures as cf
import json
import math
import os
import random
import re
import secrets
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import wave

URL = os.environ["PF_URL"].rstrip("/")
ANON = os.environ["PF_ANON"]
SERVICE = os.environ.get("PF_SERVICE", "")
TMP = tempfile.mkdtemp()
RATE = 16000


def http(method, path, body=None, headers=None, raw=None, timeout=90):
    h = {"apikey": ANON}
    h.update(headers or {})
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h["content-type"] = "application/json"
    req = urllib.request.Request(URL + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        text = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(text)
        except ValueError:
            return e.code, {"error": text[:300]}


# ------------------------------------------------------------------ audio

def write_wav(path, samples):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", max(-32767, min(32767, int(s * 32767)))) for s in samples))
    return path


def speak(text, voice="Samantha"):
    aiff = os.path.join(TMP, f"{uuid.uuid4().hex}.aiff")
    out = aiff.replace(".aiff", ".wav")
    if subprocess.run(["say", "-v", voice, "-o", aiff, text]).returncode != 0:
        subprocess.run(["say", "-o", aiff, text], check=True)  # voice not installed
    subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{RATE}", "-c", "1", aiff, out], check=True)
    return out


def voice_for(locale, preferred=None):
    """An installed `say` voice for a locale such as hi_IN, or None."""
    listing = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
    voices = []
    for line in listing.splitlines():
        m = re.match(r"^(.+?)\s{2,}([a-z]{2}[_-][A-Z]{2})\b", line)
        if m:
            voices.append((m.group(1).strip(), m.group(2).replace("-", "_")))
    if preferred and any(name == preferred for name, _ in voices):
        return preferred
    return next((name for name, loc in voices if loc == locale), None)


def silence(seconds):
    return write_wav(os.path.join(TMP, f"sil{seconds}.wav"), [0.0] * int(RATE * seconds))


def room_noise(seconds, level=0.004):
    rnd = random.Random(7)
    return write_wav(os.path.join(TMP, f"noise{seconds}.wav"), [rnd.gauss(0, level) for _ in range(int(RATE * seconds))])


def hum(seconds):
    # 50 Hz mains hum plus fan-like noise: the kind of thing Whisper "hears" words in.
    rnd = random.Random(3)
    return write_wav(
        os.path.join(TMP, f"hum{seconds}.wav"),
        [0.02 * math.sin(2 * math.pi * 50 * i / RATE) + rnd.gauss(0, 0.01) for i in range(int(RATE * seconds))],
    )


def duration(path):
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()


# ---------------------------------------------------------------- session

def test_user():
    if not SERVICE:
        s, tok = http("POST", "/auth/v1/signup", {"data": {"stress_test": True}})
        assert s == 200 and tok.get("access_token"), f"anonymous sign-in failed (switch it on in Auth settings): {s} {tok}"
        return None, tok["access_token"], None
    email = f"stress-{secrets.token_hex(4)}@promptflow.test"
    password = secrets.token_urlsafe(18)
    # New-style secret keys (sb_secret_…) go only in apikey; legacy
    # service_role JWTs also work as a Bearer token.
    admin = {"apikey": SERVICE}
    if SERVICE.startswith("eyJ"):
        admin["authorization"] = f"Bearer {SERVICE}"
    s, body = http("POST", "/auth/v1/admin/users", {"email": email, "password": password, "email_confirm": True}, headers=admin)
    assert s in (200, 201), f"create user failed: {s} {body}"
    uid = body["id"]
    s, tok = http("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": password})
    assert s == 200, f"sign-in failed: {s} {tok}"
    return uid, tok["access_token"], admin


def multipart(meta, wav_path=None):
    boundary = "PF" + uuid.uuid4().hex
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"meta\"\r\nContent-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n"
    ).encode()
    if wav_path:
        with open(wav_path, "rb") as f:
            audio = f.read()
        body += (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        ).encode() + audio + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


RATE_LIMITED = {"count": 0}


def call(method, path, token, body=None, raw=None, content_type=None, tries=4):
    """A signed-in call that waits out the per-minute limit like a client would."""
    headers = {"authorization": f"Bearer {token}"}
    if content_type:
        headers["content-type"] = content_type
    for attempt in range(tries):
        started = time.time()
        s, res = http(method, path, body=body, raw=raw, headers=headers)
        if s == 429 and res.get("code") == "rate_limited" and attempt < tries - 1:
            RATE_LIMITED["count"] += 1
            time.sleep(min(65, int(res.get("retry_after_sec") or 10) + 1))
            continue
        res["_status"] = s
        res["_ms"] = int((time.time() - started) * 1000)
        return res
    return res


def dictate(token, wav_path, mode, preset=None, app=None, selection=None, language="en", **extra):
    meta = {"mode": mode, "device": "stress-test", "language": language}
    if wav_path:
        meta["duration_sec"] = duration(wav_path)
    if preset:
        meta["preset"] = preset
    if app:
        meta["app"] = app
    if selection:
        meta["selection"] = selection
    meta.update(extra)
    raw, ctype = multipart(meta, wav_path)
    return call("POST", "/functions/v1/dictate", token, raw=raw, content_type=ctype)


def rest(token, method, path, body=None, prefer=None):
    headers = {"authorization": f"Bearer {token}"}
    if prefer:
        headers["prefer"] = prefer
    return http(method, "/rest/v1/" + path, body=body, headers=headers)


# ------------------------------------------------------------------ cases

CHATGPT = {"name": "ChatGPT", "bundle_id": "com.openai.chat"}
CLAUDE = {"name": "Claude", "bundle_id": "com.anthropic.claudefordesktop"}
WHATSAPP = {"name": "WhatsApp", "bundle_id": "net.whatsapp.WhatsApp"}
GMAIL = {"name": "Gmail", "bundle_id": "com.google.Gmail"}

MESSAGE = ("hey sam so um I wanted to let you know that the meeting tomorrow has been moved to 4 pm "
           "and uh please bring the slides for the Q3 review")
RAMBLE = ("um okay so I need you to like write me a python script that uh reads a CSV file of our sales "
          "and finds the top five products by revenue and then makes a bar chart of them, oh and it should "
          "skip rows where the price is missing")


VAGUE = ["write me a script that renames all the files in a folder",
         "make me a website for my small business with a contact form"]
CLEAR = "write a python function that returns the nth fibonacci number using memoization, with a docstring"
FACT = ("just so you know, I'm building an app called PromptFlow in Swift and Kotlin, "
        "and I always want answers in British English")
HINDI = "मेरे लिए एक पायथन स्क्रिप्ट लिखो जो एक फोल्डर की सारी फाइलों के नाम बदल दे"
TELUGU = "నాకు ఒక పైథాన్ స్క్రిప్ట్ రాయండి అది ఒక ఫోల్డర్‌లోని అన్ని ఫైళ్ల పేర్లు మారుస్తుంది"


def words(t):
    return len(re.findall(r"\w+", t or ""))


def mostly_ascii(t):
    letters = [c for c in (t or "") if c.isalpha()]
    return bool(letters) and sum(c.isascii() for c in letters) / len(letters) > 0.9


def v2_checks(token, check):
    # Ask-back: a vague request gets one question; answer it by text.
    asked = None
    for text in VAGUE:
        r = dictate(token, speak(text), "engineer", app=CLAUDE)
        if r.get("needs_clarification"):
            asked = r
            break
    check("ask-back: a vague request gets a question", asked is not None and bool(asked.get("question")) and asked.get("clarify_session"),
          f"question={asked and asked.get('question')!r} options={asked and asked.get('options')}")
    if asked:
        answer = (asked.get("options") or ["Python"])[0]
        r = dictate(token, None, "engineer", clarify_session=asked["clarify_session"], answer_text=answer)
        check("ask-back: answering by text writes the prompt", r["_status"] == 200 and bool(r.get("text")) and not r.get("needs_clarification"),
              f"{r['_status']} {r.get('code')} {r.get('error')!r} {r['_ms']} ms, answer={answer!r}, label={r.get('label')!r}{(' why=' + r['fallback_reason']) if r.get('fallback_reason') else ''}")
        r = dictate(token, None, "engineer", clarify_session=asked["clarify_session"], answer_text=answer)
        check("ask-back: a question can only be answered once", r["_status"] == 400, f"{r['_status']} {r.get('error')}")
    skipped = None
    for text in VAGUE:
        r = dictate(token, speak(text), "engineer", app=CHATGPT)
        if r.get("needs_clarification"):
            skipped = dictate(token, None, "engineer", clarify_session=r["clarify_session"], skip_clarify=True)
            break
    check("ask-back: skipping writes the prompt", skipped is not None and skipped["_status"] == 200 and bool(skipped.get("text")),
          f"{skipped and skipped.get('_status')} {skipped and skipped.get('error')!r} label={skipped and skipped.get('label')!r}")
    r = dictate(token, speak(CLEAR), "engineer", app=CLAUDE)
    check("ask-back: a clear request is not questioned", r["_status"] == 200 and not r.get("needs_clarification") and bool(r.get("text")),
          f"question={r.get('question')!r}")
    r = dictate(token, speak(VAGUE[0]), "engineer", app=CLAUDE, ask_back=False)
    check("ask-back: ask_back=false never asks", r["_status"] == 200 and not r.get("needs_clarification"), f"{r['_status']} {r.get('code')} {r.get('error')!r} label={r.get('label')!r}{(' why=' + r['fallback_reason']) if r.get('fallback_reason') else ''} q={r.get('question')!r}")

    # AI-specific prompts: XML for Claude, Markdown for ChatGPT.
    ramble = speak(RAMBLE)
    r = dictate(token, ramble, "engineer", app=CLAUDE, ask_back=False)
    t = r.get("text", "")
    check("target: Claude gets XML-tagged sections", r.get("target") == "claude" and r.get("label") == "Prompt · for Claude" and t.lstrip().startswith("<task>") and all(x in t for x in ("<context>", "<requirements>", "<output_format>")),
          f"label={r.get('label')!r}{(' why=' + r['fallback_reason']) if r.get('fallback_reason') else ''} :: {t[:120]!r}")
    r = dictate(token, ramble, "engineer", app=CHATGPT, ask_back=False)
    t = r.get("text", "")
    check("target: ChatGPT gets Markdown, not XML", r.get("target") == "chatgpt" and "### Task" in t and re.search(r"<[a-z_]+>", t) is None,
          f"label={r.get('label')!r}{(' why=' + r['fallback_reason']) if r.get('fallback_reason') else ''} :: {t[:120]!r}")

    # Indian languages: speech in Hindi / Telugu becomes an English prompt.
    for name, locale, preferred, sentence, code in [("Hindi", "hi_IN", "Lekha", HINDI, "hi"), ("Telugu", "te_IN", None, TELUGU, "te")]:
        voice = voice_for(locale, preferred)
        if not voice:
            check(f"{name} speech → English prompt (skipped: no {locale} voice)", True, "install a voice to test this")
            continue
        r = dictate(token, speak(sentence, voice=voice), "engineer", app=CHATGPT, language=code, ask_back=False)
        t = r.get("text", "")
        check(f"{name} speech → English prompt", r["_status"] == 200 and mostly_ascii(t) and re.search(r"python|script|file", t, re.I) is not None,
              f"language={r.get('language')!r} raw={r.get('raw', '')[:60]!r} :: {t[:120]!r}")
        check(f"{name}: detected language returned", r.get("language") == code, repr(r.get("language")))

    # Memory: say a fact, see it stored (learned in the background), see it used.
    dictate(token, speak(FACT), "dictate", "clean", app=CHATGPT)
    stored = []
    for _ in range(15):
        time.sleep(2)
        s, rows = rest(token, "GET", "memories?select=id,content,source,pinned&order=pinned.desc,updated_at.desc")
        stored = rows if s == 200 and isinstance(rows, list) else []
        if any(re.search(r"promptflow|swift|kotlin|british", m.get("content", ""), re.I) for m in stored):
            break
    check("memory: a durable fact is learned", any(m.get("source") == "auto" and re.search(r"promptflow|swift|kotlin|british", m["content"], re.I) for m in stored),
          f"{[m.get('content') for m in stored][:5]}")
    r = dictate(token, speak("write a short readme introduction for my app"), "engineer", app=CHATGPT, ask_back=False)
    used = r.get("memory_used") or []
    check("memory: it is used in a later prompt", bool(used) or re.search(r"swift|kotlin|promptflow", r.get("text", ""), re.I) is not None,
          f"memory_used={[m.get('content') for m in used]} :: {r.get('text', '')[:100]!r}")
    s, made = rest(token, "POST", "memories", {"content": "Prefers short answers", "kind": "preference"}, prefer="return=representation")
    mid = made[0]["id"] if s == 201 and isinstance(made, list) and made else None
    ok = mid is not None
    if mid:
        s1, _ = rest(token, "PATCH", f"memories?id=eq.{mid}", {"pinned": True})
        s2, _ = rest(token, "DELETE", f"memories?id=eq.{mid}")
        ok = s1 in (200, 204) and s2 in (200, 204)
    check("memory: add (no user_id), pin and delete through REST", ok, f"create={s}")

    # "This": screen text is what the prompt is about.
    screen = "TypeError: Cannot read properties of undefined (reading 'map') at TodoList.render (TodoList.jsx:42)"
    r = dictate(token, speak("explain this error and tell me how to fix it"), "engineer", app=CHATGPT, ask_back=False,
                screen={"text": screen, "source": "window"})
    check("this: screen text goes into the prompt", r["_status"] == 200 and "TodoList" in r.get("text", "") and not r.get("guarded"),
          f"guarded={r.get('guarded')} :: {r.get('text', '')[:120]!r}")

    # Autopilot: a good answer and a missed one.
    r = call("POST", "/functions/v1/check", token, body={
        "intent": "Write a haiku about the monsoon in Mumbai",
        "answer": "Mumbai skies go dark\nrain drums on tin roofs all night\nthe sea breathes again", "app": {"name": "Claude"}})
    check("check: a good answer is good", r["_status"] == 200 and r.get("verdict") == "good", json.dumps({k: r.get(k) for k in ("verdict", "issues")}))
    r = call("POST", "/functions/v1/check", token, body={
        "intent": "Write a Python function that reverses a string. Don't use slicing.",
        "answer": "function reverse(s) { return s.split('').reverse().join(''); }", "app": {"name": "ChatGPT"}})
    check("check: a missed answer gets issues and a follow-up", r["_status"] == 200 and r.get("verdict") == "missed" and r.get("issues") and r.get("follow_up"),
          json.dumps({k: r.get(k) for k in ("verdict", "issues", "follow_up")})[:300])

    # Limits: usage is counted; the counter refuses past its limits (called
    # directly with limits of 0, which costs nothing and counts nothing).
    r = call("GET", "/functions/v1/usage", token)
    check("usage: today is counted", r["_status"] == 200 and isinstance(r.get("today"), int) and r["today"] > 0 and r.get("daily_limit") == 300 and r.get("plan") == "beta",
          json.dumps({k: r.get(k) for k in ("today", "daily_limit", "plan")}))
    s, lim = rest(token, "POST", "rpc/consume_usage", {"daily_limit": 300, "minute_limit": 0})
    check("limits: per-minute limit refuses with retry_after_sec", s == 200 and lim.get("allowed") is False and lim.get("code") == "rate_limited" and lim.get("retry_after_sec", 0) > 0, json.dumps(lim))
    s, lim = rest(token, "POST", "rpc/consume_usage", {"daily_limit": 0, "minute_limit": 20})
    check("limits: daily quota refuses with retry_after_sec", s == 200 and lim.get("allowed") is False and lim.get("code") == "quota" and lim.get("retry_after_sec", 0) > 0, json.dumps(lim))

    # Settings: two partial saves merge instead of overwriting.
    rest(token, "POST", "rpc/merge_settings", {"patch": {"ask_back": True, "engineer": {"quality": "balanced"}}})
    s, merged = rest(token, "POST", "rpc/merge_settings", {"patch": {"engineer": {"min_score": 9}, "stress_flag": None}})
    ok = s == 200 and isinstance(merged, dict) and merged.get("ask_back") is True and merged.get("engineer", {}).get("quality") == "balanced" and merged["engineer"].get("min_score") == 9 and "stress_flag" not in merged
    check("settings: merge_settings merges partial patches", ok, json.dumps(merged)[:200])


def main():
    results, failures = [], []

    def check(name, ok, detail):
        results.append((name, ok, detail))
        if not ok:
            failures.append(name)
        print(("PASS " if ok else "FAIL ") + name + " :: " + detail, flush=True)

    uid, token, admin = test_user()
    deleted = False
    try:
        msg = speak(MESSAGE)
        ramble = speak(RAMBLE)
        money = speak("remind me to pay 2500 rupees to Rahul on the 15th of December")
        hinglish = speak("kal ki meeting 5 baje hai, please confirm with Priya", voice="Rishi")
        edit = speak("make this more formal and shorter")
        long_text = speak(" ".join([MESSAGE, RAMBLE, "and then after that we should also review the hiring plan for next quarter, update the budget sheet, and send the investor update by Friday evening"]))

        # 1. Silence and noise must never produce text.
        for label, clip in [("silence 2s", silence(2)), ("room noise 3s", room_noise(3)), ("hum + fan 3s", hum(3))]:
            for mode, preset in [("engineer", None), ("dictate", "clean")]:
                r = dictate(token, clip, mode, preset, app=CHATGPT)
                ok = r["_status"] == 200 and (r.get("dropped") or not r.get("text"))
                check(f"{label} [{mode}] stays empty", ok, f"text={r.get('text')!r} raw={r.get('raw')!r}")

        # 2. Single tap: Prompt Engineer.
        r = dictate(token, ramble, "engineer", app=CHATGPT)
        t = r.get("text", "")
        check("prompt engineer: structured prompt", r["_status"] == 200 and words(t) > words(RAMBLE) * 0.8 and re.search(r"python", t, re.I) is not None,
              f"{r['_ms']} ms, {words(t)} words, label={r.get('label')!r}{(' why=' + r['fallback_reason']) if r.get('fallback_reason') else ''}")
        check("prompt engineer: keeps 'top five'/'5'", re.search(r"\b(5|five)\b", t, re.I) is not None, t[:160].replace("\n", " ") + "…")
        invented = [n for n in re.findall(r"\b\d+(?:\.\d+)?%?", t) if n.rstrip("%") not in {"5", "3", "1", "2"}]
        check("prompt engineer: no invented numbers", not invented, f"numbers={invented}")
        print("\n--- engineered prompt ---\n" + t + "\n-------------------------\n", flush=True)

        # 3. Double tap: every style, never turned into a prompt.
        outs = {}
        for preset in ["clean", "formal", "short", "casual", "bullets"]:
            r = dictate(token, msg, "dictate", preset, app=CHATGPT)
            t = r.get("text", "")
            outs[preset] = t
            ok = r["_status"] == 200 and r.get("mode") == "dictate" and "4" in t and re.search(r"sam", t, re.I)
            check(f"style {preset}: keeps Sam and 4 pm, stays dictation even in ChatGPT", bool(ok), f"{r['_ms']} ms :: {t!r}")
        check("style short is shorter than clean", words(outs["short"]) < words(outs["clean"]), f"{words(outs['short'])} vs {words(outs['clean'])} words")
        check("style bullets is a list", re.search(r"^\s*[-•*]", outs["bullets"], re.M) is not None, repr(outs["bullets"][:120]))
        check("no filler words in clean", re.search(r"\b(um|uh)\b", outs["clean"], re.I) is None, repr(outs["clean"]))

        # 4. Numbers and names survive.
        r = dictate(token, money, "dictate", "clean", app=WHATSAPP)
        t = r.get("text", "")
        check("money/date fidelity", re.search(r"2,?500", t) is not None and "15" in t and "Rahul" in t, repr(t))

        # 5. Hinglish.
        r = dictate(token, hinglish, "dictate", "clean", app=WHATSAPP)
        check("hinglish transcribes", r["_status"] == 200 and "5" in r.get("text", "") and "Priya" in r.get("text", ""), repr(r.get("text")))

        # 6. Hold: edit a selection.
        sel = "hey can u send me the deck by tmrw, need it for the 3pm call thx"
        r = dictate(token, edit, "command", app=GMAIL, selection=sel)
        t = r.get("text", "")
        check("edit mode rewrites the selection", r["_status"] == 200 and t and t != sel and "3" in t, repr(t))

        # 7. Long recording.
        r = dictate(token, long_text, "dictate", "clean", app=GMAIL)
        check(f"long recording ({duration(long_text):.0f}s)", r["_status"] == 200 and words(r.get("text")) > 60, f"{r['_ms']} ms, {words(r.get('text'))} words")

        # 8. Load: 10 at once.
        with cf.ThreadPoolExecutor(10) as pool:
            rs = list(pool.map(lambda i: dictate(token, msg, "dictate", ["clean", "short", "formal"][i % 3], app=WHATSAPP), range(10)))
        ok = [r for r in rs if r["_status"] == 200 and r.get("text")]
        ms = sorted(r["_ms"] for r in rs)
        check("10 parallel dictations all succeed", len(ok) == 10, f"{len(ok)}/10 ok, p50={ms[len(ms) // 2]} ms, max={ms[-1]} ms, errors={[r.get('error') for r in rs if r['_status'] != 200][:2]}")

        v2_checks(token, check)

        # 9. Bad input is rejected cleanly.
        s, body = http("POST", "/functions/v1/dictate", raw=b"junk", headers={"authorization": f"Bearer {token}", "content-type": "text/plain"})
        check("garbage request gets a 4xx, not a crash", 400 <= s < 500, f"{s} {body}")
        s, body = http("POST", "/functions/v1/rewrite", {"text": "hi", "mode": "dictate"}, headers={"authorization": "Bearer not-a-token"})
        check("bad token is refused", s == 401, f"{s}")
        # 10. Delete the account (App Store requirement); the user is gone after.
        r = call("POST", "/functions/v1/delete_account", token, body={})
        deleted = r["_status"] == 200 and r.get("deleted") is True
        check("delete_account deletes the user", deleted, f"{r['_status']} {r.get('error', '')}")
        s, me = http("GET", "/auth/v1/user", headers={"authorization": f"Bearer {token}"})
        check("deleted user's token no longer works", s != 200, f"{s}")
    finally:
        if uid and admin and not deleted:
            http("DELETE", f"/auth/v1/admin/users/{uid}", headers=admin)

    if RATE_LIMITED["count"]:
        print(f"(waited out the per-minute limit {RATE_LIMITED['count']} time(s))")
    passed = sum(1 for _, ok, _ in results if ok)
    summary = [f"## PromptFlow live stress test: {passed}/{len(results)} passed", "", "| | Check | Detail |", "|---|---|---|"]
    for name, ok, detail in results:
        summary.append(f"| {'✅' if ok else '❌'} | {name} | {detail.replace('|', '/').replace(chr(10), ' ')[:300]} |")
    report = "\n".join(summary)
    print("\n" + report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(report + "\n")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
