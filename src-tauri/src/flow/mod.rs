//! PromptFlow: the features layered on top of Handy to match and go beyond
//! Wispr Flow.
//!
//! - `app_context`   — which app is in front, and what kind it is
//! - `polish`        — context-aware cleanup prompt (styles, backtracking, lists, dev casing)
//! - `snippets`      — voice shortcuts expanded after cleanup
//! - `prompt_engineer` — dictation → engineered prompt, with a critique/revise loop
//! - `command_mode`  — voice edits of selected text
//! - `cloud_stt`     — optional Groq/OpenAI transcription with local fallback

pub mod app_context;
pub mod cloud_stt;
pub mod command_mode;
pub mod fidelity;
pub mod hallucination;
pub mod llm;
pub mod polish;
pub mod prompt_engineer;
pub mod settings;
pub mod snippets;

use app_context::AppContext;
use settings::{AppCategory, WritingStyle};

use crate::settings::{AppSettings, LLMPrompt};

/// Which shortcut started the recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum FlowMode {
    #[default]
    Dictate,
    PromptEngineer,
    Command,
    /// "This": Prompt Engineer with what's on screen. On-device (Private
    /// mode) it runs as plain Prompt Engineer.
    This,
    /// Smart (hold Fn): PromptFlow decides. Text selected → edit it; an AI
    /// app or code editor → a prompt; anywhere else → your words, written
    /// for that app. The cloud decides on the server (`mode: "auto"`).
    Auto,
}

/// Fewer words than this are never turned into a prompt (the server's
/// `MIN_PROMPT_WORDS`).
pub const MIN_PROMPT_WORDS: usize = 4;

/// What Smart (Fn) does with a recording, decided the same way as the
/// server: a selection is edited, an AI app or code editor gets a prompt
/// (from four words), anything else gets the speaker's words.
pub fn resolve_auto(category: AppCategory, selection: Option<&str>, transcript: &str) -> FlowMode {
    // A highlight in a terminal is output, never something to rewrite.
    if category != AppCategory::Terminal && selection.is_some_and(|s| !s.trim().is_empty()) {
        FlowMode::Command
    } else if category.is_ai_target() && word_count(transcript) >= MIN_PROMPT_WORDS {
        FlowMode::PromptEngineer
    } else {
        FlowMode::Dictate
    }
}

/// Everything the output stage needs to know about one recording.
#[derive(Debug, Clone, Default)]
pub struct FlowInput {
    pub mode: FlowMode,
    pub app: Option<AppContext>,
    /// Text that was selected when a Command Mode recording ended.
    pub selection: Option<String>,
}

/// Result of a Prompt Engineer or Command Mode run.
pub struct SpecialOutput {
    pub text: String,
    /// Shown in history as the "prompt" that produced the text.
    pub label: String,
    pub failed: bool,
}

pub const SMART_POLISH_PROMPT_ID: &str = "__promptflow_smart_polish__";

pub fn category_for(settings: &AppSettings, app: Option<&AppContext>) -> AppCategory {
    match app {
        Some(ctx) if settings.flow.app_aware => {
            app_context::classify(ctx, &settings.flow.app_overrides)
        }
        _ => AppCategory::Other,
    }
}

pub fn style_for(settings: &AppSettings, category: AppCategory) -> WritingStyle {
    settings.flow.styles.for_category(category)
}

/// The settings to run Handy's post-processing with: a copy whose selected
/// prompt is PromptFlow's context-aware prompt for this dictation.
pub fn smart_polish_settings(
    settings: &AppSettings,
    app: Option<&AppContext>,
    category: AppCategory,
    has_snippet_tokens: bool,
) -> AppSettings {
    let prompt = polish::build_prompt(&polish::PolishContext {
        category,
        style: style_for(settings, category),
        preset: settings
            .flow
            .style_preset
            .map(|p| polish::preset_rule(p, &settings.flow.custom_style)),
        app: if settings.flow.app_aware { app } else { None },
        developer_mode: settings.flow.developer_mode,
        dictionary: &settings.custom_words,
        has_snippet_tokens,
    });
    let mut patched = settings.clone();
    patched
        .post_process_prompts
        .retain(|p| p.id != SMART_POLISH_PROMPT_ID);
    patched.post_process_prompts.push(LLMPrompt {
        id: SMART_POLISH_PROMPT_ID.to_string(),
        name: "PromptFlow smart polish".to_string(),
        prompt,
    });
    patched.post_process_selected_prompt_id = Some(SMART_POLISH_PROMPT_ID.to_string());
    patched
}

/// What History shows for a cleaned-up dictation, in plain words.
pub fn smart_polish_label(_category: AppCategory, style: WritingStyle) -> String {
    let style = match style {
        WritingStyle::Formal => "formal",
        WritingStyle::Casual => "casual",
        WritingStyle::VeryCasual => "very casual",
    };
    format!("Cleaned up · {style}")
}

fn word_count(text: &str) -> usize {
    text.split_whitespace().count()
}

/// Run Prompt Engineer or Command Mode. `None` means "not handled here":
/// the caller continues with normal dictation cleanup.
pub async fn run_special(
    settings: &AppSettings,
    transcript: &str,
    input: &FlowInput,
) -> Option<SpecialOutput> {
    let app = input.app.as_ref();
    let category = category_for(settings, app);

    // Plain dictation (⌘Space) is never turned into a prompt: Smart (Fn)
    // is the key that decides.
    let mode = match input.mode {
        FlowMode::Auto => resolve_auto(category, input.selection.as_deref(), transcript),
        mode => mode,
    };
    let engineer = matches!(mode, FlowMode::PromptEngineer | FlowMode::This);

    if mode == FlowMode::Command {
        return Some(run_command(settings, transcript, input, category).await);
    }
    if !engineer {
        return None;
    }

    let pe = &settings.flow.prompt_engineer;
    let llm = match llm::ProviderLlm::from_settings(
        settings,
        pe.provider_id.as_deref(),
        pe.model.as_deref(),
    ) {
        Ok(llm) => llm,
        Err(reason) => {
            log::warn!("Prompt Engineer is not set up ({reason}); using normal cleanup");
            return None;
        }
    };

    let protected = snippets::protect(transcript, &settings.flow.snippets);
    let request = prompt_engineer::EngineerRequest {
        transcript: &protected.text,
        app,
        category,
        settings: pe,
        dictionary: &settings.custom_words,
        has_snippet_tokens: !protected.tokens.is_empty(),
    };
    log::info!(
        "Prompt Engineer running with {} ({:?})",
        llm.label(),
        pe.quality
    );
    match prompt_engineer::engineer(&llm, &request).await {
        Ok(outcome) => {
            if !outcome.issues.is_empty() {
                log::debug!("Prompt critic issues: {:?}", outcome.issues);
            }
            let source = trusted_source(&protected.text, settings, input);
            let invented = fidelity::find_inventions(&source, &outcome.prompt);
            if !invented.is_empty() {
                log::warn!(
                    "Prompt Engineer added facts you didn't say ({}); using normal cleanup",
                    invented.join(", ")
                );
                return None;
            }
            Some(SpecialOutput {
                text: snippets::expand(&outcome.prompt, &protected.tokens),
                label: outcome.summary(),
                failed: false,
            })
        }
        Err(e) => {
            log::warn!("Prompt Engineer failed ({e}); using normal cleanup");
            None
        }
    }
}

/// What a rewrite may draw facts from: what was said plus the context the
/// user trusts (dictionary, snippet triggers, selected text, the app).
pub fn trusted_source(transcript: &str, settings: &AppSettings, input: &FlowInput) -> String {
    let mut parts = vec![transcript.to_string()];
    parts.extend(settings.custom_words.iter().cloned());
    if let Some(sel) = &input.selection {
        parts.push(sel.clone());
    }
    if let Some(app) = &input.app {
        parts.push(format!("{app:?}"));
    }
    parts.join("\n")
}

async fn run_command(
    settings: &AppSettings,
    transcript: &str,
    input: &FlowInput,
    category: AppCategory,
) -> SpecialOutput {
    let pe = &settings.flow.prompt_engineer;
    let style = style_for(settings, category);
    let result = match llm::ProviderLlm::from_settings(
        settings,
        pe.provider_id.as_deref(),
        pe.model.as_deref(),
    ) {
        Ok(llm) => {
            command_mode::run(
                &llm,
                transcript,
                input.selection.as_deref(),
                input.app.as_ref(),
                category,
                style,
            )
            .await
        }
        Err(reason) => Err(reason),
    };
    match result {
        Ok(text) => SpecialOutput {
            text: snippets::apply(&text, &settings.flow.snippets),
            label: if input
                .selection
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty())
            {
                "Edited your selection".into()
            } else {
                "Wrote new text".into()
            },
            failed: false,
        },
        Err(e) => {
            // Pasting the spoken instruction over the user's selection would
            // destroy it, so a failed command pastes nothing.
            log::warn!("Command Mode failed: {e}");
            SpecialOutput {
                text: String::new(),
                label: format!("Couldn't make that edit: {e}"),
                failed: true,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::get_default_settings;

    fn ctx(name: &str, bundle: &str) -> AppContext {
        AppContext {
            app_name: Some(name.into()),
            bundle_id: Some(bundle.into()),
            window_title: None,
        }
    }

    #[test]
    fn smart_decides_like_the_server() {
        let long = "so I want you to build me a landing page";
        assert_eq!(
            resolve_auto(AppCategory::AiChat, None, long),
            FlowMode::PromptEngineer
        );
        assert_eq!(
            resolve_auto(AppCategory::Code, None, "fix the login bug now"),
            FlowMode::PromptEngineer
        );
        // Short replies stay words, even in an AI app.
        assert_eq!(
            resolve_auto(AppCategory::AiChat, None, "yes go ahead"),
            FlowMode::Dictate
        );
        assert_eq!(
            resolve_auto(AppCategory::Email, None, long),
            FlowMode::Dictate
        );
        // A selection is always an edit.
        assert_eq!(
            resolve_auto(AppCategory::Email, Some("Dear team"), "make it warmer"),
            FlowMode::Command
        );
        assert_eq!(
            resolve_auto(AppCategory::AiChat, Some("  "), long),
            FlowMode::PromptEngineer
        );
        assert_eq!(
            resolve_auto(AppCategory::Terminal, Some("error: build failed"), long),
            FlowMode::PromptEngineer,
            "terminal output is never edited"
        );
    }

    #[test]
    fn smart_polish_injects_and_selects_prompt() {
        let mut s = get_default_settings();
        s.custom_words = vec!["Dayoph".into()];
        let app = ctx("Mail", "com.apple.mail");
        let category = category_for(&s, Some(&app));
        assert_eq!(category, AppCategory::Email);
        let patched = smart_polish_settings(&s, Some(&app), category, false);
        let selected = patched.post_process_selected_prompt_id.clone().unwrap();
        assert_eq!(selected, SMART_POLISH_PROMPT_ID);
        let prompt = patched
            .post_process_prompts
            .iter()
            .find(|p| p.id == selected)
            .unwrap();
        assert!(prompt.prompt.contains("Dayoph"));
        assert!(prompt.prompt.contains("Tone: formal"));
        // Re-patching doesn't stack copies.
        let twice = smart_polish_settings(&patched, Some(&app), category, false);
        assert_eq!(
            twice
                .post_process_prompts
                .iter()
                .filter(|p| p.id == SMART_POLISH_PROMPT_ID)
                .count(),
            1
        );
    }

    #[test]
    fn fresh_install_defaults_to_local_ollama() {
        let s = get_default_settings();
        assert_eq!(s.post_process_provider_id, "custom");
        assert!(s.post_process_enabled);
        let llm = llm::ProviderLlm::from_settings(&s, None, None).unwrap();
        assert!(llm.label().contains("llama3.1"));
    }

    #[test]
    fn app_awareness_can_be_turned_off() {
        let mut s = get_default_settings();
        s.flow.app_aware = false;
        assert_eq!(
            category_for(&s, Some(&ctx("Mail", "com.apple.mail"))),
            AppCategory::Other
        );
    }

    #[test]
    fn unconfigured_engineer_falls_back() {
        // A cloud provider with no API key: Prompt Engineer declines and
        // normal cleanup takes over.
        let mut s = get_default_settings();
        s.post_process_provider_id = "openai".into();
        let input = FlowInput {
            mode: FlowMode::PromptEngineer,
            ..Default::default()
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        assert!(rt
            .block_on(run_special(
                &s,
                "write me a haiku about rain please now",
                &input
            ))
            .is_none());
    }

    #[test]
    fn unconfigured_command_pastes_nothing() {
        let mut s = get_default_settings();
        s.post_process_provider_id = "openai".into();
        let input = FlowInput {
            mode: FlowMode::Command,
            selection: Some("keep me".into()),
            ..Default::default()
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let out = rt
            .block_on(run_special(&s, "make it shorter", &input))
            .unwrap();
        assert!(out.failed);
        assert!(out.text.is_empty());
    }
}
