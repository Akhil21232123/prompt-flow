import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, TriangleAlert } from "lucide-react";
import { commands } from "@/bindings";
import type { FnKeyStatus } from "@/bindings";
import { Switch } from "@/components/ui/Switch";
import { useFlow } from "./useFlow";

/** Fn/🌐 status, re-read every 2 s (the user may be in System Settings). */
export const useFnKey = () => {
  const [status, setStatus] = useState<FnKeyStatus | null>(null);
  useEffect(() => {
    let disposed = false;
    const read = () =>
      commands.fnKeyStatus().then((s) => !disposed && setStatus(s));
    void read();
    const timer = setInterval(read, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  return status;
};

/** Hold 🌐 to talk: the switch, how it works, and fixing macOS's 🌐 setting. */
export const FnKeyCard: React.FC<{ compact?: boolean }> = ({
  compact = false,
}) => {
  const { t } = useTranslation();
  const f = useFlow();
  const status = useFnKey();
  const on = f.flow.fn_key ?? true;
  const conflict = on && status !== null && status.usage !== "do_nothing";

  return (
    <div className="pf-card divide-y divide-pf-border">
      <div className="px-4 py-3.5 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-[image:var(--pf-gradient-soft)] text-pf-violet flex items-center justify-center shrink-0">
          <Globe size={17} />
        </div>
        <div className="flex-1 min-w-0">
          <div id="pf-fn-key" className="text-[14px] font-medium text-pf-text">
            {t("fnKey.title")}
          </div>
          <div className="text-[12.5px] text-pf-muted leading-relaxed">
            {t("fnKey.body")}
          </div>
        </div>
        {!compact && (
          <Switch
            checked={on}
            onChange={(v) => f.save({ fn_key: v })}
            ariaLabelledBy="pf-fn-key"
          />
        )}
      </div>
      {conflict && (
        <div className="px-4 py-3 flex items-center gap-3 bg-pf-amber/5 pf-rise">
          <TriangleAlert size={16} className="text-pf-amber shrink-0" />
          <div className="flex-1 text-[12.5px] text-pf-text leading-relaxed">
            {t(`fnKey.conflict.${status.usage}`)} {t("fnKey.fix")}
          </div>
          <button
            className="pf-button-secondary"
            onClick={() => void commands.openKeyboardSettings()}
          >
            {t("fnKey.openKeyboard")}
          </button>
        </div>
      )}
      {on && status && !status.active && (
        <div className="px-4 py-3 text-[12.5px] text-pf-muted">
          {t("fnKey.needsAccessibility")}
        </div>
      )}
    </div>
  );
};
