import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Eye,
  HelpCircle,
  Mic,
  Pencil,
  ShieldCheck,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { Keycaps } from "@/components/shared/Keycaps";
import { useSettings } from "@/hooks/useSettings";
import { useOsType } from "@/hooks/useOsType";
import { PfCard, PfPage } from "./ui";

type Feature = {
  id: "transcribe" | "prompt_engineer" | "this" | "command_mode" | "autopilot";
  key: string;
  icon: LucideIcon;
  tone: string;
};

const FEATURES: Feature[] = [
  { id: "transcribe", key: "dictate", icon: Mic, tone: "gradient" },
  { id: "prompt_engineer", key: "prompt", icon: Sparkles, tone: "blue" },
  { id: "this", key: "this", icon: Eye, tone: "blue" },
  { id: "command_mode", key: "edit", icon: Pencil, tone: "gradient" },
  { id: "autopilot", key: "autopilot", icon: ShieldCheck, tone: "mint" },
];

const ISLAND_STATES = ["listening", "working", "ask", "done"] as const;

/** A still of the island in one of its states, for the guide. */
const IslandStill: React.FC<{ state: (typeof ISLAND_STATES)[number] }> = ({
  state,
}) => {
  const { t } = useTranslation();
  const base =
    "bg-black text-white rounded-[18px] shadow-[0_12px_30px_-14px_rgba(0,0,0,0.8)] flex items-center gap-2 px-3 transition-all duration-500";
  if (state === "listening")
    return (
      <div className={`${base} h-9`}>
        <span className="w-5 h-5 rounded-full bg-[image:var(--pf-gradient)] flex items-center justify-center">
          <Mic size={11} />
        </span>
        <span className="flex items-center gap-[2px] h-4">
          {[0.4, 0.8, 0.55, 1, 0.7, 0.45, 0.85, 0.5].map((h, i) => (
            <i
              key={i}
              className="block w-[3px] rounded-sm bg-[image:var(--pf-gradient)] pf-guide-wave"
              style={{ height: `${h * 16}px`, animationDelay: `${i * 90}ms` }}
            />
          ))}
        </span>
        <span className="text-[11px] text-white/60 tabular-nums">
          {t("guide.island.timer")}
        </span>
      </div>
    );
  if (state === "working")
    return (
      <div className={`${base} h-9`}>
        <span className="w-3.5 h-3.5 rounded-full border-2 border-white/20 border-t-pf-violet animate-spin" />
        <span className="text-[12px] text-white/80">
          {t("guide.island.writing")}
        </span>
      </div>
    );
  if (state === "ask")
    return (
      <div className={`${base} flex-col items-start py-2.5 gap-1.5`}>
        <span className="flex items-center gap-1.5 text-[11px] text-white/60">
          <HelpCircle size={11} className="text-pf-blue" />
          {t("guide.island.askEyebrow")}
        </span>
        <span className="text-[12.5px] font-semibold">
          {t("guide.island.askQuestion")}
        </span>
        <span className="flex gap-1">
          {["Python", "TypeScript", "Go"].map((o) => (
            <span
              key={o}
              className="text-[11px] px-2 py-0.5 rounded-full bg-white/10"
            >
              {o}
            </span>
          ))}
        </span>
      </div>
    );
  return (
    <div className={`${base} flex-col items-start py-2.5 gap-1`}>
      <span className="flex items-center gap-1.5 text-[11.5px] font-semibold">
        <span className="w-4 h-4 rounded-full bg-pf-blue flex items-center justify-center">
          <Check size={10} strokeWidth={3} />
        </span>
        {t("guide.island.doneLabel")}
      </span>
      <span className="text-[11.5px] text-white/75">
        {t("guide.island.donePreview")}
      </span>
    </div>
  );
};

export const GuideSettings: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const os = useOsType();
  const bindings = getSetting("bindings") ?? {};
  const [state, setState] =
    useState<(typeof ISLAND_STATES)[number]>("listening");

  const toneClass = (tone: string) =>
    tone === "blue"
      ? "bg-pf-blue/15 text-pf-blue"
      : tone === "mint"
        ? "bg-pf-mint/15 text-pf-mint"
        : "bg-pf-violet/15 text-pf-violet";

  return (
    <PfPage title={t("guide.title")} subtitle={t("guide.subtitle")}>
      <div className="pf-card p-5 bg-[image:var(--pf-gradient-soft)]">
        <div className="text-[17px] font-semibold text-pf-text">
          {t("guide.hero.title")}
        </div>
        <p className="text-[13.5px] text-pf-muted mt-1.5 leading-relaxed">
          {t("guide.hero.body")}
        </p>
      </div>

      <PfCard title={t("guide.shortcutsTitle")}>
        {FEATURES.map((feat) => {
          const Icon = feat.icon;
          const binding = bindings[feat.id]?.current_binding ?? "";
          return (
            <div key={feat.id} className="px-4 py-4 flex gap-3.5">
              <div
                className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${toneClass(feat.tone)}`}
              >
                <Icon size={17} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-[14.5px] font-semibold text-pf-text">
                    {t(`guide.features.${feat.key}.title`)}
                  </span>
                  {binding && (
                    <Keycaps binding={binding} osType={os} size="line" />
                  )}
                </div>
                <p className="text-[13px] text-pf-muted mt-1 leading-relaxed">
                  {t(`guide.features.${feat.key}.body`)}
                </p>
                <p className="text-[12.5px] text-pf-text/80 mt-1.5 italic">
                  {t(`guide.features.${feat.key}.example`)}
                </p>
              </div>
            </div>
          );
        })}
      </PfCard>

      <PfCard
        title={t("guide.island.title")}
        description={t("guide.island.description")}
      >
        <div className="p-4 flex flex-col gap-4">
          <div className="h-[110px] rounded-xl bg-pf-surface-2 border border-pf-border flex items-start justify-center pt-0 overflow-hidden relative">
            <div className="absolute top-0 inset-x-0 h-5 bg-black/80" />
            <div className="relative mt-1.5" key={state}>
              <div className="pf-rise">
                <IslandStill state={state} />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {ISLAND_STATES.map((s) => (
              <button
                key={s}
                onClick={() => setState(s)}
                className={`text-start rounded-xl px-3 py-2.5 border transition-all cursor-pointer ${
                  s === state
                    ? "border-pf-violet bg-pf-violet/10"
                    : "border-pf-border hover:border-pf-border-strong"
                }`}
              >
                <div className="text-[12.5px] font-semibold text-pf-text">
                  {t(`guide.island.states.${s}.title`)}
                </div>
                <div className="text-[11.5px] text-pf-muted mt-0.5 leading-snug">
                  {t(`guide.island.states.${s}.body`)}
                </div>
              </button>
            ))}
          </div>
        </div>
      </PfCard>

      <PfCard title={t("guide.tipsTitle")}>
        <ul className="px-5 py-4 flex flex-col gap-2.5 list-disc marker:text-pf-violet">
          {(
            ["holdOrTap", "escape", "undo", "anyLanguage", "private"] as const
          ).map((tip) => (
            <li key={tip} className="text-[13px] text-pf-text leading-relaxed">
              {t(`guide.tips.${tip}`)}
            </li>
          ))}
        </ul>
      </PfCard>

      <PfCard title={t("guide.whatsNewTitle")}>
        <ul className="px-5 py-4 flex flex-col gap-2.5">
          {(
            [
              "accounts",
              "askBack",
              "aiSpecific",
              "languages",
              "memory",
              "this",
              "autopilot",
              "island",
            ] as const
          ).map((item) => (
            <li key={item} className="flex gap-2.5 text-[13px] leading-relaxed">
              <span className="mt-[7px] w-1.5 h-1.5 rounded-full bg-[image:var(--pf-gradient)] shrink-0" />
              <span>
                <span className="font-semibold text-pf-text">
                  {t(`guide.whatsNew.${item}.title`)}
                </span>{" "}
                <span className="text-pf-muted">
                  {t(`guide.whatsNew.${item}.body`)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </PfCard>
    </PfPage>
  );
};
