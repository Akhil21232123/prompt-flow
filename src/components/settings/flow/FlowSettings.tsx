import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import type {
  AppCategory,
  AppCategoryOverride,
  CloudSttProvider,
  EngineerQuality,
  FlowSettings as Flow,
  MissingInfoPolicy,
  PromptEngineerSettings,
  PromptFormat,
  PromptTarget,
  Snippet,
  WritingStyle,
} from "@/bindings";
import {
  Dropdown,
  SettingContainer,
  SettingsGroup,
  Textarea,
  ToggleSwitch,
} from "@/components/ui";
import { Alert } from "../../ui/Alert";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Input";
import { ApiKeyField } from "../PostProcessingSettingsApi/ApiKeyField";
import { PostProcessingToggle } from "../PostProcessingToggle";
import { ShortcutInput } from "../ShortcutInput";
import { useSettings } from "../../../hooks/useSettings";

const DEFAULT_PE: Required<PromptEngineerSettings> = {
  quality: "balanced",
  target: "auto",
  missing_info: "state_assumptions",
  format: "auto",
  min_score: 9,
  max_rounds: 3,
  provider_id: null,
  model: null,
  auto_in_ai_apps: true,
  auto_min_words: 8,
  custom_instructions: "",
};

type FullFlow = Required<Omit<Flow, "prompt_engineer">> & {
  prompt_engineer: Required<PromptEngineerSettings>;
};

/** The backend always sends every field; defaults only guard old stores. */
const withDefaults = (flow?: Flow): FullFlow => ({
  smart_polish: flow?.smart_polish ?? true,
  polish_main_shortcut: flow?.polish_main_shortcut ?? true,
  app_aware: flow?.app_aware ?? true,
  styles: {
    email: "formal",
    work_chat: "casual",
    personal_chat: "casual",
    docs: "formal",
    other: "casual",
    ...flow?.styles,
  },
  developer_mode: flow?.developer_mode ?? true,
  snippets: flow?.snippets ?? [],
  app_overrides: flow?.app_overrides ?? [],
  prompt_engineer: { ...DEFAULT_PE, ...flow?.prompt_engineer },
  cloud_stt: {
    enabled: false,
    provider: "groq",
    model: "",
    fallback_to_local: true,
    ...flow?.cloud_stt,
  },
});

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** Text input that saves on blur, so typing doesn't write every keystroke. */
const BlurInput: React.FC<{
  value: string;
  onSave: (value: string) => void;
  placeholder?: string;
  className?: string;
}> = ({ value, onSave, placeholder, className = "" }) => {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  return (
    <Input
      value={local}
      placeholder={placeholder}
      variant="compact"
      className={className}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => local !== value && onSave(local)}
    />
  );
};

export const FlowSettings: React.FC = () => {
  const { t } = useTranslation();
  const {
    settings,
    getSetting,
    updateSetting,
    isUpdating,
    updatePostProcessApiKey,
  } = useSettings();
  const flow = withDefaults(getSetting("flow"));
  const pe = flow.prompt_engineer;
  const f = (key: string) => t(`settings.flow.${key}`);

  const save = (patch: Partial<FullFlow>) =>
    updateSetting("flow", { ...flow, ...patch });
  const savePe = (patch: Partial<PromptEngineerSettings>) =>
    save({ prompt_engineer: { ...pe, ...patch } });

  const providers = settings?.post_process_providers ?? [];
  const keys = settings?.post_process_api_keys ?? {};
  const models = settings?.post_process_models ?? {};
  const peProviderId =
    pe.provider_id ?? settings?.post_process_provider_id ?? "";
  const peProvider = providers.find((p) => p.id === peProviderId);
  const peModel = (pe.model ?? "").trim() || models[peProviderId] || "";
  const needsKey = !["custom", "apple_intelligence"].includes(peProviderId);
  const peReady =
    !!peProvider &&
    !!peModel.trim() &&
    (!needsKey || !!keys[peProviderId]?.trim());

  const opts = <T extends string>(values: T[], prefix: string) =>
    values.map((value) => ({ value, label: f(`${prefix}.${value}`) }));

  const styleOptions = opts<WritingStyle>(
    ["formal", "casual", "very_casual"],
    "styles.options",
  );
  const categoryOptions = opts<AppCategory>(
    [
      "email",
      "work_chat",
      "personal_chat",
      "code",
      "terminal",
      "ai_chat",
      "docs",
      "other",
    ],
    "categories",
  );

  const cloudProvider = flow.cloud_stt.provider;
  const cloudKeyId = cloudProvider === "groq" ? "groq" : "openai";

  const updateSnippet = (id: string, patch: Partial<Snippet>) =>
    save({
      snippets: flow.snippets.map((s) =>
        s.id === id ? { ...s, ...patch } : s,
      ),
    });
  const updateOverride = (index: number, patch: Partial<AppCategoryOverride>) =>
    save({
      app_overrides: flow.app_overrides.map((o, i) =>
        i === index ? { ...o, ...patch } : o,
      ),
    });

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      {!peReady && <Alert variant="warning">{f("setupNeeded")}</Alert>}

      <SettingsGroup
        title={f("shortcuts.title")}
        description={f("shortcuts.description")}
      >
        <ShortcutInput
          shortcutId="transcribe"
          descriptionMode="tooltip"
          grouped={true}
        />
        <ShortcutInput
          shortcutId="prompt_engineer"
          descriptionMode="tooltip"
          grouped={true}
        />
        <ShortcutInput
          shortcutId="command_mode"
          descriptionMode="tooltip"
          grouped={true}
        />
      </SettingsGroup>

      <SettingsGroup
        title={f("engineer.title")}
        description={f("engineer.description")}
      >
        <SettingContainer
          title={f("engineer.quality.title")}
          description={f("engineer.quality.description")}
          descriptionMode="tooltip"
          layout="horizontal"
          grouped={true}
        >
          <Dropdown
            options={opts<EngineerQuality>(
              ["fast", "balanced", "max"],
              "engineer.quality.options",
            )}
            selectedValue={pe.quality}
            onSelect={(v) => savePe({ quality: v as EngineerQuality })}
          />
        </SettingContainer>
        <SettingContainer
          title={f("engineer.target.title")}
          description={f("engineer.target.description")}
          descriptionMode="tooltip"
          layout="horizontal"
          grouped={true}
        >
          <Dropdown
            options={opts<PromptTarget>(
              [
                "auto",
                "coding_agent",
                "chat_assistant",
                "research",
                "writing",
                "image_generation",
                "data_analysis",
              ],
              "engineer.target.options",
            )}
            selectedValue={pe.target}
            onSelect={(v) => savePe({ target: v as PromptTarget })}
          />
        </SettingContainer>
        <SettingContainer
          title={f("engineer.missing.title")}
          description={f("engineer.missing.description")}
          descriptionMode="tooltip"
          layout="horizontal"
          grouped={true}
        >
          <Dropdown
            options={opts<MissingInfoPolicy>(
              ["state_assumptions", "ask_first"],
              "engineer.missing.options",
            )}
            selectedValue={pe.missing_info}
            onSelect={(v) => savePe({ missing_info: v as MissingInfoPolicy })}
          />
        </SettingContainer>
        <SettingContainer
          title={f("engineer.format.title")}
          description={f("engineer.format.description")}
          descriptionMode="tooltip"
          layout="horizontal"
          grouped={true}
        >
          <Dropdown
            options={opts<PromptFormat>(
              ["auto", "xml", "markdown", "plain"],
              "engineer.format.options",
            )}
            selectedValue={pe.format}
            onSelect={(v) => savePe({ format: v as PromptFormat })}
          />
        </SettingContainer>
        <ToggleSwitch
          checked={pe.auto_in_ai_apps}
          onChange={(v) => savePe({ auto_in_ai_apps: v })}
          isUpdating={isUpdating("flow")}
          label={f("engineer.auto.title")}
          description={f("engineer.auto.description")}
          descriptionMode="tooltip"
          grouped={true}
        />
        <SettingContainer
          title={f("engineer.provider.title")}
          description={f("engineer.provider.description")}
          descriptionMode="tooltip"
          layout="horizontal"
          grouped={true}
        >
          <div className="flex items-center gap-2">
            <Dropdown
              options={[
                { value: "", label: f("engineer.provider.same") },
                ...providers.map((p) => ({ value: p.id, label: p.label })),
              ]}
              selectedValue={pe.provider_id ?? ""}
              onSelect={(v) => savePe({ provider_id: v || null })}
            />
            <BlurInput
              value={pe.model ?? ""}
              placeholder={
                models[peProviderId] || f("engineer.provider.modelPlaceholder")
              }
              onSave={(v) => savePe({ model: v.trim() || null })}
              className="w-48"
            />
          </div>
        </SettingContainer>
        {pe.provider_id && needsKey && (
          <SettingContainer
            title={f("engineer.provider.key")}
            description={f("engineer.provider.keyDescription")}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <ApiKeyField
              value={keys[pe.provider_id] ?? ""}
              onBlur={(v) => updatePostProcessApiKey(pe.provider_id!, v.trim())}
              disabled={false}
              placeholder="sk-..."
            />
          </SettingContainer>
        )}
        <SettingContainer
          title={f("engineer.custom.title")}
          description={f("engineer.custom.description")}
          descriptionMode="inline"
          layout="stacked"
          grouped={true}
        >
          <Textarea
            defaultValue={pe.custom_instructions}
            placeholder={f("engineer.custom.placeholder")}
            onBlur={(e) =>
              e.target.value !== pe.custom_instructions &&
              savePe({ custom_instructions: e.target.value })
            }
          />
        </SettingContainer>
      </SettingsGroup>

      <SettingsGroup
        title={f("dictation.title")}
        description={f("dictation.description")}
      >
        <PostProcessingToggle descriptionMode="tooltip" grouped={true} />
        <ToggleSwitch
          checked={flow.smart_polish}
          onChange={(v) => save({ smart_polish: v })}
          label={f("dictation.smart.title")}
          description={f("dictation.smart.description")}
          descriptionMode="tooltip"
          grouped={true}
        />
        <ToggleSwitch
          checked={flow.polish_main_shortcut}
          onChange={(v) => save({ polish_main_shortcut: v })}
          label={f("dictation.main.title")}
          description={f("dictation.main.description")}
          descriptionMode="tooltip"
          grouped={true}
        />
        <ToggleSwitch
          checked={flow.app_aware}
          onChange={(v) => save({ app_aware: v })}
          label={f("dictation.appAware.title")}
          description={f("dictation.appAware.description")}
          descriptionMode="tooltip"
          grouped={true}
        />
        <ToggleSwitch
          checked={flow.developer_mode}
          onChange={(v) => save({ developer_mode: v })}
          label={f("dictation.developer.title")}
          description={f("dictation.developer.description")}
          descriptionMode="tooltip"
          grouped={true}
        />
      </SettingsGroup>

      <SettingsGroup
        title={f("styles.title")}
        description={f("styles.description")}
      >
        {(
          ["email", "work_chat", "personal_chat", "docs", "other"] as const
        ).map((key) => (
          <SettingContainer
            key={key}
            title={f(`categories.${key}`)}
            description={f(`styles.hint.${key}`)}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <Dropdown
              options={styleOptions}
              selectedValue={flow.styles[key] ?? "casual"}
              onSelect={(v) =>
                save({ styles: { ...flow.styles, [key]: v as WritingStyle } })
              }
            />
          </SettingContainer>
        ))}
      </SettingsGroup>

      <SettingsGroup
        title={f("snippets.title")}
        description={f("snippets.description")}
      >
        <div className="px-4 py-3 space-y-2">
          {flow.snippets.map((s) => (
            <div key={s.id} className="flex items-start gap-2">
              <BlurInput
                value={s.trigger}
                placeholder={f("snippets.trigger")}
                onSave={(v) => updateSnippet(s.id, { trigger: v })}
                className="w-48"
              />
              <BlurInput
                value={s.expansion}
                placeholder={f("snippets.expansion")}
                onSave={(v) => updateSnippet(s.id, { expansion: v })}
                className="flex-1"
              />
              <Button
                variant="danger-ghost"
                size="sm"
                aria-label={f("snippets.remove")}
                onClick={() =>
                  save({ snippets: flow.snippets.filter((x) => x.id !== s.id) })
                }
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              save({
                snippets: [
                  ...flow.snippets,
                  { id: newId(), trigger: "", expansion: "" },
                ],
              })
            }
          >
            <span className="flex items-center gap-1">
              <Plus size={14} /> {f("snippets.add")}
            </span>
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={f("cloud.title")}
        description={f("cloud.description")}
      >
        <ToggleSwitch
          checked={flow.cloud_stt.enabled ?? false}
          onChange={(v) =>
            save({ cloud_stt: { ...flow.cloud_stt, enabled: v } })
          }
          label={f("cloud.enabled.title")}
          description={f("cloud.enabled.description")}
          descriptionMode="tooltip"
          grouped={true}
        />
        <SettingContainer
          title={f("cloud.provider.title")}
          description={f("cloud.provider.description")}
          descriptionMode="tooltip"
          layout="horizontal"
          grouped={true}
        >
          <div className="flex items-center gap-2">
            <Dropdown
              options={opts<CloudSttProvider>(
                ["groq", "openai"],
                "cloud.provider.options",
              )}
              selectedValue={cloudProvider ?? "groq"}
              onSelect={(v) =>
                save({
                  cloud_stt: {
                    ...flow.cloud_stt,
                    provider: v as CloudSttProvider,
                  },
                })
              }
            />
            <BlurInput
              value={flow.cloud_stt.model ?? ""}
              placeholder={
                cloudProvider === "openai"
                  ? "gpt-4o-mini-transcribe"
                  : "whisper-large-v3-turbo"
              }
              onSave={(v) =>
                save({ cloud_stt: { ...flow.cloud_stt, model: v.trim() } })
              }
              className="w-56"
            />
          </div>
        </SettingContainer>
        <SettingContainer
          title={f("cloud.key.title")}
          description={f("cloud.key.description")}
          descriptionMode="tooltip"
          layout="horizontal"
          grouped={true}
        >
          <ApiKeyField
            value={keys[cloudKeyId] ?? ""}
            onBlur={(v) => updatePostProcessApiKey(cloudKeyId, v.trim())}
            disabled={false}
            placeholder={cloudKeyId === "groq" ? "gsk_..." : "sk-..."}
          />
        </SettingContainer>
        <ToggleSwitch
          checked={flow.cloud_stt.fallback_to_local ?? true}
          onChange={(v) =>
            save({ cloud_stt: { ...flow.cloud_stt, fallback_to_local: v } })
          }
          label={f("cloud.fallback.title")}
          description={f("cloud.fallback.description")}
          descriptionMode="tooltip"
          grouped={true}
        />
      </SettingsGroup>

      <SettingsGroup
        title={f("overrides.title")}
        description={f("overrides.description")}
      >
        <div className="px-4 py-3 space-y-2">
          {flow.app_overrides.map((o, i) => (
            <div key={i} className="flex items-center gap-2">
              <BlurInput
                value={o.app}
                placeholder={f("overrides.app")}
                onSave={(v) => updateOverride(i, { app: v.trim() })}
                className="flex-1"
              />
              <Dropdown
                options={categoryOptions}
                selectedValue={o.category}
                onSelect={(v) =>
                  updateOverride(i, { category: v as AppCategory })
                }
              />
              <Button
                variant="danger-ghost"
                size="sm"
                aria-label={f("overrides.remove")}
                onClick={() =>
                  save({
                    app_overrides: flow.app_overrides.filter((_, j) => j !== i),
                  })
                }
              >
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              save({
                app_overrides: [
                  ...flow.app_overrides,
                  { app: "", category: "other" },
                ],
              })
            }
          >
            <span className="flex items-center gap-1">
              <Plus size={14} /> {f("overrides.add")}
            </span>
          </Button>
        </div>
      </SettingsGroup>
    </div>
  );
};
