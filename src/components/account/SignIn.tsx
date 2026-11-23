import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Loader2, Mail } from "lucide-react";
import { commands } from "@/bindings";
import { apiErrorMessage } from "@/lib/cloud";

/** Codes are 6 digits, but the email service may send up to 8. */
const CODE_MIN = 6;
const CODE_MAX = 8;
/** A 6-digit code is sent once typing pauses this long (more digits may be
 * coming); an 8-digit one at once; anything else on Enter. */
const PAUSE_MS = 900;
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
  const [code, setCode] = useState("");
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);
  const tried = useRef("");
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
    if (step === "code") codeRef.current?.focus();
    else emailRef.current?.focus();
  }, [step]);

  // Send the code when it's complete: at once at 8 digits, or when typing
  // pauses at exactly 6. A code that already failed isn't sent again.
  useEffect(() => {
    if (step !== "code" || busy || code === tried.current) return;
    if (code.length !== CODE_MIN && code.length !== CODE_MAX) return;
    const timer = setTimeout(
      () => void verify(code),
      code.length === CODE_MAX ? 0 : PAUSE_MS,
    );
    return () => clearTimeout(timer);
  }, [code, step, busy]);

  // After a wrong code, the field is ready to retype (it was disabled while
  // checking, so focus is put back once it's enabled again).
  useEffect(() => {
    if (step === "code" && !busy && error) {
      codeRef.current?.focus();
      codeRef.current?.select();
    }
  }, [busy, error, step]);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const sendCode = async () => {
    if (!emailValid || busy) return;
    setBusy(true);
    setError(null);
    const r = await commands.authSendCode(email.trim());
    setBusy(false);
    if (r.status === "ok") {
      setStep("code");
      setCode("");
      tried.current = "";
      setResendIn(RESEND_AFTER_S);
    } else {
      setError(apiErrorMessage(t, r.error));
    }
  };

  const verify = async (value: string) => {
    if (busy || value.length < CODE_MIN) return;
    tried.current = value;
    setBusy(true);
    setError(null);
    const r = await commands.authVerifyCode(email.trim(), value);
    setBusy(false);
    if (r.status === "ok") {
      onSignedIn?.();
    } else {
      setError(apiErrorMessage(t, r.error));
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
      <div className="relative self-start">
        {/* One real field (typing, paste, autofill of any length) drawn as slots. */}
        <input
          ref={codeRef}
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label={t("account.signIn.codeLabel")}
          maxLength={CODE_MAX + 4}
          disabled={busy}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setError(null);
            setCode(e.target.value.replace(/\D/g, "").slice(0, CODE_MAX));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && code.length >= CODE_MIN) {
              tried.current = "";
              void verify(code);
            }
          }}
          className="absolute inset-0 w-full h-full opacity-0 cursor-text"
        />
        <div className="flex gap-2 pointer-events-none" aria-hidden="true">
          {Array.from({
            length: code.length > CODE_MIN ? CODE_MAX : CODE_MIN,
          }).map((_, i) => {
            const d = code[i] ?? "";
            const active =
              focused && !busy && i === Math.min(code.length, CODE_MAX - 1);
            return (
              <div
                key={i}
                className={`w-11 flex items-center justify-center text-[22px] font-semibold rounded-xl bg-pf-surface-2 border transition-all text-pf-text ${
                  i >= CODE_MIN ? "pf-rise" : ""
                } ${
                  active
                    ? "border-pf-violet ring-2 ring-pf-violet/30"
                    : d
                      ? "border-pf-violet/60"
                      : "border-pf-border"
                }`}
                style={{ height: 52 }}
              >
                {d}
                {active && !d && (
                  <span className="w-px h-6 bg-pf-violet animate-pulse" />
                )}
              </div>
            );
          })}
          {busy && (
            <Loader2
              size={18}
              className="animate-spin text-pf-muted self-center ms-1"
            />
          )}
        </div>
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
