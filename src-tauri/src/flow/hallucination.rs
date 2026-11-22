//! Whisper-family models fill silence with stock phrases learned from video
//! subtitles ("Thank you.", "Thanks for watching!"). A short clip whose whole
//! transcript is one of these is dropped instead of pasted. Mirrors
//! `backend/supabase/functions/_shared/hallucination.ts`.

const STOCK: &[&str] = &[
    "thank you",
    "thank you very much",
    "thanks",
    "thanks for watching",
    "thank you for watching",
    "thanks for watching and see you next time",
    "please subscribe",
    "subscribe",
    "like and subscribe",
    "bye",
    "bye bye",
    "you",
    "okay",
    "so",
    "uh",
    "um",
    "hmm",
    "music",
    "applause",
    "silence",
    "the end",
    "subtitles by the amara org community",
];

fn normalize(text: &str) -> String {
    let cleaned: String = text
        .to_lowercase()
        .chars()
        .map(|c| {
            if "[]()♪*.,!?'\"…-".contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// True when a transcript is probably invented from silence: a stock phrase
/// from a clip too short to have said it deliberately.
pub fn is_likely_hallucination(text: &str, duration_sec: f32) -> bool {
    let norm = normalize(text);
    !norm.is_empty() && STOCK.contains(&norm.as_str()) && duration_sec < 2.5
}

/// True when a short transcript only repeats dictionary words. Whisper gets
/// the dictionary as a spelling hint, and on silence it often echoes it back.
pub fn is_prompt_echo(text: &str, dictionary: &[String]) -> bool {
    let words: Vec<String> = normalize(text)
        .split_whitespace()
        .map(String::from)
        .collect();
    if words.is_empty() || words.len() > 4 || dictionary.is_empty() {
        return false;
    }
    let hint: std::collections::HashSet<String> = dictionary
        .iter()
        .flat_map(|w| {
            normalize(w)
                .split_whitespace()
                .map(String::from)
                .collect::<Vec<_>>()
        })
        .collect();
    words.iter().all(|w| hint.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_stock_phrases_on_short_clips() {
        assert!(is_likely_hallucination("Thank you.", 1.2));
        assert!(is_likely_hallucination(" [Music] ", 0.8));
        assert!(is_likely_hallucination("Thanks for watching!", 2.0));
    }

    #[test]
    fn keeps_real_speech() {
        assert!(!is_likely_hallucination("Thank you.", 3.0));
        assert!(!is_likely_hallucination("Thank you for the update", 1.5));
        assert!(!is_likely_hallucination("", 1.0));
    }

    #[test]
    fn drops_dictionary_echoes() {
        let dict = vec!["PromptFlow".to_string(), "Wispr Flow".to_string()];
        assert!(is_prompt_echo("Wispr.", &dict));
        assert!(is_prompt_echo("PromptFlow", &dict));
        assert!(!is_prompt_echo("Wispr Flow is slow", &dict));
        assert!(!is_prompt_echo("Wispr", &[]));
    }
}
