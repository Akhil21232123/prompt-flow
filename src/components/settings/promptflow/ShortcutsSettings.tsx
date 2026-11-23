import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, TriangleAlert } from "lucide-react";
import { commands } from "@/bindings";
import type { ShortcutProblem } from "@/bindings";
import { formatKeyCombination } from "@/lib/utils/keyboard";
import { useSettings } from "@/hooks/useSettings";
import { useOsType } from "@/hooks/useOsType";
import { ShortcutInput } from "../ShortcutInput";
import { ShortcutActivationSetting } from "../ShortcutActivation";
import { PfCard, PfPage } from "./ui";
import { PermissionRows, useMacPermissions } from "./PermissionsCard";
import { FnKeyCard } from "./FnKeyCard";

/** The extras: off until the user gives them a key. */
const ADVANCED = [
  "smart",
  "prompt_engineer",
  "this",
  "command_mode",
  "autopilot",
  "cancel",
] as const;

/** Re-reads `read` every 2 s (the user may be in System Settings). */
const usePolled = <T,>(read: () => Promise<T>, initial: T) => {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    let disposed = false;
    const tick = () =>
      read()
        .then((v) => !disposed && setValue(v))
        .catch((e) => console.warn("Status check failed:", e));
    void tick();
    const timer = setInterval(tick, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  return value;
};

/** Whether Spotlight still has ⌘Space. */
export const useSpotlightOwnsCmdSpace = () =>
  usePolled(() => commands.spotlightOwnsCmdSpace(), false);

/** The one step that frees ⌘Space: PromptFlow never changes it itself. */
export const SpotlightStep: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const owned = useSpotlightOwnsCmdSpace();
  const plain = getSetting("bindings")?.transcribe?.current_binding ?? "";
  if (!owned || plain !== "command+space") return null;
  return (
    <div className="px-4 py-3 flex items-center gap-3 bg-pf-amber/5 pf-rise">
      <Search size={16} className="text-pf-amber shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-pf-text">
          {t("shortcuts.spotlight.title")}
        </div>
        <div className="text-[12.5px] text-pf-muted leading-relaxed">
          {t("shortcuts.spotlight.body")}
        </div>
      </div>
      <button
        className="pf-button-secondary shrink-0"
        onClick={() => void commands.openKeyboardShortcuts()}
      >
        {t("shortcuts.spotlight.open")}
      </button>
    </div>
  );
};

/** Keys that are set but didn't register, said plainly. */
const ShortcutProblems: React.FC<{ ids: readonly string[] }> = ({ ids }) => {
  const { t } = useTranslation();
  const os = useOsType();
  const problems = usePolled<ShortcutProblem[]>(
    () => commands.shortcutProblems(),
    [],
  );
  const shown = problems.filter((p) => ids.includes(p.id));
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((p) => (
        <div
          key={p.id}
          className="px-4 py-3 flex items-start gap-3 bg-pf-amber/5"
          role="alert"
        >
          <TriangleAlert size={16} className="text-pf-amber shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0 text-[12.5px] leading-relaxed">
            <div className="text-pf-text">
              {t("shortcuts.problem", {
                keys: formatKeyCombination(p.binding, os),
              })}
            </div>
            <div className="text-pf-muted">{p.error}</div>
          </div>
        </div>
      ))}
    </>
  );
};

export const ShortcutsSettings: React.FC = () => {
  const { t } = useTranslation();
  const { state } = useMacPermissions();
  return (
    <PfPage title={t("shortcuts.title")} subtitle={t("shortcuts.subtitle")}>
      <PfCard title={t("shortcuts.keys")} bare>
        <FnKeyCard />
        <div className="pf-card divide-y divide-pf-border">
          <ShortcutInput
            shortcutId="transcribe"
            descriptionMode="inline"
            grouped={true}
          />
          <SpotlightStep />
          <ShortcutInput
            shortcutId="transcribe_alt"
            descriptionMode="inline"
            grouped={true}
            clearable
          />
          <ShortcutProblems ids={["transcribe", "transcribe_alt"]} />
        </div>
      </PfCard>
      <PfCard title={t("shortcuts.activation")}>
        <ShortcutActivationSetting descriptionMode="inline" grouped={true} />
      </PfCard>
      <PfCard
        title={t("shortcuts.permissions")}
        description={t("shortcuts.permissionsDescription")}
        bare
      >
        <PermissionRows state={state} />
      </PfCard>
      <PfCard
        title={t("shortcuts.advanced.title")}
        description={t("shortcuts.advanced.description")}
      >
        {ADVANCED.map((id) => (
          <ShortcutInput
            key={id}
            shortcutId={id}
            descriptionMode="inline"
            grouped={true}
            clearable={id !== "cancel"}
          />
        ))}
        <ShortcutProblems ids={ADVANCED} />
      </PfCard>
    </PfPage>
  );
};
