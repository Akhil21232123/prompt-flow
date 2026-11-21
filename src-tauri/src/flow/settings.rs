//! Settings for PromptFlow's additions on top of Handy.
//!
//! Everything lives under one `flow` field of `AppSettings` so it is stored,
//! migrated and sent to the UI as a single unit. Every field has a serde
//! default, so older or partial stores load cleanly.

use serde::{Deserialize, Serialize};
use specta::Type;

/// How much a piece of dictated text gets formalised. Mirrors Wispr Flow's
/// per-context "Styles".
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum WritingStyle {
    /// Full sentences, proper capitalisation and punctuation.
    Formal,
    /// Sentence case, normal punctuation, relaxed tone.
    #[default]
    Casual,
    /// Lowercase, minimal punctuation, like texting a friend.
    VeryCasual,
}

/// The kind of app the user is typing into, detected from the frontmost app.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum AppCategory {
    Email,
    WorkChat,
    PersonalChat,
    /// Code editors and IDEs (Cursor, VS Code, Xcode...).
    Code,
    Terminal,
    /// Chat assistants (Claude, ChatGPT, Perplexity, Gemini...).
    AiChat,
    Docs,
    #[default]
    Other,
}

impl AppCategory {
    /// Apps where the text is very likely a prompt for another AI.
    pub fn is_ai_target(self) -> bool {
        matches!(
            self,
            AppCategory::AiChat | AppCategory::Code | AppCategory::Terminal
        )
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct CategoryStyles {
    #[serde(default = "formal")]
    pub email: WritingStyle,
    #[serde(default = "casual")]
    pub work_chat: WritingStyle,
    #[serde(default = "casual")]
    pub personal_chat: WritingStyle,
    #[serde(default = "formal")]
    pub docs: WritingStyle,
    #[serde(default = "casual")]
    pub other: WritingStyle,
}

fn formal() -> WritingStyle {
    WritingStyle::Formal
}
fn casual() -> WritingStyle {
    WritingStyle::Casual
}

impl Default for CategoryStyles {
    fn default() -> Self {
        Self {
            email: WritingStyle::Formal,
            work_chat: WritingStyle::Casual,
            personal_chat: WritingStyle::Casual,
            docs: WritingStyle::Formal,
            other: WritingStyle::Casual,
        }
    }
}

impl CategoryStyles {
    pub fn for_category(&self, category: AppCategory) -> WritingStyle {
        match category {
            AppCategory::Email => self.email,
            AppCategory::WorkChat => self.work_chat,
            AppCategory::PersonalChat => self.personal_chat,
            AppCategory::Docs => self.docs,
            // Code, terminals and AI chats get technical handling instead of a tone.
            AppCategory::Code | AppCategory::Terminal | AppCategory::AiChat => WritingStyle::Formal,
            AppCategory::Other => self.other,
        }
    }
}

/// A voice shortcut: say the trigger, get the expansion (Wispr "Snippets").
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct Snippet {
    pub id: String,
    pub trigger: String,
    pub expansion: String,
}

/// User override for how a specific app is categorised.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct AppCategoryOverride {
    /// Bundle id (e.g. `com.tinyspeck.slackmacgap`) or app name.
    pub app: String,
    pub category: AppCategory,
}

/// How hard Prompt Engineer works on a prompt.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum EngineerQuality {
    /// One rewrite call. Lowest latency.
    Fast,
    /// Rewrite, then one independent critique-and-revise pass.
    #[default]
    Balanced,
    /// Rewrite, then critique-and-revise until the critic scores it at
    /// `min_score` or `max_rounds` is reached.
    Max,
}

/// What kind of AI the engineered prompt is for.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum PromptTarget {
    /// Decide from the app in front and from what was said.
    #[default]
    Auto,
    CodingAgent,
    ChatAssistant,
    Research,
    Writing,
    ImageGeneration,
    DataAnalysis,
}

impl PromptTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            PromptTarget::Auto => "auto",
            PromptTarget::CodingAgent => "coding_agent",
            PromptTarget::ChatAssistant => "chat_assistant",
            PromptTarget::Research => "research",
            PromptTarget::Writing => "writing",
            PromptTarget::ImageGeneration => "image_generation",
            PromptTarget::DataAnalysis => "data_analysis",
        }
    }

    pub fn parse(s: &str) -> Option<PromptTarget> {
        let normalized = s.trim().to_ascii_lowercase().replace([' ', '-'], "_");
        Some(match normalized.as_str() {
            "auto" => PromptTarget::Auto,
            "coding_agent" | "coding" | "code" => PromptTarget::CodingAgent,
            "chat_assistant" | "chat" | "general" => PromptTarget::ChatAssistant,
            "research" => PromptTarget::Research,
            "writing" => PromptTarget::Writing,
            "image_generation" | "image" => PromptTarget::ImageGeneration,
            "data_analysis" | "data" => PromptTarget::DataAnalysis,
            _ => return None,
        })
    }
}

/// What the engineered prompt should do about details the speaker left out.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum MissingInfoPolicy {
    /// Tell the target AI to state reasonable assumptions and proceed.
    #[default]
    StateAssumptions,
    /// Tell the target AI to ask clarifying questions before starting.
    AskFirst,
}

/// Markup of the engineered prompt.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum PromptFormat {
    /// XML-tagged sections for Claude apps and coding agents, Markdown elsewhere.
    #[default]
    Auto,
    Xml,
    Markdown,
    /// Plain paragraphs, no markup.
    Plain,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
pub struct PromptEngineerSettings {
    #[serde(default)]
    pub quality: EngineerQuality,
    #[serde(default)]
    pub target: PromptTarget,
    #[serde(default)]
    pub missing_info: MissingInfoPolicy,
    #[serde(default)]
    pub format: PromptFormat,
    /// Critic score (1-10) at which Max mode stops revising.
    #[serde(default = "default_min_score")]
    pub min_score: u8,
    /// Upper bound on critique-and-revise rounds in Max mode.
    #[serde(default = "default_max_rounds")]
    pub max_rounds: u8,
    /// LLM provider for Prompt Engineer. `None` uses the post-processing provider.
    #[serde(default)]
    pub provider_id: Option<String>,
    /// Model for Prompt Engineer. `None` or empty uses that provider's model.
    #[serde(default)]
    pub model: Option<String>,
    /// When dictating with the normal shortcut into an AI chat, code editor or
    /// terminal, engineer the prompt automatically.
    #[serde(default = "default_true")]
    pub auto_in_ai_apps: bool,
    /// Dictations shorter than this many words are only cleaned up in auto
    /// mode, so "yes, go ahead" stays "Yes, go ahead."
    #[serde(default = "default_auto_min_words")]
    pub auto_min_words: u32,
    /// Extra standing instructions added to every engineered prompt (e.g.
    /// "I use TypeScript and pnpm").
    #[serde(default)]
    pub custom_instructions: String,
}

fn default_min_score() -> u8 {
    9
}
fn default_max_rounds() -> u8 {
    3
}
fn default_true() -> bool {
    true
}
fn default_auto_min_words() -> u32 {
    8
}

impl Default for PromptEngineerSettings {
    fn default() -> Self {
        Self {
            quality: EngineerQuality::default(),
            target: PromptTarget::default(),
            missing_info: MissingInfoPolicy::default(),
            format: PromptFormat::default(),
            min_score: default_min_score(),
            max_rounds: default_max_rounds(),
            provider_id: None,
            model: None,
            auto_in_ai_apps: true,
            auto_min_words: default_auto_min_words(),
            custom_instructions: String::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum CloudSttProvider {
    /// Groq's OpenAI-compatible Whisper endpoint. Uses the Groq API key from
    /// the post-processing providers.
    #[default]
    Groq,
    /// OpenAI's transcription endpoint. Uses the OpenAI API key.
    Openai,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
pub struct CloudSttSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub provider: CloudSttProvider,
    /// Empty uses the provider default (`whisper-large-v3-turbo` on Groq,
    /// `gpt-4o-mini-transcribe` on OpenAI).
    #[serde(default)]
    pub model: String,
    /// Use the local model when the cloud request fails.
    #[serde(default = "default_true")]
    pub fallback_to_local: bool,
}

impl Default for CloudSttSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: CloudSttProvider::Groq,
            model: String::new(),
            fallback_to_local: true,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
pub struct FlowSettings {
    /// Use PromptFlow's context-aware cleanup prompt (styles, backtracking,
    /// lists, developer formatting) instead of the selected static prompt.
    #[serde(default = "default_true")]
    pub smart_polish: bool,
    /// Polish with the main dictation shortcut too (Wispr behaviour), when an
    /// AI provider is configured and post-processing is enabled.
    #[serde(default = "default_true")]
    pub polish_main_shortcut: bool,
    /// Adapt tone and formatting to the app in front.
    #[serde(default = "default_true")]
    pub app_aware: bool,
    #[serde(default)]
    pub styles: CategoryStyles,
    /// camelCase/snake_case, file names and @-file tags in code editors.
    #[serde(default = "default_true")]
    pub developer_mode: bool,
    #[serde(default)]
    pub snippets: Vec<Snippet>,
    #[serde(default)]
    pub app_overrides: Vec<AppCategoryOverride>,
    #[serde(default)]
    pub prompt_engineer: PromptEngineerSettings,
    #[serde(default)]
    pub cloud_stt: CloudSttSettings,
}

impl Default for FlowSettings {
    fn default() -> Self {
        Self {
            smart_polish: true,
            polish_main_shortcut: true,
            app_aware: true,
            styles: CategoryStyles::default(),
            developer_mode: true,
            snippets: Vec::new(),
            app_overrides: Vec::new(),
            prompt_engineer: PromptEngineerSettings::default(),
            cloud_stt: CloudSttSettings::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_object_loads_defaults() {
        let s: FlowSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, FlowSettings::default());
        assert_eq!(s.prompt_engineer.min_score, 9);
        assert!(s.prompt_engineer.auto_in_ai_apps);
    }

    #[test]
    fn partial_nested_object_keeps_other_defaults() {
        let s: FlowSettings =
            serde_json::from_str(r#"{"prompt_engineer":{"quality":"max"}}"#).unwrap();
        assert_eq!(s.prompt_engineer.quality, EngineerQuality::Max);
        assert_eq!(s.prompt_engineer.max_rounds, 3);
        assert!(s.smart_polish);
    }

    #[test]
    fn target_parse_accepts_loose_forms() {
        assert_eq!(
            PromptTarget::parse("Coding Agent"),
            Some(PromptTarget::CodingAgent)
        );
        assert_eq!(
            PromptTarget::parse("image-generation"),
            Some(PromptTarget::ImageGeneration)
        );
        assert_eq!(PromptTarget::parse("nonsense"), None);
    }
}
