#!/usr/bin/env python3
"""Live stress test of the deployed PromptFlow backend.

Speaks test sentences with macOS `say`, adds silence and noise clips, and
runs them all through /functions/v1/dictate as a throwaway test user, in
every mode and style, then in parallel. Prints a report and exits non-zero
if any check fails.

Env: PF_URL, PF_ANON (publishable key), and optionally PF_SERVICE (a
service-role key, to create and delete a password test user). Without it the
test signs in anonymously, which needs anonymous sign-ins switched on.
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
    admin = {"apikey": SERVICE, "authorization": f"Bearer {SERVICE}"}
    s, body = http("POST", "/auth/v1/admin/users", {"email": email, "password": password, "email_confirm": True}, headers=admin)
    assert s in (200, 201), f"create user failed: {s} {body}"
    uid = body["id"]
    s, tok = http("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": password})
    assert s == 200, f"sign-in failed: {s} {tok}"
    return uid, tok["access_token"], admin


def dictate(token, wav_path, mode, preset=None, app=None, selection=None, language="en"):
    meta = {"mode": mode, "duration_sec": duration(wav_path), "device": "stress-test", "language": language}
    if preset:
        meta["preset"] = preset
    if app:
        meta["app"] = app
    if selection:
        meta["selection"] = selection
    boundary = "PF" + uuid.uuid4().hex
    with open(wav_path, "rb") as f:
        audio = f.read()
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"meta\"\r\nContent-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
    ).encode() + audio + f"\r\n--{boundary}--\r\n".encode()
    started = time.time()
    s, res = http(
        "POST", "/functions/v1/dictate", raw=body,
        headers={"authorization": f"Bearer {token}", "content-type": f"multipart/form-data; boundary={boundary}"},
    )
    res["_status"] = s
    res["_ms"] = int((time.time() - started) * 1000)
    return res


# ------------------------------------------------------------------ cases

CHATGPT = {"name": "ChatGPT", "bundle_id": "com.openai.chat"}
WHATSAPP = {"name": "WhatsApp", "bundle_id": "net.whatsapp.WhatsApp"}
GMAIL = {"name": "Gmail", "bundle_id": "com.google.Gmail"}

MESSAGE = ("hey sam so um I wanted to let you know that the meeting tomorrow has been moved to 4 pm "
           "and uh please bring the slides for the Q3 review")
RAMBLE = ("um okay so I need you to like write me a python script that uh reads a CSV file of our sales "
          "and finds the top five products by revenue and then makes a bar chart of them, oh and it should "
          "skip rows where the price is missing")


def words(t):
    return len(re.findall(r"\w+", t or ""))


def main():
    results, failures = [], []

    def check(name, ok, detail):
        results.append((name, ok, detail))
        if not ok:
            failures.append(name)
        print(("PASS " if ok else "FAIL ") + name + " :: " + detail, flush=True)

    uid, token, admin = test_user()
    try:
        msg = speak(MESSAGE)
        ramble = speak(RAMBLE)
        money = speak("remind me to pay 2500 rupees to Rahul on the 15th of December")
        hinglish = speak("kal ki meeting 5 baje hai, please confirm with Priya", voice="Rishi")
        edit = speak("make this more formal and shorter")
        long_text = speak(" ".join([MESSAGE, RAMBLE, MESSAGE]))

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
              f"{r['_ms']} ms, {words(t)} words, label={r.get('label')!r}")
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

        # 9. Bad input is rejected cleanly.
        s, body = http("POST", "/functions/v1/dictate", raw=b"junk", headers={"authorization": f"Bearer {token}", "content-type": "text/plain"})
        check("garbage request gets a 4xx, not a crash", 400 <= s < 500, f"{s} {body}")
        s, body = http("POST", "/functions/v1/rewrite", {"text": "hi", "mode": "dictate"}, headers={"authorization": "Bearer not-a-token"})
        check("bad token is refused", s == 401, f"{s}")
    finally:
        if uid and admin:
            http("DELETE", f"/auth/v1/admin/users/{uid}", headers=admin)

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
