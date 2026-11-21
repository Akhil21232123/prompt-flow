//! Optional cloud speech-to-text through OpenAI-compatible
//! `/audio/transcriptions` endpoints (Groq Whisper, OpenAI). Reuses the API
//! key and base URL of the matching post-processing provider, so a Groq key
//! entered once serves both transcription and cleanup.

use super::settings::{CloudSttProvider, CloudSttSettings};
use crate::settings::AppSettings;
use std::io::Cursor;
use std::time::Duration;

const SAMPLE_RATE: u32 = 16_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Whisper's prompt is capped at 224 tokens; stay well under it.
const MAX_VOCAB_PROMPT_CHARS: usize = 600;

pub struct CloudTarget {
    pub url: String,
    pub api_key: String,
    pub model: String,
}

fn provider_id(p: CloudSttProvider) -> &'static str {
    match p {
        CloudSttProvider::Groq => "groq",
        CloudSttProvider::Openai => "openai",
    }
}

fn default_model(p: CloudSttProvider) -> &'static str {
    match p {
        CloudSttProvider::Groq => "whisper-large-v3-turbo",
        CloudSttProvider::Openai => "gpt-4o-mini-transcribe",
    }
}

fn default_base_url(p: CloudSttProvider) -> &'static str {
    match p {
        CloudSttProvider::Groq => "https://api.groq.com/openai/v1",
        CloudSttProvider::Openai => "https://api.openai.com/v1",
    }
}

/// Where to send audio, or `None` when cloud STT is off or has no key.
pub fn target(settings: &AppSettings) -> Option<CloudTarget> {
    let cloud: &CloudSttSettings = &settings.flow.cloud_stt;
    if !cloud.enabled {
        return None;
    }
    let id = provider_id(cloud.provider);
    let api_key = settings
        .post_process_api_keys
        .get(id)
        .cloned()
        .unwrap_or_default();
    if api_key.trim().is_empty() {
        log::warn!("Cloud transcription is on but no {id} API key is set; using the local model");
        return None;
    }
    let base = settings
        .post_process_provider(id)
        .map(|p| p.base_url.clone())
        .unwrap_or_else(|| default_base_url(cloud.provider).to_string());
    let model = if cloud.model.trim().is_empty() {
        default_model(cloud.provider).to_string()
    } else {
        cloud.model.trim().to_string()
    };
    Some(CloudTarget {
        url: format!("{}/audio/transcriptions", base.trim_end_matches('/')),
        api_key,
        model,
    })
}

/// Whether recordings go to the cloud (so recording may start without a
/// local model loaded).
pub fn is_active(settings: &AppSettings) -> bool {
    target(settings).is_some()
}

/// 16 kHz mono f32 samples → 16-bit PCM WAV bytes.
pub fn encode_wav(samples: &[f32]) -> Result<Vec<u8>, String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut buf = Cursor::new(Vec::with_capacity(samples.len() * 2 + 44));
    {
        let mut writer = hound::WavWriter::new(&mut buf, spec).map_err(|e| e.to_string())?;
        for &s in samples {
            let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            writer.write_sample(v).map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;
    }
    Ok(buf.into_inner())
}

/// Dictionary words as a Whisper prompt, which biases spelling.
pub fn vocabulary_prompt(words: &[String]) -> Option<String> {
    let mut out = String::new();
    for w in words.iter().map(|w| w.trim()).filter(|w| !w.is_empty()) {
        if out.len() + w.len() + 2 > MAX_VOCAB_PROMPT_CHARS {
            break;
        }
        if !out.is_empty() {
            out.push_str(", ");
        }
        out.push_str(w);
    }
    (!out.is_empty()).then_some(out)
}

/// The language to request, or `None` to let the service detect it.
pub fn language_param(selected: &str) -> Option<String> {
    let s = selected.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("auto") {
        return None;
    }
    // Handy stores codes like "en" or "zh-Hans"; the API wants ISO-639-1.
    Some(s.split(['-', '_']).next().unwrap_or(s).to_ascii_lowercase())
}

#[derive(serde::Deserialize)]
struct TranscriptionResponse {
    text: String,
}

pub async fn transcribe(
    target: &CloudTarget,
    samples: &[f32],
    settings: &AppSettings,
) -> Result<String, String> {
    let wav = encode_wav(samples)?;
    let mut form = reqwest::multipart::Form::new()
        .part(
            "file",
            reqwest::multipart::Part::bytes(wav)
                .file_name("audio.wav")
                .mime_str("audio/wav")
                .map_err(|e| e.to_string())?,
        )
        .text("model", target.model.clone())
        .text("response_format", "json")
        .text("temperature", "0");
    if let Some(lang) = language_param(&settings.selected_language) {
        form = form.text("language", lang);
    }
    if let Some(prompt) = vocabulary_prompt(&settings.custom_words) {
        form = form.text("prompt", prompt);
    }

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(&target.url)
        .bearer_auth(&target.api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("cloud transcription request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let body: String = body.chars().take(300).collect();
        return Err(format!("cloud transcription returned {status}: {body}"));
    }
    let parsed: TranscriptionResponse = response
        .json()
        .await
        .map_err(|e| format!("cloud transcription reply was not understood: {e}"))?;
    Ok(parsed.text.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_has_header_and_samples() {
        let wav = encode_wav(&[0.0, 0.5, -1.0, 2.0]).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(wav.len(), 44 + 4 * 2);
        let reader = hound::WavReader::new(Cursor::new(wav)).unwrap();
        let samples: Vec<i16> = reader.into_samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(samples, vec![0, 16383, -32767, 32767]);
    }

    #[test]
    fn vocabulary_prompt_is_bounded() {
        assert_eq!(vocabulary_prompt(&[]), None);
        assert_eq!(
            vocabulary_prompt(&["Akhil".into(), " ".into(), "Supabase".into()]).as_deref(),
            Some("Akhil, Supabase")
        );
        let many: Vec<String> = (0..500).map(|i| format!("word{i}")).collect();
        assert!(vocabulary_prompt(&many).unwrap().len() <= MAX_VOCAB_PROMPT_CHARS);
    }

    #[test]
    fn language_mapping() {
        assert_eq!(language_param("auto"), None);
        assert_eq!(language_param("en"), Some("en".into()));
        assert_eq!(language_param("zh-Hans"), Some("zh".into()));
    }

    #[test]
    fn target_requires_enable_and_key() {
        let mut s = crate::settings::get_default_settings();
        assert!(target(&s).is_none());
        s.flow.cloud_stt.enabled = true;
        assert!(target(&s).is_none(), "no key yet");
        s.post_process_api_keys
            .insert("groq".into(), "gsk_test".into());
        let t = target(&s).unwrap();
        assert_eq!(t.url, "https://api.groq.com/openai/v1/audio/transcriptions");
        assert_eq!(t.model, "whisper-large-v3-turbo");
    }
}
