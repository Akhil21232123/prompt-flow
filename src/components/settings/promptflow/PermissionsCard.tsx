import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { platform } from "@tauri-apps/plugin-os";
import {
  checkAccessibilityPermission,
  checkMicrophonePermission,
  requestAccessibilityPermission,
  requestMicrophonePermission,
} from "tauri-plugin-macos-permissions-api";
import {
  Accessibility,
  Check,
  Mic,
  MonitorUp,
  type LucideIcon,
} from "lucide-react";
import { commands } from "@/bindings";
import type { PrivacyPane } from "@/bindings";

export type PermissionState = {
  microphone: boolean;
  accessibility: boolean;
  screen: boolean;
};

const isMac = () => platform() === "macos";

/** macOS permissions, re-checked every 1.5 s while `poll` is on. */
export const useMacPermissions = (poll = true) => {
  const [state, setState] = useState<PermissionState | null>(null);
  const check = useCallback(async () => {
    if (!isMac()) {
      setState({ microphone: true, accessibility: true, screen: true });
      return;
    }
    try {
      const [mic, acc, screen] = await Promise.all([
        checkMicrophonePermission(),
        checkAccessibilityPermission(),
        commands.screenRecordingAllowed(),
      ]);
      setState({ microphone: mic, accessibility: acc, screen });
    } catch (e) {
      console.warn("Permission check failed:", e);
    }
  }, []);
  useEffect(() => {
    void check();
    if (!poll) return;
    const timer = setInterval(check, 1500);
    return () => clearInterval(timer);
  }, [check, poll]);
  return { state, refresh: check };
};

/** Asks for `pane` the way macOS allows. A grant belongs to one build's
 *  signature, and PromptFlow's ad-hoc signature changes with every update,
 *  so a stale entry is cleared first (only ever called while not granted);
 *  macOS then prompts afresh, and the System Settings pane opens as well. */
export const askFor = async (pane: PrivacyPane) => {
  try {
    if (pane === "microphone") {
      await commands.resetMacosPermission("microphone");
      await requestMicrophonePermission();
      if (!(await checkMicrophonePermission()))
        await commands.openPrivacySettings("microphone");
    } else if (pane === "accessibility") {
      await commands.resetMacosPermission("accessibility");
      await requestAccessibilityPermission();
      await commands.openPrivacySettings("accessibility");
    } else {
      await commands.resetMacosPermission("screen");
      await commands.requestScreenRecording();
    }
  } catch (e) {
    console.warn("Permission request failed:", e);
    await commands.openPrivacySettings(pane);
  }
};

const ROWS: {
  pane: PrivacyPane;
  key: keyof PermissionState;
  icon: LucideIcon;
  optional?: boolean;
}[] = [
  { pane: "microphone", key: "microphone", icon: Mic },
  { pane: "accessibility", key: "accessibility", icon: Accessibility },
  { pane: "screen_recording", key: "screen", icon: MonitorUp, optional: true },
];

export const PermissionRows: React.FC<{
  state: PermissionState | null;
  onlyMissing?: boolean;
  includeOptional?: boolean;
}> = ({ state, onlyMissing = false, includeOptional = true }) => {
  const { t } = useTranslation();
  return (
    <div className="pf-card divide-y divide-pf-border">
      {ROWS.filter((r) => includeOptional || !r.optional)
        .filter((r) => !onlyMissing || !state?.[r.key])
        .map(({ pane, key, icon: Icon, optional }) => {
          const granted = state?.[key] ?? false;
          return (
            <div key={pane} className="px-4 py-3.5 flex items-center gap-3">
              <div
                className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
                  granted
                    ? "bg-pf-mint/15 text-pf-mint"
                    : "bg-pf-violet/15 text-pf-violet"
                }`}
              >
                {granted ? <Check size={17} /> : <Icon size={17} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[14px] font-medium text-pf-text flex items-center gap-2">
                  {t(`permissions.${pane}.title`)}
                  {optional && (
                    <span className="text-[11px] font-medium text-pf-muted">
                      {t("permissions.optional")}
                    </span>
                  )}
                </div>
                <div className="text-[12.5px] text-pf-muted leading-relaxed">
                  {t(`permissions.${pane}.why`)}
                </div>
              </div>
              {granted ? (
                <span className="text-[12.5px] font-medium text-pf-mint">
                  {t("permissions.allowed")}
                </span>
              ) : (
                <button
                  className="pf-button-secondary"
                  onClick={() => void askFor(pane)}
                >
                  {t("permissions.allow")}
                </button>
              )}
            </div>
          );
        })}
    </div>
  );
};
