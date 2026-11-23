import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Accessibility,
  ArrowRight,
  Check,
  Eye,
  Mic,
  MonitorUp,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { commands, events } from "@/bindings";
import type { IslandView } from "@/bindings";
import { SignIn } from "@/components/account/SignIn";
import { Keycaps } from "@/components/shared/Keycaps";
import { Switch } from "@/components/ui/Switch";
import { useSettings } from "@/hooks/useSettings";
import { useOsType } from "@/hooks/useOsType";
import { useAccount } from "@/lib/cloud";
import {
  askFor,
  useMacPermissions,
} from "@/components/settings/promptflow/PermissionsCard";

const STEPS = [
  "welcome",
  "signin",
  "microphone",
  "accessibility",
  "try",
  "done",
] as const;
type Step = (typeof STEPS)[number];
const STEP_KEY = "promptflow.onboarding.step";

const savedStep = (): Step => {
  const s = localStorage.getItem(STEP_KEY) as Step | null;
  return s && STEPS.includes(s) ? s : "welcome";
};

export const clearPromptFlowOnboarding = () =>
  localStorage.removeItem(STEP_KEY);

/** The first run: welcome → sign in → microphone → accessibility → try it → done. */
export const PromptFlowOnboarding: React.FC<{ onComplete: () => void }> = ({
  onComplete,
}) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(savedStep);
  const account = useAccount();
  const { state: perms } = useMacPermissions();
  const { updateSetting } = useSettings();
  const [atLogin, setAtLogin] = useState(true);
  const initialized = useRef(false);

  useEffect(() => localStorage.setItem(STEP_KEY, step), [step]);

  const go = (to: Step) => setStep(to);
  const next = () => {
    const i = STEPS.indexOf(step);
    if (i < STEPS.length - 1) go(STEPS[i + 1]);
  };

  // Shortcuts and input need Accessibility; start them as soon as it's on,
  // so "Try it" works without a relaunch.
  useEffect(() => {
    if (perms?.accessibility && !initialized.current) {
      initialized.current = true;
      Promise.all([
        commands.initializeEnigo(),
        commands.initializeShortcuts(),
      ]).catch((e) => console.warn("Failed to initialize input:", e));
    }
  }, [perms?.accessibility]);

  // Steps that are already done move on by themselves.
  useEffect(() => {
    if (step === "signin" && account.signedIn) {
      const timer = setTimeout(next, 700);
      return () => clearTimeout(timer);
    }
    if (step === "microphone" && perms?.microphone) {
      const timer = setTimeout(next, 700);
      return () => clearTimeout(timer);
    }
    if (step === "accessibility" && perms?.accessibility) {
      const timer = setTimeout(next, 700);
      return () => clearTimeout(timer);
    }
  }, [step, account.signedIn, perms?.microphone, perms?.accessibility]);

  const finish = async () => {
    await updateSetting("autostart_enabled", atLogin);
    await commands.completeOnboarding();
    clearPromptFlowOnboarding();
    onComplete();
  };

  const index = STEPS.indexOf(step);

  return (
    <div className="h-screen w-screen bg-pf-bg text-pf-text flex flex-col select-none overflow-hidden relative">
      <div
        className="absolute -top-40 left-1/2 -translate-x-1/2 w-[720px] h-[420px] rounded-full opacity-40 blur-3xl pointer-events-none"
        style={{ background: "var(--pf-gradient)" }}
        aria-hidden="true"
      />
      <div className="relative flex items-center justify-center gap-1.5 pt-6">
        {STEPS.map((s, i) => (
          <span
            key={s}
            className={`h-1.5 rounded-full transition-all duration-500 ${
              i === index
                ? "w-6 bg-[image:var(--pf-gradient)]"
                : i < index
                  ? "w-1.5 bg-pf-violet/70"
                  : "w-1.5 bg-pf-border-strong"
            }`}
          />
        ))}
      </div>
      <div className="relative flex-1 flex items-center justify-center px-8 overflow-y-auto">
        <div key={step} className="w-full max-w-md pf-rise py-8">
          {step === "welcome" && <Welcome onNext={next} />}
          {step === "signin" && (
            <StepFrame
              icon={Sparkles}
              title={t("onboardingPf.signin.title")}
              body={t("onboardingPf.signin.body")}
            >
              {account.signedIn ? (
                <Granted
                  text={t("onboardingPf.signin.done", {
                    email: account.email ?? "",
                  })}
                />
              ) : (
                <SignIn linkError={account.linkError} compact />
              )}
            </StepFrame>
          )}
          {step === "microphone" && (
            <StepFrame
              icon={Mic}
              title={t("onboardingPf.microphone.title")}
              body={t("onboardingPf.microphone.body")}
            >
              {perms?.microphone ? (
                <Granted text={t("onboardingPf.granted")} />
              ) : (
                <button
                  className="pf-button-primary w-full"
                  onClick={() => void askFor("microphone")}
                >
                  {t("onboardingPf.microphone.allow")}
                </button>
              )}
            </StepFrame>
          )}
          {step === "accessibility" && (
            <StepFrame
              icon={Accessibility}
              title={t("onboardingPf.accessibility.title")}
              body={t("onboardingPf.accessibility.body")}
            >
              {perms?.accessibility ? (
                <Granted text={t("onboardingPf.granted")} />
              ) : (
                <div className="flex flex-col gap-3">
                  <button
                    className="pf-button-primary w-full"
                    onClick={() => void askFor("accessibility")}
                  >
                    {t("onboardingPf.accessibility.open")}
                  </button>
                  <ol className="text-[12.5px] text-pf-muted leading-relaxed list-decimal ps-5 flex flex-col gap-1">
                    <li>{t("onboardingPf.accessibility.step1")}</li>
                    <li>{t("onboardingPf.accessibility.step2")}</li>
                    <li>{t("onboardingPf.accessibility.step3")}</li>
                  </ol>
                </div>
              )}
            </StepFrame>
          )}
          {step === "try" && <TryIt onNext={next} />}
          {step === "done" && (
            <StepFrame
              icon={Check}
              title={t("onboardingPf.done.title")}
              body={t("onboardingPf.done.body")}
            >
              <div className="flex flex-col gap-3">
                <ScreenRecordingOffer allowed={perms?.screen ?? false} />
                <label className="pf-card px-4 py-3 flex items-center gap-3 cursor-pointer">
                  <span className="flex-1 text-[13.5px]">
                    {t("onboardingPf.done.atLogin")}
                  </span>
                  <Switch
                    checked={atLogin}
                    onChange={setAtLogin}
                    ariaLabel={t("onboardingPf.done.atLogin")}
                  />
                </label>
                <button
                  className="pf-button-primary w-full"
                  onClick={() => void finish()}
                >
                  {t("onboardingPf.done.finish")}
                </button>
              </div>
            </StepFrame>
          )}
          {index > 0 && step !== "done" && (
            <div className="flex justify-between mt-6 text-[13px]">
              <button
                className="text-pf-muted hover:text-pf-text transition-colors cursor-pointer"
                onClick={() => go(STEPS[index - 1])}
              >
                {t("onboardingPf.back")}
              </button>
              {(step === "microphone" || step === "accessibility") && (
                <button
                  className="text-pf-muted hover:text-pf-text transition-colors cursor-pointer"
                  onClick={next}
                >
                  {t("onboardingPf.later")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const StepFrame: React.FC<{
  icon: LucideIcon;
  title: string;
  body: string;
  children: React.ReactNode;
}> = ({ icon: Icon, title, body, children }) => (
  <div className="flex flex-col gap-6">
    <div className="flex flex-col gap-3">
      <div className="w-12 h-12 rounded-2xl bg-[image:var(--pf-gradient)] flex items-center justify-center text-white shadow-[0_10px_30px_-12px_var(--pf-violet)]">
        <Icon size={22} />
      </div>
      <h1 className="text-[26px] font-semibold tracking-tight leading-tight">
        {title}
      </h1>
      <p className="text-[14.5px] text-pf-muted leading-relaxed">{body}</p>
    </div>
    {children}
  </div>
);

const Granted: React.FC<{ text: string }> = ({ text }) => (
  <div className="pf-card px-4 py-3 flex items-center gap-3 pf-rise">
    <span className="w-7 h-7 rounded-full bg-pf-mint/15 text-pf-mint flex items-center justify-center">
      <Check size={15} strokeWidth={3} />
    </span>
    <span className="text-[14px] font-medium">{text}</span>
  </div>
);

const Welcome: React.FC<{ onNext: () => void }> = ({ onNext }) => {
  const { t } = useTranslation();
  const points: { icon: LucideIcon; key: string }[] = [
    { icon: Mic, key: "speak" },
    { icon: Sparkles, key: "prompts" },
    { icon: Eye, key: "this" },
    { icon: ShieldCheck, key: "autopilot" },
  ];
  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-3">
        <div className="w-14 h-14 rounded-[18px] bg-[image:var(--pf-gradient)] flex items-center justify-center text-white shadow-[0_14px_40px_-14px_var(--pf-violet)]">
          <Sparkles size={26} />
        </div>
        <h1 className="text-[32px] font-semibold tracking-tight leading-[1.1]">
          {t("onboardingPf.welcome.title")}{" "}
          <span className="pf-gradient-text">
            {t("onboardingPf.welcome.titleAccent")}
          </span>
        </h1>
        <p className="text-[15px] text-pf-muted leading-relaxed">
          {t("onboardingPf.welcome.body")}
        </p>
      </div>
      <ul className="flex flex-col gap-3">
        {points.map(({ icon: Icon, key }, i) => (
          <li
            key={key}
            className="flex items-start gap-3 pf-rise"
            style={{ animationDelay: `${120 + i * 70}ms` }}
          >
            <span className="w-8 h-8 rounded-xl bg-pf-surface-2 border border-pf-border flex items-center justify-center text-pf-violet shrink-0">
              <Icon size={15} />
            </span>
            <span className="text-[14px] leading-relaxed pt-1">
              {t(`onboardingPf.welcome.points.${key}`)}
            </span>
          </li>
        ))}
      </ul>
      <button className="pf-button-primary w-full" onClick={onNext}>
        {t("onboardingPf.welcome.start")}
        <ArrowRight size={16} />
      </button>
    </div>
  );
};

/** Dictate into a box here, with the real shortcut and the real island. */
const TryIt: React.FC<{ onNext: () => void }> = ({ onNext }) => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const os = useOsType();
  const binding = getSetting("bindings")?.transcribe?.current_binding ?? "";
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<IslandView["kind"]>("hidden");
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    box.current?.focus();
    const unlisten = events.islandEvent.listen((e) =>
      setPhase(e.payload.view.kind),
    );
    return () => {
      unlisten.then((u) => u());
    };
  }, []);

  const worked = text.trim().length > 0;
  const hint = worked
    ? t("onboardingPf.try.worked")
    : phase === "listening"
      ? t("onboardingPf.try.listening")
      : phase === "working"
        ? t("onboardingPf.try.working")
        : phase === "error" || phase === "notice"
          ? t("onboardingPf.try.problem")
          : t("onboardingPf.try.idle");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-[26px] font-semibold tracking-tight leading-tight">
          {t("onboardingPf.try.title")}
        </h1>
        <p className="text-[14.5px] text-pf-muted leading-relaxed">
          {t("onboardingPf.try.body")}
        </p>
        {binding && (
          <div className="flex items-center gap-3 text-[13px] text-pf-muted">
            <Keycaps binding={binding} osType={os} />
            <span>{t("onboardingPf.try.holdHint")}</span>
          </div>
        )}
      </div>
      <div
        className={`pf-card p-1 transition-all ${
          phase === "listening"
            ? "ring-2 ring-pf-violet/60"
            : worked
              ? "ring-2 ring-pf-mint/50"
              : ""
        }`}
      >
        <textarea
          ref={box}
          value={text}
          rows={4}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("onboardingPf.try.placeholder")}
          className="w-full bg-transparent outline-none resize-none p-3 text-[15px] leading-relaxed placeholder:text-pf-muted/70"
        />
      </div>
      <p
        className={`text-[13px] ${worked ? "text-pf-mint" : "text-pf-muted"}`}
        aria-live="polite"
      >
        {hint}
      </p>
      <button className="pf-button-primary w-full" onClick={onNext}>
        {worked ? t("onboardingPf.try.next") : t("onboardingPf.try.skip")}
        <ArrowRight size={16} />
      </button>
    </div>
  );
};

const ScreenRecordingOffer: React.FC<{ allowed: boolean }> = ({ allowed }) => {
  const { t } = useTranslation();
  return (
    <div className="pf-card px-4 py-3 flex items-center gap-3">
      <span
        className={`w-8 h-8 rounded-xl flex items-center justify-center ${
          allowed ? "bg-pf-mint/15 text-pf-mint" : "bg-pf-blue/15 text-pf-blue"
        }`}
      >
        {allowed ? <Check size={15} /> : <MonitorUp size={15} />}
      </span>
      <div className="flex-1">
        <div className="text-[13.5px] font-medium">
          {t("onboardingPf.done.screenTitle")}
        </div>
        <div className="text-[12px] text-pf-muted">
          {t("onboardingPf.done.screenBody")}
        </div>
      </div>
      {!allowed && (
        <button
          className="pf-button-secondary"
          onClick={() => void askFor("screen_recording")}
        >
          {t("permissions.allow")}
        </button>
      )}
    </div>
  );
};
