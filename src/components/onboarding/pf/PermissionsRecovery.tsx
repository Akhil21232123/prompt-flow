import React, { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { commands } from "@/bindings";
import {
  PermissionRows,
  useMacPermissions,
} from "@/components/settings/promptflow/PermissionsCard";

/**
 * Shown on launch when macOS has forgotten a permission. PromptFlow is
 * ad-hoc signed, so its identity changes with every update and macOS can
 * drop the old grants; this walks the user through allowing it again.
 */
export const PermissionsRecovery: React.FC<{ onComplete: () => void }> = ({
  onComplete,
}) => {
  const { t } = useTranslation();
  const { state } = useMacPermissions();
  const ready = !!state?.microphone && !!state?.accessibility;
  const finished = useRef(false);

  useEffect(() => {
    if (!ready || finished.current) return;
    finished.current = true;
    Promise.all([commands.initializeEnigo(), commands.initializeShortcuts()])
      .catch((e) => console.warn("Failed to initialize input:", e))
      .finally(() => setTimeout(onComplete, 800));
  }, [ready]);

  return (
    <div className="h-screen w-screen bg-pf-bg text-pf-text flex items-center justify-center px-8 select-none overflow-y-auto">
      <div className="w-full max-w-lg flex flex-col gap-6 pf-rise py-8">
        <div className="flex flex-col gap-3">
          <div className="w-12 h-12 rounded-2xl bg-pf-amber/15 text-pf-amber flex items-center justify-center">
            <ShieldAlert size={22} />
          </div>
          <h1 className="text-[26px] font-semibold tracking-tight leading-tight">
            {ready ? t("recovery.allSet") : t("recovery.title")}
          </h1>
          <p className="text-[14.5px] text-pf-muted leading-relaxed">
            {t("recovery.body")}
          </p>
        </div>
        <PermissionRows state={state} includeOptional={false} />
        <div className="pf-card p-4 text-[12.5px] text-pf-muted leading-relaxed">
          <div className="text-[13px] font-semibold text-pf-text mb-1">
            {t("recovery.stuckTitle")}
          </div>
          {t("recovery.stuckBody")}
        </div>
        <button
          className="self-start text-[13px] text-pf-muted hover:text-pf-text transition-colors cursor-pointer"
          onClick={onComplete}
        >
          {t("recovery.continueAnyway")}
        </button>
      </div>
    </div>
  );
};
