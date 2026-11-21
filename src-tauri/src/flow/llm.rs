//! Adapts Handy's post-processing providers (OpenAI, Anthropic, Groq,
//! OpenRouter, Cerebras, Bedrock, Apple Intelligence, custom/Ollama) to the
//! [`LlmBackend`] trait used by Prompt Engineer and Command Mode.

use super::prompt_engineer::{BoxFuture, LlmBackend};
use crate::settings::{AppSettings, PostProcessProvider, APPLE_INTELLIGENCE_PROVIDER_ID};

pub struct ProviderLlm {
    provider: PostProcessProvider,
    api_key: String,
    model: String,
    disable_reasoning: bool,
}

/// Why no LLM could be set up; shown in logs and history.
pub fn not_configured_reason(settings: &AppSettings, provider_id: Option<&str>) -> Option<String> {
    ProviderLlm::from_settings(settings, provider_id, None).err()
}

impl ProviderLlm {
    /// `provider_id`/`model` override the post-processing selection when set.
    pub fn from_settings(
        settings: &AppSettings,
        provider_id: Option<&str>,
        model: Option<&str>,
    ) -> Result<Self, String> {
        let provider = match provider_id.map(str::trim).filter(|p| !p.is_empty()) {
            Some(id) => settings
                .post_process_provider(id)
                .ok_or_else(|| format!("AI provider '{id}' is not configured"))?,
            None => settings
                .active_post_process_provider()
                .ok_or("no AI provider is selected")?,
        }
        .clone();

        let model = model
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(str::to_string)
            .or_else(|| settings.post_process_models.get(&provider.id).cloned())
            .unwrap_or_default();
        if model.trim().is_empty() && provider.id != APPLE_INTELLIGENCE_PROVIDER_ID {
            return Err(format!("no model is set for {}", provider.label));
        }

        let api_key = settings
            .post_process_api_keys
            .get(&provider.id)
            .cloned()
            .unwrap_or_default();
        let needs_key = !matches!(
            provider.id.as_str(),
            "custom" | APPLE_INTELLIGENCE_PROVIDER_ID
        );
        if needs_key && api_key.trim().is_empty() {
            return Err(format!("no API key is set for {}", provider.label));
        }

        let disable_reasoning = matches!(provider.id.as_str(), "custom" | "openrouter");
        Ok(Self {
            provider,
            api_key,
            model,
            disable_reasoning,
        })
    }

    pub fn label(&self) -> String {
        format!("{} / {}", self.provider.label, self.model)
    }
}

impl LlmBackend for ProviderLlm {
    fn complete<'a>(
        &'a self,
        system: &'a str,
        user: String,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            if self.provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
                return apple_intelligence(system, &user, &self.model);
            }
            match crate::llm_client::send_chat_completion_with_schema(
                &self.provider,
                self.api_key.clone(),
                &self.model,
                user,
                Some(system.to_string()),
                None,
                self.disable_reasoning,
            )
            .await?
            {
                Some(text) if !text.trim().is_empty() => Ok(text),
                _ => Err("the model returned an empty reply".into()),
            }
        })
    }
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn apple_intelligence(system: &str, user: &str, model: &str) -> Result<String, String> {
    if !crate::apple_intelligence::check_apple_intelligence_availability() {
        return Err("Apple Intelligence is not available on this Mac".into());
    }
    let token_limit = model.trim().parse::<i32>().unwrap_or(0);
    crate::apple_intelligence::process_text_with_system_prompt(system, user, token_limit)
}

#[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
fn apple_intelligence(_system: &str, _user: &str, _model: &str) -> Result<String, String> {
    Err("Apple Intelligence needs an Apple Silicon Mac".into())
}
