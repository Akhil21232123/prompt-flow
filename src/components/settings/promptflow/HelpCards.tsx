import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, Loader2, MessageSquareWarning } from "lucide-react";
import { commands, events } from "@/bindings";
import { apiErrorMessage, useAccount, useMacUpdate } from "@/lib/cloud";

/** "Report a problem": a note to the PromptFlow team. */
export const ReportProblem: React.FC = () => {
  const { t } = useTranslation();
  const account = useAccount();
  const [note, setNote] = useState("");
  const [includeLast, setIncludeLast] = useState(true);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setState("sending");
    setError(null);
    const r = await commands.reportProblem(note, includeLast);
    if (r.status === "ok") {
      setState("sent");
      setNote("");
    } else {
      setState("idle");
      setError(apiErrorMessage(t, r.error));
    }
  };

  return (
    <div className="pf-card p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <MessageSquareWarning size={16} className="text-pf-violet" />
        <span className="text-[14px] font-semibold text-pf-text">
          {t("help.report.title")}
        </span>
      </div>
      {!account.signedIn ? (
        <p className="text-[13px] text-pf-muted">{t("help.report.signIn")}</p>
      ) : state === "sent" ? (
        <p className="text-[13px] text-pf-mint flex items-center gap-2 pf-rise">
          <Check size={15} />
          {t("help.report.thanks")}
        </p>
      ) : (
        <>
          <textarea
            value={note}
            rows={3}
            maxLength={2000}
            placeholder={t("help.report.placeholder")}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-xl bg-pf-surface-2 border border-pf-border focus:border-pf-violet outline-none p-3 text-[14px] text-pf-text placeholder:text-pf-muted/70 resize-none"
          />
          <label className="flex items-center gap-2 text-[12.5px] text-pf-muted cursor-pointer">
            <input
              type="checkbox"
              checked={includeLast}
              onChange={(e) => setIncludeLast(e.target.checked)}
              className="accent-[var(--pf-violet)]"
            />
            {t("help.report.includeLast")}
          </label>
          {error && <p className="text-[12.5px] text-pf-red">{error}</p>}
          <button
            className="pf-button-primary small self-end"
            disabled={!note.trim() || state === "sending"}
            onClick={() => void send()}
          >
            {state === "sending" && (
              <Loader2 size={14} className="animate-spin" />
            )}
            {t("help.report.send")}
          </button>
        </>
      )}
    </div>
  );
};

/** One-click update: downloads the new build and opens it. */
export const UpdateCard: React.FC = () => {
  const { t } = useTranslation();
  const update = useMacUpdate();
  const [phase, setPhase] = useState<"idle" | "downloading" | "opened">("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = events.updateProgress.listen((e) => {
      const { received, total } = e.payload;
      if (total)
        setProgress(Math.min(100, Math.round((received / total) * 100)));
    });
    return () => {
      unlisten.then((u) => u());
    };
  }, []);

  if (!update) return null;

  const install = async () => {
    setPhase("downloading");
    setError(null);
    setProgress(0);
    const r = await commands.installMacUpdate(update.download_url);
    if (r.status === "ok") setPhase("opened");
    else {
      setPhase("idle");
      setError(r.error);
    }
  };

  return (
    <div className="pf-card p-4 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <div className="text-[14px] font-semibold text-pf-text">
            {update.available
              ? t("update.availableBuild", { build: update.latest_build ?? "" })
              : t("update.upToDate")}
          </div>
          <div className="text-[12.5px] text-pf-muted">
            {update.current_build
              ? t("update.thisBuild", { build: update.current_build })
              : t("update.description")}
          </div>
        </div>
        {update.available && phase === "idle" && (
          <button
            className="pf-button-primary small"
            onClick={() => void install()}
          >
            <Download size={14} />
            {t("update.install")}
          </button>
        )}
      </div>
      {phase === "downloading" && (
        <div className="h-1.5 rounded-full bg-pf-surface-2 overflow-hidden">
          <div
            className="h-full bg-[image:var(--pf-gradient)] transition-[width] duration-300"
            style={{ width: `${Math.max(4, progress)}%` }}
          />
        </div>
      )}
      {phase === "opened" && (
        <p className="text-[13px] text-pf-text leading-relaxed pf-rise">
          {t("update.opened")}
        </p>
      )}
      {error && <p className="text-[12.5px] text-pf-red">{error}</p>}
    </div>
  );
};
