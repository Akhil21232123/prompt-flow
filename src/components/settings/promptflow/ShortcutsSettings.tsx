import React from "react";
import { useTranslation } from "react-i18next";
import { ShortcutInput } from "../ShortcutInput";
import { ShortcutActivationSetting } from "../ShortcutActivation";
import { PfCard, PfPage } from "./ui";
import { PermissionRows, useMacPermissions } from "./PermissionsCard";
import { FnKeyCard } from "./FnKeyCard";

const SHORTCUTS = [
  "transcribe",
  "prompt_engineer",
  "this",
  "command_mode",
  "autopilot",
  "cancel",
] as const;

export const ShortcutsSettings: React.FC = () => {
  const { t } = useTranslation();
  const { state } = useMacPermissions();
  return (
    <PfPage title={t("shortcuts.title")} subtitle={t("shortcuts.subtitle")}>
      <PfCard bare>
        <FnKeyCard />
      </PfCard>
      <PfCard title={t("shortcuts.keys")}>
        {SHORTCUTS.map((id) => (
          <ShortcutInput
            key={id}
            shortcutId={id}
            descriptionMode="inline"
            grouped={true}
          />
        ))}
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
    </PfPage>
  );
};
