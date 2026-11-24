//! `POST /functions/v1/dictate`: the meta JSON, the WAV, and the three
//! answers (finished text, nothing heard, a question first).

use super::api::{self, ApiError};
use crate::flow::settings::{FlowSettings, StylePreset};
use serde::Serialize;
use serde_json::Value;
use specta::Type;
use tauri::AppHandle;

/// `meta.mode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudMode {
    Dictate,
    Engineer,
    Command,
    /// Smart (the Fn key): the server decides. Text selected → command; an
    /// AI app or code editor and 4+ words → engineer; else dictate.
    Auto,
}

impl CloudMode {
    pub fn as_str(self) -> &'static str {
        match self {
            CloudMode::Dictate => "dictate",
            CloudMode::Engineer => "engineer",
            CloudMode::Command => "command",
            CloudMode::Auto => "auto",
        }
    }
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
pub struct MetaApp {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surrounding_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl MetaApp {
    fn is_empty(&self) -> bool {
        *self == MetaApp::default()
    }
}

/// Where "This" got the text from.
#[derive(Serialize, serde::Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ScreenSource {
    Selection,
    Window,
    Ocr,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct MetaScreen {
    pub text: String,
    pub source: ScreenSource,
}

/// The most screen text the backend takes.
pub const SCREEN_MAX_CHARS: usize = 8000;
/// The most text before the cursor sent as `surrounding_text`.
pub const SURROUNDING_MAX_CHARS: usize = 1500;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct DictateMeta {
    pub mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<&'static str>,
    pub language: String,
    /// Absent for Smart: the server picks by the mode it settles on
    /// (English prompts when the user asked for them, words in their own
    /// language).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_language: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<MetaApp>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen: Option<MetaScreen>,
    pub ask_back: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clarify_session: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer_text: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub skip_clarify: bool,
    pub device: &'static str,
    /// One per recording, the same on every retry, so the server can tell a
    /// retry from a new dictation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// The audio went through the noise filter (a noisy place).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub noise_filtered: bool,
    /// The estimated speech-to-noise ratio, in dB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snr_db: Option<f32>,
}

/// A fresh `request_id`.
pub fn new_request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// How an ask-back is being answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClarifyAnswer {
    /// By voice: the recording is the answer.
    Voice,
    /// A tapped option.
    Text(String),
    /// "Just write it".
    Skip,
}

#[derive(Debug, Clone, Default)]
pub struct MetaInput {
    pub duration_sec: Option<f64>,
    pub app: MetaApp,
    pub selection: Option<String>,
    pub screen: Option<MetaScreen>,
}

pub fn preset_str(p: StylePreset) -> &'static str {
    match p {
        StylePreset::Clean => "clean",
        StylePreset::Formal => "formal",
        StylePreset::Short => "short",
        StylePreset::Casual => "casual",
        StylePreset::Bullets => "bullets",
        StylePreset::Custom => "custom",
    }
}

fn clean(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The meta for one request, per the v2 contract.
pub fn build_meta(
    mode: CloudMode,
    flow: &FlowSettings,
    input: MetaInput,
    clarify: Option<(String, ClarifyAnswer)>,
) -> DictateMeta {
    let language =
        if crate::flow::settings::SPOKEN_LANGUAGES.contains(&flow.spoken_language.as_str()) {
            flow.spoken_language.clone()
        } else {
            "auto".to_string()
        };
    let output_language = match mode {
        CloudMode::Engineer if flow.prompts_in_english => Some("en"),
        CloudMode::Auto => None,
        _ => Some("same"),
    };
    let app = MetaApp {
        name: clean(input.app.name),
        bundle_id: clean(input.app.bundle_id),
        title: clean(input.app.title).map(|t| super::context::head_chars(&t, 300)),
        surrounding_text: input
            .app
            .surrounding_text
            .filter(|t| !t.trim().is_empty())
            .map(|t| super::context::tail_chars(&t, SURROUNDING_MAX_CHARS)),
        url: clean(input.app.url),
    };
    let screen = input.screen.and_then(|s| {
        let text = super::context::head_chars(s.text.trim(), SCREEN_MAX_CHARS);
        (!text.is_empty()).then_some(MetaScreen {
            text,
            source: s.source,
        })
    });
    let (clarify_session, answer_text, skip_clarify) = match clarify {
        Some((session, ClarifyAnswer::Voice)) => (Some(session), None, false),
        Some((session, ClarifyAnswer::Text(t))) => (Some(session), Some(t), false),
        Some((session, ClarifyAnswer::Skip)) => (Some(session), None, true),
        None => (None, None, false),
    };
    DictateMeta {
        mode: mode.as_str(),
        duration_sec: input.duration_sec.map(|d| (d * 10.0).round() / 10.0),
        preset: match mode {
            // Plain (⌘Space) is your words, cleaned up: a preset also tells
            // the server never to turn it into a prompt.
            CloudMode::Dictate => Some(preset_str(flow.style_preset.unwrap_or(StylePreset::Clean))),
            // Smart writes for the app unless the user picked a style.
            CloudMode::Auto => flow.style_preset.map(preset_str),
            _ => None,
        },
        language,
        output_language,
        app: (!app.is_empty()).then_some(app),
        selection: match mode {
            CloudMode::Command | CloudMode::Auto => clean(input.selection),
            _ => None,
        },
        screen,
        ask_back: flow.ask_back && matches!(mode, CloudMode::Engineer | CloudMode::Auto),
        clarify_session,
        answer_text,
        skip_clarify,
        device: "mac",
        request_id: None,
        noise_filtered: false,
        snr_db: None,
    }
}

/// A memory the backend used, shown as a chip.
#[derive(Serialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct MemoryChip {
    pub id: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Finished {
    /// The stored dictation's id, for feedback.
    pub id: Option<String>,
    pub raw: String,
    pub text: String,
    pub mode: String,
    pub label: Option<String>,
    pub target: Option<String>,
    pub memory_used: Vec<MemoryChip>,
    pub language: Option<String>,
    /// Which recording the server's transcript came from when it got two:
    /// "raw" or "clean" (`timing.heard_from`).
    pub heard_from: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Clarify {
    pub session: String,
    pub question: String,
    pub options: Vec<String>,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DictateOutcome {
    Done(Finished),
    /// Nothing heard: paste nothing.
    Dropped {
        reason: String,
    },
    /// Ask-back: show the question; paste nothing yet.
    Ask(Clarify),
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

pub fn parse_response(v: &Value) -> Result<DictateOutcome, ApiError> {
    if v.get("dropped").and_then(Value::as_bool) == Some(true) {
        return Ok(DictateOutcome::Dropped {
            reason: s(v, "reason").unwrap_or_else(|| "silence".into()),
        });
    }
    if v.get("needs_clarification").and_then(Value::as_bool) == Some(true) {
        let session = s(v, "clarify_session").ok_or_else(|| {
            ApiError::server("PromptFlow asked a question it can't take an answer to")
        })?;
        let question = s(v, "question").unwrap_or_default();
        let options = v
            .get("options")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|o| !o.is_empty())
                    .take(4)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        return Ok(DictateOutcome::Ask(Clarify {
            session,
            question,
            options,
            raw: s(v, "raw").unwrap_or_default(),
        }));
    }
    let text = v
        .get("text")
        .and_then(Value::as_str)
        .map(|t| t.trim().to_string())
        .ok_or_else(|| ApiError::server("PromptFlow sent an answer it couldn't read"))?;
    if text.is_empty() {
        return Ok(DictateOutcome::Dropped {
            reason: "silence".into(),
        });
    }
    let memory_used = v
        .get("memory_used")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    Some(MemoryChip {
                        id: s(m, "id").unwrap_or_default(),
                        content: s(m, "content")?,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(DictateOutcome::Done(Finished {
        id: s(v, "id").or_else(|| s(v, "dictation_id")),
        raw: v
            .get("raw")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        text,
        mode: s(v, "mode").unwrap_or_default(),
        label: s(v, "label"),
        target: s(v, "target"),
        memory_used,
        language: s(v, "language"),
        heard_from: v.get("timing").and_then(|t| s(t, "heard_from")),
    }))
}

/// 16 kHz mono PCM16 WAV of `samples` (f32, -1..1).
pub fn encode_wav(samples: &[f32]) -> Vec<u8> {
    let rate = crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &x in samples {
        let v = (x.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// `POST /functions/v1/rewrite`: the same text again, another way (the
/// island's redo chips). Takes the same fields as `/dictate`'s meta.
pub async fn rewrite(
    app: &AppHandle,
    meta: &DictateMeta,
    text: &str,
) -> Result<DictateOutcome, ApiError> {
    let body = rewrite_body(meta, text);
    let v = api::authed_json(app, || api::post("/functions/v1/rewrite").json(&body)).await?;
    parse_response(&v)
}

pub fn rewrite_body(meta: &DictateMeta, text: &str) -> Value {
    let mut body = serde_json::to_value(meta).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(o) = body.as_object_mut() {
        o.insert("text".into(), Value::String(text.to_string()));
        o.remove("duration_sec");
        o.insert("ask_back".into(), Value::Bool(false));
    }
    body
}

/// Sends one request. `wav` is `None` only when answering an ask-back by
/// tapping or skipping.
pub async fn send(
    app: &AppHandle,
    meta: &DictateMeta,
    wav: Option<&[u8]>,
) -> Result<DictateOutcome, ApiError> {
    let meta_json = serde_json::to_string(meta).map_err(|e| ApiError::server(e.to_string()))?;
    send_json(app, &meta_json, wav, None).await
}

/// [`send`] with the meta already serialised (a kept recording's retry).
pub async fn send_json(
    app: &AppHandle,
    meta_json: &str,
    wav: Option<&[u8]>,
    clean: Option<&[u8]>,
) -> Result<DictateOutcome, ApiError> {
    let meta_json = meta_json.to_string();
    let files = audio_fields(wav, clean);
    let body = api::authed(app, || {
        let mut form = reqwest::multipart::Form::new().part(
            "meta",
            reqwest::multipart::Part::text(meta_json.clone())
                .mime_str("application/json")
                .unwrap_or_else(|_| reqwest::multipart::Part::text(meta_json.clone())),
        );
        for (field, file_name, bytes) in &files {
            let part = reqwest::multipart::Part::bytes(bytes.to_vec()).file_name(*file_name);
            let part = match part.mime_str("audio/wav") {
                Ok(p) => p,
                Err(_) => reqwest::multipart::Part::bytes(bytes.to_vec()).file_name(*file_name),
            };
            form = form.part(*field, part);
        }
        api::post("/functions/v1/dictate").multipart(form)
    })
    .await?;
    let v: Value = serde_json::from_str(&body)
        .map_err(|_| ApiError::server("PromptFlow sent an answer it couldn't read"))?;
    parse_response(&v)
}

/// The audio parts of a /dictate request: `audio`, and in heavy noise the
/// filtered copy as `audio_clean` (the server transcribes both and keeps
/// the surer transcript).
pub fn audio_fields<'a>(
    wav: Option<&'a [u8]>,
    clean: Option<&'a [u8]>,
) -> Vec<(&'static str, &'static str, &'a [u8])> {
    let mut files = Vec::new();
    if let Some(wav) = wav {
        files.push(("audio", "audio.wav", wav));
        if let Some(clean) = clean {
            files.push(("audio_clean", "audio_clean.wav", clean));
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn flow() -> FlowSettings {
        FlowSettings::default()
    }

    #[test]
    fn engineer_meta_matches_the_contract() {
        let input = MetaInput {
            duration_sec: Some(4.24),
            app: MetaApp {
                name: Some("ChatGPT".into()),
                bundle_id: Some("com.openai.chat".into()),
                title: Some("  ".into()),
                surrounding_text: Some("hello".into()),
                url: None,
            },
            selection: Some("ignored outside command".into()),
            screen: None,
        };
        let meta = build_meta(CloudMode::Engineer, &flow(), input, None);
        let v = serde_json::to_value(&meta).unwrap();
        assert!(v.get("request_id").is_none());
        assert_eq!(
            v,
            json!({
                "mode": "engineer",
                "duration_sec": 4.2,
                "language": "en",
                "output_language": "en",
                "app": {"name": "ChatGPT", "bundle_id": "com.openai.chat", "surrounding_text": "hello"},
                "ask_back": true,
                "device": "mac"
            })
        );
    }

    #[test]
    fn dictate_meta_sends_preset_and_keeps_language() {
        let mut f = flow();
        f.style_preset = Some(StylePreset::Bullets);
        f.spoken_language = "te".into();
        f.ask_back = true;
        let meta = build_meta(CloudMode::Dictate, &f, MetaInput::default(), None);
        assert_eq!(meta.preset, Some("bullets"));
        assert_eq!(meta.language, "te");
        assert_eq!(meta.output_language, Some("same"));
        assert!(!meta.ask_back, "ask-back is engineer only");
        assert!(meta.app.is_none());
    }

    #[test]
    fn heavy_noise_sends_two_files() {
        let fields = |w, c| {
            audio_fields(w, c)
                .into_iter()
                .map(|(f, n, b): (&str, &str, &[u8])| (f, n, b.to_vec()))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            fields(Some(&b"RAW"[..]), Some(&b"CLEAN"[..])),
            vec![
                ("audio", "audio.wav", b"RAW".to_vec()),
                ("audio_clean", "audio_clean.wav", b"CLEAN".to_vec())
            ]
        );
        assert_eq!(fields(Some(&b"RAW"[..]), None).len(), 1);
        // A tapped answer has no audio, so no filtered copy either.
        assert!(fields(None, Some(&b"CLEAN"[..])).is_empty());
    }

    #[test]
    fn heard_from_is_read_from_timing() {
        let v = json!({"raw": "hi", "text": "Hi.", "mode": "dictate",
            "timing": {"stt_ms": 1, "total_ms": 2, "heard_from": "clean"}});
        match parse_response(&v).unwrap() {
            DictateOutcome::Done(f) => assert_eq!(f.heard_from.as_deref(), Some("clean")),
            other => panic!("unexpected {other:?}"),
        }
        let v = json!({"raw": "hi", "text": "Hi.", "mode": "dictate"});
        match parse_response(&v).unwrap() {
            DictateOutcome::Done(f) => assert_eq!(f.heard_from, None),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn noise_fields_go_along_only_when_known() {
        let mut meta = build_meta(CloudMode::Auto, &flow(), MetaInput::default(), None);
        let v = serde_json::to_value(&meta).unwrap();
        assert!(v.get("noise_filtered").is_none());
        assert!(v.get("snr_db").is_none());
        meta.noise_filtered = true;
        meta.snr_db = Some(6.5);
        let v = serde_json::to_value(&meta).unwrap();
        assert_eq!(v["noise_filtered"], true);
        assert_eq!(v["snr_db"], 6.5);
    }

    #[test]
    fn plain_is_always_clean_words() {
        // ⌘Space with no style picked: "clean", so never a prompt.
        let meta = build_meta(CloudMode::Dictate, &flow(), MetaInput::default(), None);
        let v = serde_json::to_value(&meta).unwrap();
        assert_eq!(v["mode"], "dictate");
        assert_eq!(v["preset"], "clean");
        assert_eq!(v["output_language"], "same");
    }

    #[test]
    fn smart_sends_auto_with_the_selection() {
        let mut f = flow();
        f.ask_back = true;
        let input = MetaInput {
            duration_sec: Some(2.0),
            app: MetaApp {
                name: Some("Mail".into()),
                bundle_id: Some("com.apple.mail".into()),
                ..Default::default()
            },
            selection: Some("  Dear team, see you  ".into()),
            screen: None,
        };
        let v = serde_json::to_value(build_meta(CloudMode::Auto, &f, input, None)).unwrap();
        assert_eq!(
            v,
            json!({
                "mode": "auto",
                "duration_sec": 2.0,
                "language": "en",
                "app": {"name": "Mail", "bundle_id": "com.apple.mail"},
                "selection": "Dear team, see you",
                "ask_back": true,
                "device": "mac"
            })
        );
        // No selection, a style picked on purpose: the style goes along.
        f.style_preset = Some(StylePreset::Casual);
        let input = MetaInput {
            selection: Some("   ".into()),
            ..Default::default()
        };
        let v = serde_json::to_value(build_meta(CloudMode::Auto, &f, input, None)).unwrap();
        assert!(v.get("selection").is_none());
        assert!(v.get("output_language").is_none());
        assert_eq!(v["preset"], "casual");
    }

    #[test]
    fn engineer_can_keep_the_spoken_language() {
        let mut f = flow();
        f.prompts_in_english = false;
        f.spoken_language = "klingon".into();
        let meta = build_meta(CloudMode::Engineer, &f, MetaInput::default(), None);
        assert_eq!(meta.output_language, Some("same"));
        assert_eq!(meta.language, "auto");
    }

    #[test]
    fn command_sends_selection_and_screen_is_capped() {
        let input = MetaInput {
            selection: Some(" fix me ".into()),
            screen: Some(MetaScreen {
                text: "x".repeat(SCREEN_MAX_CHARS + 50),
                source: ScreenSource::Ocr,
            }),
            ..Default::default()
        };
        let meta = build_meta(CloudMode::Command, &flow(), input, None);
        assert_eq!(meta.selection.as_deref(), Some("fix me"));
        let screen = meta.screen.unwrap();
        assert_eq!(screen.text.chars().count(), SCREEN_MAX_CHARS);
        let v = serde_json::to_value(screen.source).unwrap();
        assert_eq!(v, json!("ocr"));
    }

    #[test]
    fn clarify_answers() {
        let tap = build_meta(
            CloudMode::Engineer,
            &flow(),
            MetaInput::default(),
            Some(("s1".into(), ClarifyAnswer::Text("Python".into()))),
        );
        let v = serde_json::to_value(&tap).unwrap();
        assert_eq!(v["clarify_session"], "s1");
        assert_eq!(v["answer_text"], "Python");
        assert!(v.get("skip_clarify").is_none());
        assert!(v.get("duration_sec").is_none());

        let skip = build_meta(
            CloudMode::Engineer,
            &flow(),
            MetaInput::default(),
            Some(("s1".into(), ClarifyAnswer::Skip)),
        );
        let v = serde_json::to_value(&skip).unwrap();
        assert_eq!(v["skip_clarify"], true);
        assert!(v.get("answer_text").is_none());

        let voice = build_meta(
            CloudMode::Engineer,
            &flow(),
            MetaInput::default(),
            Some(("s1".into(), ClarifyAnswer::Voice)),
        );
        let v = serde_json::to_value(&voice).unwrap();
        assert_eq!(v["clarify_session"], "s1");
        assert!(v.get("answer_text").is_none());
    }

    #[test]
    fn surrounding_text_keeps_the_end() {
        let input = MetaInput {
            app: MetaApp {
                surrounding_text: Some(format!("{}END", "a".repeat(3000))),
                ..Default::default()
            },
            ..Default::default()
        };
        let meta = build_meta(CloudMode::Dictate, &flow(), input, None);
        let t = meta.app.unwrap().surrounding_text.unwrap();
        assert_eq!(t.chars().count(), SURROUNDING_MAX_CHARS);
        assert!(t.ends_with("END"));
    }

    #[test]
    fn parses_finished_text() {
        let v = json!({
            "raw": "what you said", "text": " what to paste ", "mode": "engineer",
            "category": "ai_chat", "label": "Prompt · for Claude", "target": "claude",
            "guarded": [], "memory_used": [{"id": "m1", "content": "Building PromptFlow"}, {"id": "m2"}],
            "language": "te", "timing": {"stt_ms": 410, "total_ms": 1630}
        });
        match parse_response(&v).unwrap() {
            DictateOutcome::Done(f) => {
                assert_eq!(f.text, "what to paste");
                assert_eq!(f.label.as_deref(), Some("Prompt · for Claude"));
                assert_eq!(f.target.as_deref(), Some("claude"));
                assert_eq!(f.memory_used.len(), 1);
                assert_eq!(f.language.as_deref(), Some("te"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn rewrite_sends_the_text_and_never_asks_back() {
        let meta = build_meta(
            CloudMode::Engineer,
            &flow(),
            MetaInput {
                duration_sec: Some(3.0),
                ..Default::default()
            },
            None,
        );
        let body = rewrite_body(&meta, "say it again");
        assert_eq!(body["text"], "say it again");
        assert_eq!(body["mode"], "engineer");
        assert_eq!(body["ask_back"], false);
        assert!(body.get("duration_sec").is_none());
    }

    #[test]
    fn request_ids_are_unique_uuids() {
        let a = new_request_id();
        assert_eq!(a.len(), 36);
        assert_ne!(a, new_request_id());
    }

    #[test]
    fn finished_results_carry_their_id() {
        match parse_response(&json!({"id": "d1", "text": "hi", "raw": "hi"})).unwrap() {
            DictateOutcome::Done(f) => assert_eq!(f.id.as_deref(), Some("d1")),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn parses_dropped_and_empty_text() {
        assert_eq!(
            parse_response(&json!({"dropped": true, "raw": "", "reason": "hallucination"}))
                .unwrap(),
            DictateOutcome::Dropped {
                reason: "hallucination".into()
            }
        );
        assert!(matches!(
            parse_response(&json!({"text": "  ", "raw": ""})).unwrap(),
            DictateOutcome::Dropped { .. }
        ));
    }

    #[test]
    fn parses_ask_back() {
        let v = json!({
            "needs_clarification": true, "clarify_session": "uuid",
            "question": "Which language should the script use?",
            "options": ["Python", "JavaScript", "Go", "Rust", "C"],
            "raw": "write me a script that…"
        });
        match parse_response(&v).unwrap() {
            DictateOutcome::Ask(c) => {
                assert_eq!(c.session, "uuid");
                assert_eq!(c.options, vec!["Python", "JavaScript", "Go", "Rust"]);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(parse_response(&json!({"needs_clarification": true})).is_err());
    }

    #[test]
    fn unreadable_answers_are_errors() {
        assert!(parse_response(&json!({"raw": "x"})).is_err());
    }

    #[test]
    fn wav_header_is_16k_mono_pcm16() {
        let wav = encode_wav(&[0.0, 1.0, -1.0, 2.0]);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 8);
        assert_eq!(wav.len(), 44 + 8);
        let last = i16::from_le_bytes(wav[50..52].try_into().unwrap());
        assert_eq!(last, i16::MAX, "out-of-range samples are clamped");
    }
}
