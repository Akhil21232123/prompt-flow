import React from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Brain,
  Cog,
  Cpu,
  Download,
  FlaskConical,
  History,
  Info,
  Keyboard,
  Lock,
  Mic,
  Sparkles,
  UserRound,
  Volume2,
} from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import { useAccount, useMacUpdate } from "@/lib/cloud";
import {
  GeneralSettings,
  AdvancedSettings,
  AboutSettings,
  PostProcessingSettings,
  ModelsSettings,
} from "./settings";
import { AccountSettings } from "./settings/promptflow/AccountSettings";
import { DictationSettings } from "./settings/promptflow/DictationSettings";
import { MemorySettings } from "./settings/promptflow/MemorySettings";
import { ShortcutsSettings } from "./settings/promptflow/ShortcutsSettings";
import { GuideSettings } from "./settings/promptflow/GuideSettings";
import { HistoryPage } from "./settings/promptflow/HistoryPage";

export type SidebarSection = keyof typeof SECTIONS_CONFIG;

interface IconProps {
  width?: number | string;
  height?: number | string;
  size?: number | string;
  className?: string;
}

type AnySettings = ReturnType<typeof useSettings>["settings"];

interface SectionConfig {
  labelKey: string;
  icon: React.ComponentType<IconProps>;
  /** `null` when App renders the section itself (it needs handlers). */
  component: React.ComponentType | null;
  enabled: (settings: AnySettings) => boolean;
  /** Starts a new group in the sidebar. */
  group?: "app" | "device";
}

const isPrivate = (settings: AnySettings) =>
  settings?.flow?.private_mode ?? false;

export const SECTIONS_CONFIG = {
  account: {
    labelKey: "sidebar.account",
    icon: UserRound,
    component: AccountSettings,
    enabled: () => true,
  },
  dictation: {
    labelKey: "sidebar.dictation",
    icon: Mic,
    component: DictationSettings,
    enabled: () => true,
  },
  memory: {
    labelKey: "sidebar.memory",
    icon: Brain,
    component: MemorySettings,
    enabled: () => true,
  },
  shortcuts: {
    labelKey: "sidebar.shortcuts",
    icon: Keyboard,
    component: ShortcutsSettings,
    enabled: () => true,
  },
  guide: {
    labelKey: "sidebar.guide",
    icon: BookOpen,
    component: GuideSettings,
    enabled: () => true,
  },
  history: {
    labelKey: "sidebar.history",
    icon: History,
    component: HistoryPage,
    enabled: () => true,
    group: "app",
  },
  general: {
    labelKey: "sidebar.sound",
    icon: Volume2,
    component: GeneralSettings,
    enabled: () => true,
    group: "app",
  },
  private: {
    labelKey: "sidebar.private",
    icon: Lock,
    component: null,
    enabled: () => true,
    group: "app",
  },
  models: {
    labelKey: "sidebar.models",
    icon: Cpu,
    component: ModelsSettings,
    enabled: isPrivate,
    group: "app",
  },
  postprocessing: {
    labelKey: "sidebar.postProcessing",
    icon: Sparkles,
    component: PostProcessingSettings,
    enabled: (settings) =>
      isPrivate(settings) && (settings?.post_process_enabled ?? false),
    group: "app",
  },
  advanced: {
    labelKey: "sidebar.advanced",
    icon: Cog,
    component: AdvancedSettings,
    enabled: () => true,
    group: "app",
  },
  about: {
    labelKey: "sidebar.help",
    icon: Info,
    component: AboutSettings,
    enabled: () => true,
    group: "app",
  },
  debug: {
    labelKey: "sidebar.debug",
    icon: FlaskConical,
    component: null,
    enabled: (settings) => settings?.debug_mode ?? false,
    group: "app",
  },
} as const satisfies Record<string, SectionConfig>;

interface SidebarProps {
  activeSection: SidebarSection;
  onSectionChange: (section: SidebarSection) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeSection,
  onSectionChange,
}) => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const account = useAccount();
  const update = useMacUpdate();

  const sections = Object.entries(SECTIONS_CONFIG)
    .filter(([, config]) => config.enabled(settings))
    .map(([id, config]) => ({ id: id as SidebarSection, ...config }));

  return (
    <nav
      className="flex flex-col w-52 h-full border-e border-pf-border bg-pf-surface/60 px-3"
      aria-label={t("sidebar.label")}
    >
      <div className="flex items-center gap-2 px-2 pt-5 pb-4">
        <span className="w-7 h-7 rounded-[9px] bg-[image:var(--pf-gradient)] flex items-center justify-center text-white shadow-[0_6px_16px_-8px_var(--pf-violet)]">
          <Sparkles size={15} />
        </span>
        <span className="text-[17px] font-semibold tracking-tight text-pf-text">
          {t("app.name")}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 overflow-y-auto flex-1 pb-3">
        {sections.map((section, i) => {
          const Icon = section.icon;
          const isActive = activeSection === section.id;
          const groupOf = (n: number) =>
            (sections[n] as SectionConfig | undefined)?.group;
          const newGroup = i > 0 && groupOf(i) !== groupOf(i - 1);
          return (
            <React.Fragment key={section.id}>
              {newGroup && <div className="h-px bg-pf-border my-2 mx-2" />}
              <button
                className={`flex gap-2.5 items-center h-9 px-2.5 w-full rounded-xl text-start transition-all cursor-pointer ${
                  isActive
                    ? "bg-pf-violet/15 text-pf-text"
                    : "text-pf-muted hover:text-pf-text hover:bg-pf-surface-2"
                }`}
                aria-current={isActive ? "page" : undefined}
                onClick={() => onSectionChange(section.id)}
              >
                <Icon
                  size={17}
                  className={`shrink-0 ${isActive ? "text-pf-violet" : ""}`}
                />
                <span className="text-[13.5px] font-medium truncate">
                  {t(section.labelKey)}
                </span>
                {section.id === "account" && !account.loading && (
                  <span
                    className={`ms-auto w-2 h-2 rounded-full ${
                      account.signedIn ? "bg-pf-mint" : "bg-pf-amber"
                    }`}
                    title={
                      account.signedIn
                        ? t("sidebar.signedIn")
                        : t("sidebar.signedOut")
                    }
                  />
                )}
              </button>
            </React.Fragment>
          );
        })}
      </div>
      {update?.available && (
        <button
          className="mb-3 p-3 rounded-2xl bg-[image:var(--pf-gradient-soft)] border border-pf-violet/30 text-start cursor-pointer pf-rise"
          onClick={() => onSectionChange("about")}
        >
          <div className="flex items-center gap-2 text-[13px] font-semibold text-pf-text">
            <Download size={14} className="text-pf-violet" />
            {t("update.available")}
          </div>
          <div className="text-[11.5px] text-pf-muted mt-0.5">
            {t("update.download")}
          </div>
        </button>
      )}
    </nav>
  );
};
