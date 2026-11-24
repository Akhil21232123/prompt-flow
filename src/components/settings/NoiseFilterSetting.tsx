import React from "react";
import { useTranslation } from "react-i18next";
import type { NoiseFilter } from "@/bindings";
import { Dropdown } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";
import { useFlow } from "./promptflow/useFlow";

const MODES: NoiseFilter[] = ["auto", "always", "off"];

interface NoiseFilterSettingProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

/** Settings → Sound → Noise filter: Auto (only when it's noisy), Always, Off. */
export const NoiseFilterSetting: React.FC<NoiseFilterSettingProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const f = useFlow();
  const mode: NoiseFilter = f.flow.noise_filter ?? "auto";
  return (
    <SettingContainer
      title={t("settings.sound.noiseFilter.title")}
      description={t(`settings.sound.noiseFilter.description.${mode}`)}
      descriptionMode={descriptionMode}
      grouped={grouped}
    >
      <Dropdown
        options={MODES.map((m) => ({
          value: m,
          label: t(`settings.sound.noiseFilter.options.${m}`),
        }))}
        selectedValue={mode}
        disabled={f.saving}
        onSelect={(v) => void f.save({ noise_filter: v as NoiseFilter })}
      />
    </SettingContainer>
  );
};
