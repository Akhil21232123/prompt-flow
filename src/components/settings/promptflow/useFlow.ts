import type { FlowSettings } from "@/bindings";
import { useSettings } from "@/hooks/useSettings";

/** PromptFlow's settings with a `save` that merges a change into them. */
export const useFlow = () => {
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const flow: FlowSettings = getSetting("flow") ?? {};
  const save = (patch: Partial<FlowSettings>) =>
    updateSetting("flow", { ...flow, ...patch });
  return {
    flow,
    save,
    saving: isUpdating("flow"),
    privateMode: flow.private_mode ?? false,
    spokenLanguage: flow.spoken_language ?? "en",
    promptsInEnglish: flow.prompts_in_english ?? true,
    askBack: flow.ask_back ?? true,
    memoryEnabled: flow.memory_enabled ?? true,
    stylePreset: flow.style_preset ?? null,
    customStyle: flow.custom_style ?? "",
  };
};
