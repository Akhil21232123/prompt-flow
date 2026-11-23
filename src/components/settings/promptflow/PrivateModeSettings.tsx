import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Cpu, Lock, Sparkles } from "lucide-react";
import { FlowSettings } from "../flow/FlowSettings";
import { useModelStore } from "@/stores/modelStore";
import { PfCard, PfPage, PfRow, PfToggleRow } from "./ui";
import { useFlow } from "./useFlow";

export const PrivateModeSettings: React.FC<{
  onOpenSection: (section: "models" | "postprocessing") => void;
}> = ({ onOpenSection }) => {
  const { t } = useTranslation();
  const f = useFlow();
  const [advanced, setAdvanced] = useState(false);
  const { currentModel, models } = useModelStore();
  const model = models.find((m) => m.id === currentModel);
  const hasModel = !!model?.is_downloaded;

  return (
    <PfPage title={t("private.title")} subtitle={t("private.subtitle")}>
      <div className="pf-card p-5 flex gap-4 items-start">
        <div
          className={`w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 transition-colors ${
            f.privateMode
              ? "bg-pf-amber/15 text-pf-amber"
              : "bg-pf-blue/15 text-pf-blue"
          }`}
        >
          {f.privateMode ? <Lock size={20} /> : <Sparkles size={20} />}
        </div>
        <div className="flex-1">
          <div className="text-[15px] font-semibold text-pf-text">
            {f.privateMode ? t("private.onTitle") : t("private.offTitle")}
          </div>
          <p className="text-[13px] text-pf-muted mt-1 leading-relaxed">
            {f.privateMode ? t("private.onBody") : t("private.offBody")}
          </p>
        </div>
      </div>

      <PfCard>
        <PfToggleRow
          id="pf-private-mode"
          title={t("private.toggle")}
          description={t("private.toggleDescription")}
          checked={f.privateMode}
          onChange={(v) => f.save({ private_mode: v })}
        />
        {f.privateMode && (
          <PfRow
            title={t("private.model")}
            description={
              hasModel
                ? t("private.modelReady", { model: model?.name ?? "" })
                : t("private.modelMissing")
            }
          >
            <button
              className={
                hasModel ? "pf-button-secondary" : "pf-button-primary small"
              }
              onClick={() => onOpenSection("models")}
            >
              <Cpu size={14} />
              {hasModel ? t("private.changeModel") : t("private.getModel")}
            </button>
          </PfRow>
        )}
        {f.privateMode && (
          <PfRow
            title={t("private.ai")}
            description={t("private.aiDescription")}
          >
            <button
              className="pf-button-secondary"
              onClick={() => onOpenSection("postprocessing")}
            >
              {t("private.aiOpen")}
            </button>
          </PfRow>
        )}
      </PfCard>

      {f.privateMode && (
        <section className="flex flex-col gap-3">
          <button
            className="flex items-center gap-2 px-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-pf-muted hover:text-pf-text transition-colors cursor-pointer"
            aria-expanded={advanced}
            onClick={() => setAdvanced((a) => !a)}
          >
            <ChevronDown
              size={14}
              className={`transition-transform ${advanced ? "" : "-rotate-90"}`}
            />
            {t("private.advanced")}
          </button>
          {advanced && (
            <div className="pf-rise">
              <p className="text-[12.5px] text-pf-muted px-1 pb-3">
                {t("private.advancedDescription")}
              </p>
              <FlowSettings />
            </div>
          )}
        </section>
      )}
    </PfPage>
  );
};
