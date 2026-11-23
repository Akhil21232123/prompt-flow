import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Loader2, Mail } from "lucide-react";
import { commands } from "@/bindings";
import { apiErrorMessage } from "@/lib/cloud";

const CODE_LENGTH = 6;
const RESEND_AFTER_S = 30;

interface SignInProps {
  /** Called once signed in (by code here, or by the emailed link). */
  onSignedIn?: () => void;
  /** A sign-in link that failed, with the server's reason. */
  linkError?: string | null;
  compact?: boolean;
}

/** Email → "we sent you a link and a code" → 6-digit code. */
export const SignIn: React.FC<SignInProps> = ({
  onSignedIn,
  linkError,
  compact = false,
}) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const boxes = useRef<Array<HTMLInputElement | null>>([]);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (linkError) setError(linkError);
  }, [linkError]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  useEffect(() => {
    if (step === "code") boxes.current[0]?.focus();
    else emailRef.current?.focus();
  }, [step]);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const sendCode = async () => {
    if (!emailValid || busy) return;
    setBusy(true);
    setError(null);
    const r = await commands.authSendCode(email.trim());
    setBusy(false);
    if (r.status === "ok") {
      setStep("code");
      setDigits(Array(CODE_LENGTH).fill(""));
      setResendIn(RESEND_AFTER_S);
    } else {
      setError(apiErrorMessage(t, r.error));
    }
  };

  const verify = async (code: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await commands.authVerifyCode(email.trim(), code);
    setBusy(false);
    if (r.status === "ok") {
      onSignedIn?.();
    } else {
      setError(apiErrorMessage(t, r.error));
      setDigits(Array(CODE_LENGTH).fill(""));
      boxes.current[0]?.focus();
    }
  };

  const setDigit = (index: number, value: string) => {
    const clean = value.replace(/\D/g, "");
    if (!clean) {
      setDigits((d) => d.map((x, i) => (i === index ? "" : x)));
      return;
    }
    // Typing or pasting several digits fills the boxes from here on.
    const next = [...digits];
    let i = index;
    for (const ch of clean) {
      if (i >= CODE_LENGTH) break;
      next[i] = ch;
      i += 1;
    }
    setDigits(next);
    if (i < CODE_LENGTH) boxes.current[i]?.focus();
    else boxes.current[CODE_LENGTH - 1]?.blur();
    const code = next.join("");
    if (code.length === CODE_LENGTH && !next.includes("")) void verify(code);
  };

  const onKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      boxes.current[index - 1]?.focus();
      setDigits((d) => d.map((x, i) => (i === index - 1 ? "" : x)));
      e.preventDefault();
    } else if (e.key === "ArrowLeft" && index > 0) {
      boxes.current[index - 1]?.focus();
    } else if (e.key === "ArrowRight" && index < CODE_LENGTH - 1) {
      boxes.current[index + 1]?.focus();
    }
  };

  const errorBox = error && (
    <p
      role="alert"
      className="text-[13px] text-pf-red bg-pf-red/10 border border-pf-red/20 rounded-xl px-3 py-2 pf-rise"
    >
      {error}
    </p>
  );

  if (step === "email") {
    return (
      <form
        className={`flex flex-col gap-3 w-full ${compact ? "" : "max-w-sm"}`}
        onSubmit={(e) => {
          e.preventDefault();
          void sendCode();
        }}
      >
        <label
          className="text-[13px] font-medium text-pf-muted"
          htmlFor="pf-email"
        >
          {t("account.signIn.emailLabel")}
        </label>
        <div className="flex items-center gap-2 rounded-xl bg-pf-surface-2 border border-pf-border focus-within:border-pf-violet transition-colors px-3">
          <Mail size={16} className="text-pf-muted shrink-0" />
          <input
            id="pf-email"
            ref={emailRef}
            type="email"
            autoComplete="email"
            spellCheck={false}
            value={email}
            placeholder={t("account.signIn.emailPlaceholder")}
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1 bg-transparent py-3 text-[15px] text-pf-text outline-none placeholder:text-pf-muted/70"
          />
        </div>
        {errorBox}
        <button
          type="submit"
          disabled={!emailValid || busy}
          className="pf-button-primary"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : null}
          {t("account.signIn.continue")}
        </button>
        <p className="text-[12px] text-pf-muted leading-relaxed">
          {t("account.signIn.noPassword")}
        </p>
      </form>
    );
  }

  return (
    <div
      className={`flex flex-col gap-4 w-full ${compact ? "" : "max-w-sm"} pf-rise`}
    >
      <div>
        <h3 className="text-[17px] font-semibold text-pf-text">
          {t("account.signIn.checkEmail")}
        </h3>
        <p className="text-[13px] text-pf-muted mt-1 leading-relaxed">
          {t("account.signIn.sentTo", { email: email.trim() })}
        </p>
      </div>
      <div
        className="flex gap-2"
        role="group"
        aria-label={t("account.signIn.codeLabel")}
      >
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => (boxes.current[i] = el)}
            value={d}
            inputMode="numeric"
            autoComplete={i === 0 ? "one-time-code" : "off"}
            aria-label={t("account.signIn.digit", { n: i + 1 })}
            maxLength={CODE_LENGTH}
            disabled={busy}
            onChange={(e) => setDigit(i, e.target.value)}
            onKeyDown={(e) => onKeyDown(i, e)}
            onFocus={(e) => e.target.select()}
            className={`w-11 h-13 text-center text-[22px] font-semibold rounded-xl bg-pf-surface-2 border outline-none transition-all text-pf-text ${
              d ? "border-pf-violet" : "border-pf-border"
            } focus:border-pf-violet focus:ring-2 focus:ring-pf-violet/30`}
            style={{ height: 52 }}
          />
        ))}
        {busy && (
          <Loader2
            size={18}
            className="animate-spin text-pf-muted self-center ms-1"
          />
        )}
      </div>
      {errorBox}
      <p className="text-[12px] text-pf-muted leading-relaxed">
        {t("account.signIn.linkHint")}
      </p>
      <div className="flex items-center gap-3 text-[13px]">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-pf-muted hover:text-pf-text transition-colors cursor-pointer"
          onClick={() => {
            setStep("email");
            setError(null);
          }}
        >
          <ArrowLeft size={14} />
          {t("account.signIn.differentEmail")}
        </button>
        <span className="flex-1" />
        <button
          type="button"
          disabled={resendIn > 0 || busy}
          className="text-pf-violet disabled:text-pf-muted disabled:cursor-default cursor-pointer"
          onClick={() => void sendCode()}
        >
          {resendIn > 0
            ? t("account.signIn.resendIn", { seconds: resendIn })
            : t("account.signIn.resend")}
        </button>
      </div>
    </div>
  );
};
