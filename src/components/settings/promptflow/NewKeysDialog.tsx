import React from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui";
import { Keycaps } from "@/components/shared/Keycaps";
import { useSettings } from "@/hooks/useSettings";
import { useOsType } from "@/hooks/useOsType";
import { FnKeyCard } from "./FnKeyCard";
import { SpotlightStep } from "./ShortcutsSettings";
import { useFlow } from "./useFlow";

/** Once, after the update that replaced the old shortcuts with two keys. */
export const NewKeysDialog: React.FC = () => {
  const { t } = useTranslation();
  const f = useFlow();
  const { getSetting } = useSettings();
  const os = useOsType();
  const plain = getSetting("bindings")?.transcribe?.current_binding ?? "";
  const open = f.flow.new_keys_notice === true;
  const dismiss = () => void f.save({ new_keys_notice: false });
  return (
    <Dialog
      open={open}
      title={t("newKeys.title")}
      closeLabel={t("common.close")}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <div className="flex flex-col gap-3 text-[13.5px] leading-relaxed">
        <div className="pf-card divide-y divide-pf-border">
          {[
            { key: "fn", b: "fn" },
            { key: "plain", b: plain },
          ].map(({ key, b }) => (
            <div key={key} className="px-4 py-3 flex items-center gap-3">
              <span className="flex-1">{t(`newKeys.${key}`)}</span>
              {b && <Keycaps binding={b} osType={os} size="line" />}
            </div>
          ))}
          <SpotlightStep />
        </div>
        <FnKeyCard compact />
        <p className="text-[12.5px] text-pf-muted">{t("newKeys.old")}</p>
        <button className="pf-button-primary w-full" onClick={dismiss}>
          {t("newKeys.ok")}
        </button>
      </div>
    </Dialog>
  );
};
