#!/usr/bin/env python3
"""Does the Mac app's noise filter help speech recognition on real Whisper?

macOS only (uses `say` and `afconvert`). Speaks a few sentences, mixes them
with pink noise, traffic-like noise and café babble (other `say` voices) at
0, 5, 10 and 20 dB SNR, and sends each clip through the deployed /dictate as a
throwaway user twice: as recorded, and after RNNoise (the `nnnoiseless` CLI,
the same library the app uses). Compares word error rate on the raw
transcript. Prints a table and the SNR below which denoising helps.

Env: PF_URL, PF_ANON, PF_SERVICE (as stress_test.py). Needs numpy and the
nnnoiseless binary on PATH (`cargo install nnnoiseless`).
"""

import os
import re
import subprocess
import sys
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import json  # noqa: E402
import uuid  # noqa: E402

from stress_test import TMP, call, dictate, duration, test_user  # noqa: E402

SR = 48000
SENTENCES = [
    "Please send the quarterly report to the finance team before the meeting tomorrow afternoon.",
    "Write a short email to Priya saying the shipment from Jaipur is delayed until next week.",
    "Can you summarize the main risks of launching our product in the United States market.",
]
BABBLE = [
    "I think we should get the pasta and maybe some coffee after that.",
    "No, the train was late again this morning, it was so crowded.",
    "Did you see the match last night, the last over was unbelievable.",
    "She said the rent is going up again next month, can you believe it.",
]
SNRS = [0, 5, 10, 20]
NUMBERS = {"0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five"}


def say(text, voice, path):
    aiff = path + ".aiff"
    if subprocess.run(["say", "-v", voice, "-o", aiff, text]).returncode != 0:
        subprocess.run(["say", "-o", aiff, text], check=True)
    subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{SR}", "-c", "1", aiff, path], check=True)
    return read(path)


def read(path):
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def write(path, x, sr=SR):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes())


def to16k(path48):
    out = path48.replace(".wav", "_16k.wav")
    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", path48, out], check=True)
    return out


def rms(x):
    return float(np.sqrt(np.mean(x**2)) + 1e-12)


def pink(n, rng):
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.arange(len(spec))
    spec[1:] /= np.sqrt(f[1:])
    return np.fft.irfft(spec, n)


def traffic(n, rng):
    # Engine rumble (brown noise, low-passed), slow swells as cars pass, and
    # a couple of horn blasts.
    brown = np.cumsum(rng.standard_normal(n))
    brown -= np.convolve(brown, np.ones(4801) / 4801, mode="same")
    t = np.arange(n) / SR
    swell = 0.6 + 0.4 * np.sin(2 * np.pi * 0.15 * t + rng.uniform(0, 6))
    x = brown * swell
    for start in rng.uniform(0.5, max(0.6, n / SR - 1), 2):
        i = int(start * SR)
        seg = np.arange(min(int(0.4 * SR), n - i)) / SR
        x[i : i + len(seg)] += 3 * rms(x) * np.sin(2 * np.pi * 440 * seg) * np.sign(np.sin(2 * np.pi * 3 * seg))
    return x


def babble(n, voices):
    x = np.zeros(n, dtype=np.float32)
    for i, v in enumerate(voices):
        v = np.tile(v, int(np.ceil(n / len(v))))[:n]
        x += np.roll(v, i * SR // 3)
    return x


def mix(speech, noise, snr_db):
    active = speech[np.abs(speech) > 0.02]
    s = rms(active if len(active) else speech)
    noise = noise * (s / rms(noise)) / (10 ** (snr_db / 20))
    pad = int(0.5 * SR)  # half a second of noise before and after, as on a street
    out = np.concatenate([noise[:pad], speech + noise[pad : pad + len(speech)], noise[pad + len(speech) : 2 * pad + len(speech)]])
    peak = np.max(np.abs(out))
    return out / peak * 0.9 if peak > 0.99 else out


def words(t):
    t = t.lower()
    for d, w in NUMBERS.items():
        t = re.sub(rf"\b{d}\b", w, t)
    return re.findall(r"[a-z']+", t)


def wer(ref, hyp):
    r, h = words(ref), words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))


def denoise(path48):
    out = path48.replace(".wav", "_dn.wav")
    subprocess.run(["nnnoiseless", path48, out], check=True, capture_output=True)
    return out


def transcribe(token, path16):
    r = dictate(token, path16, "dictate")
    return (r.get("raw") or "") if r.get("_status") == 200 else f"<error {r.get('_status')} {r.get('error', '')}>"


def transcribe_both(token, raw16, clean16):
    """One request with both recordings; the server keeps the surer one."""
    boundary = "PF" + uuid.uuid4().hex
    meta = {"mode": "dictate", "device": "noise-eval", "language": "en", "duration_sec": duration(raw16)}
    body = f"--{boundary}\r\nContent-Disposition: form-data; name=\"meta\"\r\nContent-Type: application/json\r\n\r\n{json.dumps(meta)}\r\n".encode()
    for name, path in (("audio", raw16), ("audio_clean", clean16)):
        with open(path, "rb") as f:
            data = f.read()
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{name}.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    r = call("POST", "/functions/v1/dictate", token, raw=body, content_type=f"multipart/form-data; boundary={boundary}")
    if r.get("_status") != 200:
        return f"<error {r.get('_status')} {r.get('error', '')}>", "?"
    cands = " ".join(f"{c.get('from')}:{c.get('confidence') if c.get('confidence') is None else round(c['confidence'], 3)}/{c.get('words')}w" for c in r.get("stt_candidates") or [])
    return r.get("raw") or "", f"{(r.get('timing') or {}).get('heard_from', '?')} [{cands}]"


def main():
    rng = np.random.default_rng(7)
    speech = [say(s, "Samantha", os.path.join(TMP, f"s{i}.wav")) for i, s in enumerate(SENTENCES)]
    voices = [say(t, v, os.path.join(TMP, f"b{i}.wav")) for i, (t, v) in enumerate(zip(BABBLE, ["Daniel", "Karen", "Moira", "Alex"]))]
    rows = []  # (noise, snr, wer_raw, wer_denoised)
    uid, token, admin = test_user()
    try:
        for i, s in enumerate(speech):
            p = os.path.join(TMP, f"clean{i}.wav")
            write(p, np.concatenate([np.zeros(SR // 2), s, np.zeros(SR // 2)]))
            r16, d16 = to16k(p), to16k(denoise(p))
            raw, dn = transcribe(token, r16), transcribe(token, d16)
            both, picked = transcribe_both(token, r16, d16)
            rows.append(("clean", 99, wer(SENTENCES[i], raw), wer(SENTENCES[i], dn), wer(SENTENCES[i], both)))
            print(f"clean #{i}: raw={raw!r}\n          dn ={dn!r}\n          picked {picked}")
        for kind in ["pink", "traffic", "cafe"]:
            for snr in SNRS:
                for i, s in enumerate(speech):
                    n = len(s) + SR
                    noise = pink(n, rng) if kind == "pink" else traffic(n, rng) if kind == "traffic" else babble(n, voices)
                    p = os.path.join(TMP, f"{kind}{snr}_{i}.wav")
                    write(p, mix(s, noise, snr))
                    r16, d16 = to16k(p), to16k(denoise(p))
                    raw, dn = transcribe(token, r16), transcribe(token, d16)
                    both, picked = transcribe_both(token, r16, d16)
                    rows.append((kind, snr, wer(SENTENCES[i], raw), wer(SENTENCES[i], dn), wer(SENTENCES[i], both)))
                    print(f"{kind} {snr:>2} dB #{i}: raw={raw!r}\n               dn ={dn!r}\n               picked {picked}: {both!r}")
    finally:
        call("POST", "/functions/v1/delete_account", token, body={})

    lines = ["\n## Noise filter vs Whisper (word error rate, lower is better)", "", "| noise | SNR dB | raw | denoised | both, server picks |", "|---|---|---|---|---|"]
    for kind in ["clean", "pink", "traffic", "cafe"]:
        for snr in ([99] if kind == "clean" else SNRS):
            sel = [r for r in rows if r[0] == kind and r[1] == snr]
            a = np.mean([r[2] for r in sel])
            b = np.mean([r[3] for r in sel])
            c = np.mean([r[4] for r in sel])
            label = "quiet" if snr == 99 else str(snr)
            lines.append(f"| {kind} | {label} | {a:.0%} | {b:.0%} | {c:.0%} |")
    report = "\n".join(lines)
    print(report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(report + "\n")


if __name__ == "__main__":
    main()
