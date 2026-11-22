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
}
