import { listen } from "@tauri-apps/api/event";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowUpRight,
  Check,
  Copy,
  CornerUpLeft,
  Eye,
  HelpCircle,
  Mic,
  Pencil,
  RotateCw,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Sparkles,
  TriangleAlert,
  Wand2,
  X,
  type LucideIcon,
} from "lucide-react";
import "./island.css";
import { commands, events } from "@/bindings";
import type {
  IslandError,
  IslandEvent,
  IslandGeometry,
  IslandMode,
  IslandView,
} from "@/bindings";
import { syncLanguageFromSettings } from "@/i18n";
import { noticeDisplay } from "@/lib/notices";
import { formatKeyCombination } from "@/lib/utils/keyboard";
import { prefersReducedMotion } from "@/lib/utils/motion";

const WAVE_BARS = 11;
const NO_GEOMETRY: IslandGeometry = {
  notch: false,
  notch_width: 0,
  notch_height: 0,
};
/** Width of each wing beside the notch. */
const WING = 92;

type Shown = { id: number; view: IslandView; geometry: IslandGeometry };

const MODE_ICON: Record<IslandMode, LucideIcon> = {
  dictate: Mic,
  engineer: Sparkles,
  command: Pencil,
  this: Eye,
  autopilot: ShieldCheck,
};

/** A spring toward `target`, written straight to the element's style. */
const useSpringSize = (
  ref: React.RefObject<HTMLDivElement>,
  target: { w: number; h: number } | null,
  onSettled: (w: number, h: number) => void,
) => {
  const state = useRef({ w: 0, h: 0, vw: 0, vh: 0, raf: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || !target) return;
    const s = state.current;
    cancelAnimationFrame(s.raf);
    if (prefersReducedMotion() || s.w === 0) {
      s.w = target.w;
      s.h = target.h;
      s.vw = 0;
      s.vh = 0;
      el.style.width = `${target.w}px`;
      el.style.height = `${target.h}px`;
      onSettled(target.w, target.h);
      return;
    }
    // Critically under-damped: a little overshoot, settles in ~400 ms.
    const stiffness = 420;
    const damping = 32;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      const ax = stiffness * (target.w - s.w) - damping * s.vw;
      const ay = stiffness * (target.h - s.h) - damping * s.vh;
      s.vw += ax * dt;
      s.vh += ay * dt;
      s.w += s.vw * dt;
      s.h += s.vh * dt;
      el.style.width = `${s.w}px`;
      el.style.height = `${s.h}px`;
      const done =
        Math.abs(target.w - s.w) < 0.4 &&
        Math.abs(target.h - s.h) < 0.4 &&
        Math.abs(s.vw) < 4 &&
        Math.abs(s.vh) < 4;
      if (done) {
        s.w = target.w;
        s.h = target.h;
        el.style.width = `${target.w}px`;
        el.style.height = `${target.h}px`;
        onSettled(target.w, target.h);
        return;
      }
      s.raf = requestAnimationFrame(step);
    };
    s.raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(s.raf);
  }, [target?.w, target?.h]);
  const reset = () => {
    cancelAnimationFrame(state.current.raf);
    state.current = { w: 0, h: 0, vw: 0, vh: 0, raf: 0 };
  };
  return reset;
};

const fmtTime = (s: number) =>
  `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const errorText = (
  t: TFunction,
  error: IslandError,
  retry: number | null,
): { title: string; body: string } => {
  const k = `island.errors.${error}`;
  return {
    title: t(`${k}.title`),
    body: t(`${k}.body`, { seconds: retry ?? 0 }),
  };
};

const Island: React.FC = () => {
  const { t } = useTranslation();
  const [shown, setShown] = useState<Shown | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [levels, setLevels] = useState<number[]>(Array(WAVE_BARS).fill(0));
  const [ready, setReady] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retryLeft, setRetryLeft] = useState<number | null>(null);
  const [retryIn, setRetryIn] = useState<number | null>(null);
  const [rated, setRated] = useState(false);
  const [engineerKey, setEngineerKey] = useState("");
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(
    null,
  );
  const smoothed = useRef<number[]>(Array(16).fill(0));
  const cardRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);

  const resetSpring = useSpringSize(cardRef, measured, (w, h) => {
    if (idRef.current) void commands.islandCardSize(idRef.current, w, h);
  });

  const kindRef = useRef<IslandView["kind"]>("hidden");
  const apply = useCallback((event: IslandEvent) => {
    const previous = kindRef.current;
    kindRef.current = event.view.kind;
    if (event.view.kind === "hidden") {
      setLeaving(true);
      return;
    }
    idRef.current = event.id;
    // A new recording starts the timer and waveform fresh.
    if (event.view.kind === "listening" && previous !== "listening") {
      setElapsed(0);
      setReady(false);
      smoothed.current = Array(16).fill(0);
      setLevels(Array(WAVE_BARS).fill(0));
    }
    if (previous === "hidden") resetSpring();
    setLeaving(false);
    setRated(false);
    setCopied(false);
    setBusy(false);
    setHovered(false);
    setShown({ id: event.id, view: event.view, geometry: event.geometry });
  }, []);

  useEffect(() => {
    const unlisten: Array<() => void> = [];
    let disposed = false;
    const add = (p: Promise<() => void>) =>
      p.then((u) => (disposed ? u() : unlisten.push(u)));
    add(
      events.islandEvent.listen((e) => {
        void syncLanguageFromSettings();
        apply(e.payload);
      }),
    );
    add(
      events.islandHover.listen((e) => {
        if (e.payload.id === idRef.current) setHovered(e.payload.hovered);
      }),
    );
    add(listen("recording-ready", () => setReady(true)));
    add(
      listen<number[]>("mic-level", (e) => {
        const next = smoothed.current.map(
          (prev, i) => prev * 0.6 + (e.payload[i] || 0) * 0.4,
        );
        smoothed.current = next;
        setLevels(next.slice(0, WAVE_BARS));
      }),
    );
    // The webview may load after the first view was sent.
    commands.islandCurrent().then((e) => {
      if (!disposed && e.view.kind !== "hidden") apply(e);
    });
    commands.getAppSettings().then((r) => {
      if (r.status === "ok")
        setEngineerKey(r.data.bindings?.prompt_engineer?.current_binding ?? "");
    });
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
  }, [apply]);

  // Fold away, then forget the view so the next one pops in fresh.
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => {
      setShown(null);
      setMeasured(null);
      resetSpring();
      setLeaving(false);
    }, 380);
    return () => clearTimeout(timer);
  }, [leaving]);

  const view = shown?.view;
  const listening = view?.kind === "listening";
  useEffect(() => {
    if (!listening) return;
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [listening, shown?.id]);

  const retryAfter = view?.kind === "error" ? view.retry_after_sec : null;
  useEffect(() => {
    setRetryLeft(retryAfter);
    if (!retryAfter) return;
    const timer = setInterval(
      () => setRetryLeft((s) => (s && s > 1 ? s - 1 : null)),
      1000,
    );
    return () => clearInterval(timer);
  }, [retryAfter, shown?.id]);

  // The automatic retry's countdown.
  const nextRetry =
    view?.kind === "error" ? (view.retry?.next_in_sec ?? null) : null;
  useEffect(() => {
    setRetryIn(nextRetry);
    if (!nextRetry) return;
    const timer = setInterval(
      () => setRetryIn((s) => (s && s > 0 ? s - 1 : s)),
      1000,
    );
    return () => clearInterval(timer);
  }, [nextRetry, shown?.id]);

  // Measure the content off-screen; the card springs to its size.
  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el || !shown) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      setMeasured((m) =>
        m && Math.abs(m.w - r.width) < 0.5 && Math.abs(m.h - r.height) < 0.5
          ? m
          : { w: Math.ceil(r.width), h: Math.ceil(r.height) },
      );
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown, copied, busy, retryLeft, retryIn, rated, levels.length]);

  if (!shown || !view) return null;
  const geometry = shown.geometry ?? NO_GEOMETRY;
  const notch = geometry.notch;
  const id = shown.id;

  const act = (fn: () => Promise<unknown> | unknown) => () => {
    if (busy) return;
    setBusy(true);
    Promise.resolve(fn()).finally(() => setBusy(false));
  };

  // ---- pieces ----------------------------------------------------------
  const modeOf = (): IslandMode | null =>
    view.kind === "listening" || view.kind === "working" || view.kind === "done"
      ? view.mode
      : view.kind === "verdict"
        ? "autopilot"
        : view.kind === "ask"
          ? "engineer"
          : null;
  const mode = modeOf();
  const ModeIcon = mode ? MODE_ICON[mode] : Wand2;

  const glyph = (
    <span className={`i-glyph mode-${mode ?? "none"}`}>
      <ModeIcon size={13} />
    </span>
  );

  const wave = (
    <div
      className={`i-wave mode-${mode ?? "none"} ${ready ? "ready" : "arming"}`}
      aria-hidden="true"
    >
      {levels.map((v, i) => (
        <i
          key={i}
          style={{
            transform: `scaleY(${Math.max(0.18, Math.min(1, 0.18 + Math.pow(v, 0.65) * 0.95))})`,
          }}
        />
      ))}
    </div>
  );

  const langChip = (lang: string) => (
    <span className="i-chip i-lang">
      {lang === "auto" ? t("island.languageAuto") : lang.toUpperCase()}
    </span>
  );

  const header = (left: React.ReactNode, right: React.ReactNode) =>
    notch ? (
      <div className="i-wings" style={{ height: geometry.notch_height }}>
        <div className="i-wing left" style={{ width: WING }}>
          {left}
        </div>
        <div style={{ width: geometry.notch_width, flex: "none" }} />
        <div className="i-wing right" style={{ width: WING }}>
          {right}
        </div>
      </div>
    ) : null;

  const modeLabel = (m: IslandMode) => t(`island.mode.${m}`);

  // ---- views -----------------------------------------------------------
  let content: React.ReactNode = null;
  let expanded = false;
  let tone = "";

  switch (view.kind) {
    case "listening": {
      const ctx = view.context;
      const contextChip = ctx && (
        <div className="i-context pf-rise">
          <Eye size={12} />
          <span>
            {ctx.app
              ? t("island.usingFrom", {
                  chars: ctx.chars.toLocaleString(),
                  app: ctx.app,
                })
              : t("island.using", {
                  chars: ctx.chars.toLocaleString(),
                })}
          </span>
          <span className="i-context-src">
            {t(`island.source.${ctx.source}`)}
          </span>
        </div>
      );
      const answeringChip = view.answering && (
        <div className="i-context pf-rise">
          <HelpCircle size={12} />
          <span>{t("island.answeringByVoice")}</span>
        </div>
      );
      // Which shortcut is running, in its own words: "Writing" never makes
      // a prompt; "Prompt for Claude" does.
      const activeLabel =
        view.mode === "dictate"
          ? t("island.active.write")
          : view.mode === "command"
            ? t("island.active.edit")
            : view.mode === "this"
              ? view.target
                ? t("island.active.thisFor", { app: view.target })
                : t("island.active.this")
              : view.target
                ? t("island.active.promptFor", { app: view.target })
                : t("island.active.prompt");
      content = notch ? (
        <>
          {header(
            <>
              {glyph}
              {wave}
            </>,
            <>
              <span className="i-timer">{fmtTime(elapsed)}</span>
              {langChip(view.language)}
            </>,
          )}
          <div className="i-body tight center">
            <span className={`i-active mode-${view.mode}`}>{activeLabel}</span>
            {answeringChip}
            {contextChip}
          </div>
        </>
      ) : (
        <>
          <div className="i-row pill">
            {glyph}
            <span className={`i-active mode-${view.mode}`}>{activeLabel}</span>
            {wave}
            <span className="i-timer">{fmtTime(elapsed)}</span>
            {langChip(view.language)}
          </div>
          {(contextChip || answeringChip) && (
            <div className="i-body tight">
              {answeringChip}
              {contextChip}
            </div>
          )}
        </>
      );
      break;
    }
    case "working": {
      const label =
        view.step === "checking"
          ? t("island.step.checking")
          : view.step === "transcribing"
            ? t("island.step.transcribing")
            : view.mode === "dictate"
              ? t("island.step.cleaning")
              : view.target
                ? t("island.step.writingFor", { app: view.target })
                : t("island.step.writing");
      const stepText = (
        <span className="i-shimmer" key={label}>
          {label}
        </span>
      );
      content = notch ? (
        <>
          {header(
            <>
              {glyph}
              <span className="i-spinner" />
            </>,
            <span className="i-mode-label">{modeLabel(view.mode)}</span>,
          )}
          <div className="i-body tight center">{stepText}</div>
        </>
      ) : (
        <div className="i-row pill">
          {glyph}
          <span className="i-spinner" />
          {stepText}
        </div>
      );
      break;
    }
    case "ask": {
      expanded = true;
      tone = "tone-ask";
      const close = (
        <button
          className="i-icon-btn"
          aria-label={t("island.close")}
          onClick={() => commands.islandClose(id)}
        >
          <X size={13} />
        </button>
      );
      content = (
        <>
          {header(
            <span className="i-glyph mode-engineer">
              <HelpCircle size={13} />
            </span>,
            close,
          )}
          <div className="i-body">
            <div className="i-title-row">
              {!notch && (
                <span className="i-glyph mode-engineer">
                  <HelpCircle size={13} />
                </span>
              )}
              <span className="i-mode-label">{t("island.ask.title")}</span>
              <span className="i-spacer" />
              {!notch && close}
            </div>
            <p className="i-question">{view.question}</p>
            {view.options.length > 0 && (
              <div className="i-options">
                {view.options.map((o, i) => (
                  <button
                    key={o}
                    className="i-option"
                    style={{ animationDelay: `${60 + i * 45}ms` }}
                    disabled={busy}
                    onClick={act(() => commands.islandAnswer(id, o))}
                  >
                    {o}
                  </button>
                ))}
              </div>
            )}
            <div className="i-actions">
              <span className="i-hint">
                {engineerKey
                  ? t("island.ask.voiceHint", {
                      shortcut: formatKeyCombination(engineerKey, "macos"),
                    })
                  : t("island.ask.voiceHintNoKey")}
              </span>
              <button
                className="i-btn ghost"
                disabled={busy}
                onClick={act(() => commands.islandAnswer(id, null))}
              >
                {t("island.ask.skip")}
              </button>
            </div>
          </div>
        </>
      );
      break;
    }
    case "done": {
      expanded = true;
      tone = view.mode === "dictate" ? "tone-dictate" : "tone-prompt";
      const label =
        view.label ??
        (view.mode === "autopilot"
          ? t("island.done.fixPasted")
          : t("island.done.pasted"));
      const memoryRow = view.memory.length > 0 && (
        <div className="i-memory" title={t("island.done.memoryUsed")}>
          <span className="i-memory-label">{t("island.done.memoryUsed")}</span>
          {view.memory.slice(0, 2).map((m) => (
            <span key={m.id || m.content} className="i-chip i-mem">
              {m.content}
            </span>
          ))}
          {view.memory.length > 2 && (
            <span className="i-chip i-mem">
              {t("island.done.more", { n: view.memory.length - 2 })}
            </span>
          )}
        </div>
      );
      const buttons = (
        <div className="i-actions">
          {view.chips.map((chip) => (
            <button
              key={chip}
              className="i-btn chip"
              disabled={busy}
              onClick={act(() => commands.islandRedo(id, chip))}
            >
              {(chip === "as_prompt" || chip === "as_written") && (
                <RotateCw size={11} />
              )}
              {t(`island.redo.${chip}`)}
            </button>
          ))}
          <span className="i-spacer" />
          {view.pasted && !view.sent && (
            <button
              className="i-btn ghost"
              aria-label={t("island.done.undo")}
              title={t("island.done.undo")}
              onClick={act(() => commands.islandUndo(id))}
            >
              <CornerUpLeft size={12} />
              <kbd>{t("island.done.undoKey")}</kbd>
            </button>
          )}
          <button
            className="i-btn ghost"
            onClick={act(async () => {
              const r = await commands.islandCopy(id);
              if (r.status === "ok") setCopied(true);
            })}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? t("island.done.copied") : t("island.done.copy")}
          </button>
        </div>
      );
      const rating = view.rateable && (
        <span className="i-rate">
          {rated ? (
            <span className="i-rate-thanks">{t("island.done.thanks")}</span>
          ) : (
            <>
              <button
                className="i-icon-btn"
                aria-label={t("island.done.good")}
                title={t("island.done.good")}
                onClick={() => {
                  setRated(true);
                  void commands.islandRate(id, true);
                }}
              >
                <ThumbsUp size={12} />
              </button>
              <button
                className="i-icon-btn"
                aria-label={t("island.done.bad")}
                title={t("island.done.bad")}
                onClick={() => {
                  setRated(true);
                  void commands.islandRate(id, false);
                }}
              >
                <ThumbsDown size={12} />
              </button>
            </>
          )}
        </span>
      );
      content = (
        <>
          {header(
            <span className="i-glyph done">
              <Check size={13} strokeWidth={3} />
            </span>,
            <span className={`i-ring ${hovered ? "paused" : ""}`} />,
          )}
          <div className="i-body">
            <div className="i-title-row">
              {!notch && (
                <span className="i-glyph done">
                  <Check size={13} strokeWidth={3} />
                </span>
              )}
              <span className="i-eyebrow">{label}</span>
              {!view.pasted && (
                <span className="i-hint-inline">
                  {view.sent
                    ? t("island.done.alreadySent")
                    : t("island.done.onClipboard")}
                </span>
              )}
              <span className="i-spacer" />
              {rating}
              {!notch && (
                <span className={`i-ring ${hovered ? "paused" : ""}`} />
              )}
            </div>
            <p className="i-preview">{view.preview}</p>
            {memoryRow}
            {buttons}
          </div>
        </>
      );
      break;
    }
    case "verdict": {
      expanded = true;
      tone = view.good ? "tone-good" : "tone-warn";
      const title = view.good
        ? t("island.verdict.good")
        : t("island.verdict.missed");
      const icon = view.good ? (
        <span className="i-glyph good">
          <Check size={13} strokeWidth={3} />
        </span>
      ) : (
        <span className="i-glyph warn">
          <TriangleAlert size={13} />
        </span>
      );
      content = (
        <>
          {header(
            icon,
            <span className="i-mode-label">{modeLabel("autopilot")}</span>,
          )}
          <div className="i-body">
            <div className="i-title-row">
              {!notch && icon}
              <span className="i-eyebrow">{title}</span>
            </div>
            {view.issues.length > 0 && (
              <ul className="i-issues">
                {view.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
            {view.good && view.issues.length === 0 && (
              <p className="i-preview muted">{t("island.verdict.goodBody")}</p>
            )}
            <div className="i-actions">
              <span className="i-spacer" />
              {!view.good && (
                <button
                  className="i-btn ghost"
                  onClick={() => commands.islandDismiss(id)}
                >
                  {t("island.verdict.dismiss")}
                </button>
              )}
              {view.has_fix && (
                <button
                  className="i-btn primary"
                  disabled={busy}
                  onClick={act(() => commands.islandSendFix(id))}
                >
                  <Wand2 size={12} />
                  {t("island.verdict.sendFix")}
                </button>
              )}
            </div>
          </div>
        </>
      );
      break;
    }
    case "error": {
      expanded = true;
      tone = "tone-error";
      const { title, body } = errorText(t, view.error, retryLeft);
      const signIn = view.error === "sign_in" || view.error === "session_ended";
      const retry = view.retry;
      const icon = (
        <span className={`i-glyph ${retry ? "warn" : "error"}`}>
          <TriangleAlert size={13} />
        </span>
      );
      const close = retry && (
        <button
          className="i-icon-btn"
          aria-label={t("island.close")}
          onClick={() => commands.islandDismiss(id)}
        >
          <X size={13} />
        </button>
      );
      content = (
        <>
          {header(icon, close)}
          <div className="i-body">
            <div className="i-title-row">
              {!notch && icon}
              <span className="i-eyebrow">
                {retry && view.error !== "timeout"
                  ? t("island.retry.title")
                  : title}
              </span>
              <span className="i-spacer" />
              {!notch && close}
            </div>
            <p className="i-preview muted">
              {retry
                ? view.error === "timeout"
                  ? t("island.retry.manual")
                  : retryIn !== null && retryIn > 0
                    ? t("island.retry.inSeconds", { seconds: retryIn })
                    : retry.next_in_sec === null
                      ? t("island.retry.gaveUp")
                      : t("island.retry.trying")
                : view.message &&
                    (view.error === "server" ||
                      view.error === "provider" ||
                      view.error === "bad_request")
                  ? view.message
                  : retryLeft === null &&
                      view.error === "rate_limited" &&
                      view.retry_after_sec
                    ? t("island.errors.rate_limited.ready")
                    : body}
            </p>
            {retry && (
              <div className="i-actions">
                <span className="i-hint">{t("island.retry.safe")}</span>
                {retry.can_paste_raw && (
                  <button
                    className="i-btn ghost"
                    disabled={busy}
                    onClick={act(() => commands.islandPasteRaw(id))}
                  >
                    {t("island.retry.pasteRaw")}
                  </button>
                )}
                <button
                  className="i-btn primary"
                  disabled={busy}
                  onClick={act(() => commands.islandRetry(id))}
                >
                  <RotateCw size={12} />
                  {t("island.retry.now")}
                </button>
              </div>
            )}
            {signIn && (
              <div className="i-actions">
                <span className="i-spacer" />
                <button
                  className="i-btn primary"
                  onClick={() => commands.islandOpenApp(id)}
                >
                  {t("island.openApp")}
                  <ArrowUpRight size={12} />
                </button>
              </div>
            )}
          </div>
        </>
      );
      break;
    }
    case "notice": {
      expanded = true;
      tone = view.notice.level === "error" ? "tone-error" : "tone-warn";
      const display = noticeDisplay(view.notice.code);
      const icon = (
        <span
          className={`i-glyph ${view.notice.level === "error" ? "error" : "warn"}`}
        >
          <TriangleAlert size={13} />
        </span>
      );
      const explanation = display.explanation?.(t);
      content = (
        <>
          {header(icon, null)}
          <div
            className="i-body clickable"
            onClick={() => commands.islandDismiss(id)}
          >
            <div className="i-title-row">
              {!notch && icon}
              <span className="i-eyebrow">{t(display.title)}</span>
            </div>
            {explanation && <p className="i-preview muted">{explanation}</p>}
          </div>
        </>
      );
      break;
    }
  }

  const style = {
    "--notch-w": `${geometry.notch_width}px`,
    "--notch-h": `${geometry.notch_height}px`,
    "--wing": `${WING}px`,
  } as React.CSSProperties;

  const minWidth = notch ? geometry.notch_width + WING * 2 : 0;

  return (
    <div className={`i-stage ${notch ? "notch" : "floating"}`} style={style}>
      {/* Same content, unconstrained, to measure the card's target size. */}
      <div
        ref={measureRef}
        className={`island measure ${expanded ? "expanded" : "compact"} ${tone}`}
        style={{ minWidth }}
        aria-hidden="true"
      >
        {content}
      </div>
      <div
        ref={cardRef}
        className={`island live ${expanded ? "expanded" : "compact"} ${tone} ${
          leaving ? "leaving" : "entering"
        } ${hovered ? "hovered" : ""}`}
        role="status"
        aria-live="polite"
      >
        <div
          className="i-inner"
          key={view.kind}
          style={measured ? { width: measured.w } : undefined}
        >
          {content}
        </div>
      </div>
    </div>
  );
};

export default Island;
