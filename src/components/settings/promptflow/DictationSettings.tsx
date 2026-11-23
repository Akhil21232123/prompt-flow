import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import type { StylePreset } from "@/bindings";
import { Dropdown } from "@/components/ui/Dropdown";
import { SPOKEN_LANGUAGES } from "@/lib/cloud";
import { PfCard, PfPage, PfRow, PfToggleRow } from "./ui";
import { useFlow } from "./useFlow";

type StyleChoice = StylePreset | "smart";
const STYLES: StyleChoice[] = [
  "smart",
  "clean",
  "formal",
  "short",
  "casual",
  "bullets",
  "custom",
];

export const DictationSettings: React.FC = () => {
  const { t } = useTranslation();
  const f = useFlow();
  const current: StyleChoice = f.stylePreset ?? "smart";
  const [custom, setCustom] = useState(f.customStyle);
  useEffect(() => setCustom(f.customStyle), [f.customStyle]);

  return (
    <PfPage title={t("dictation.title")} subtitle={t("dictation.subtitle")}>
      <PfCard
        title={t("dictation.style.title")}
        description={t("dictation.style.description")}
      >
        <div className="p-3 grid grid-cols-2 gap-2" role="radiogroup">
          {STYLES.map((s) => {
            const on = s === current;
            return (
              <button
                key={s}
                role="radio"
                aria-checked={on}
                onClick={() =>
                  f.save({ style_preset: s === "smart" ? null : s })
                }
                className={`text-start rounded-xl px-3.5 py-3 border transition-all cursor-pointer ${
                  on
                    ? "border-pf-violet bg-pf-violet/10 ring-1 ring-pf-violet/40"
                    : "border-pf-border hover:border-pf-border-strong bg-pf-surface-2/50"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-semibold text-pf-text">
                    {t(`dictation.style.options.${s}.name`)}
                  </span>
                  {on && <Check size={14} className="text-pf-violet" />}
                </div>
                <div className="text-[12px] text-pf-muted mt-0.5 leading-snug">
                  {t(`dictation.style.options.${s}.description`)}
                </div>
              </button>
            );
          })}
        </div>
        {current === "custom" && (
          <div className="p-4 flex flex-col gap-2">
            <label
              htmlFor="pf-custom-style"
              className="text-[13px] font-medium text-pf-text"
            >
              {t("dictation.style.customLabel")}
            </label>
            <textarea
              id="pf-custom-style"
              value={custom}
              rows={3}
              maxLength={400}
              placeholder={t("dictation.style.customPlaceholder")}
              onChange={(e) => setCustom(e.target.value)}
              onBlur={() =>
                custom.trim() !== f.customStyle &&
                f.save({ custom_style: custom.trim() })
              }
              className="w-full rounded-xl bg-pf-surface-2 border border-pf-border focus:border-pf-violet outline-none p-3 text-[14px] text-pf-text placeholder:text-pf-muted/70 resize-none"
            />
          </div>
        )}
      </PfCard>

      <PfCard title={t("dictation.language.title")}>
        <PfRow
          title={t("dictation.language.spoken")}
          description={t("dictation.language.spokenDescription")}
        >
          <Dropdown
            options={SPOKEN_LANGUAGES.map((code) => ({
              value: code,
              label: t(`dictation.language.names.${code}`),
            }))}
            selectedValue={f.spokenLanguage}
            onSelect={(v) => f.save({ spoken_language: v })}
          />
        </PfRow>
        <PfToggleRow
          id="pf-prompts-english"
          title={t("dictation.language.promptsEnglish")}
          description={t("dictation.language.promptsEnglishDescription")}
          checked={f.promptsInEnglish}
          onChange={(v) => f.save({ prompts_in_english: v })}
        />
      </PfCard>

      <PfCard title={t("dictation.prompts.title")}>
        <PfToggleRow
          id="pf-ask-back"
          title={t("dictation.prompts.askBack")}
          description={t("dictation.prompts.askBackDescription")}
          checked={f.askBack}
          onChange={(v) => f.save({ ask_back: v })}
        />
      </PfCard>
    </PfPage>
  );
};
