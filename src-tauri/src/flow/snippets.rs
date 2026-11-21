//! Voice snippets: say a trigger phrase ("my calendly link"), get the saved
//! text. Triggers are swapped for placeholder tokens before the transcript
//! goes to an LLM, so the model can't paraphrase a link or address, and the
//! tokens are expanded again afterwards.

use super::settings::Snippet;
use regex::{Regex, RegexBuilder};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Protected {
    pub text: String,
    /// (token, expansion) pairs in order of appearance.
    pub tokens: Vec<(String, String)>,
}

fn token(n: usize) -> String {
    format!("[[SNIPPET_{n}]]")
}

/// Regex for a trigger that tolerates the capitalisation, commas and full
/// stops speech-to-text puts between spoken words.
fn trigger_regex(trigger: &str) -> Option<Regex> {
    let words: Vec<String> = trigger
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|w| !w.is_empty())
        .map(regex::escape)
        .collect();
    if words.is_empty() {
        return None;
    }
    let pattern = format!(r"\b{}\b[.!?]?", words.join(r"[\s,.\-]+"));
    RegexBuilder::new(&pattern)
        .case_insensitive(true)
        .build()
        .ok()
}

/// Replace every spoken trigger with a token. Longer triggers are matched
/// first so "my work email" wins over "my email".
pub fn protect(text: &str, snippets: &[Snippet]) -> Protected {
    let mut ordered: Vec<&Snippet> = snippets
        .iter()
        .filter(|s| !s.trigger.trim().is_empty())
        .collect();
    ordered.sort_by_key(|s| std::cmp::Reverse(s.trigger.trim().len()));

    let mut out = text.to_string();
    let mut tokens = Vec::new();
    for snippet in ordered {
        let Some(re) = trigger_regex(&snippet.trigger) else {
            continue;
        };
        // One pass per snippet; the `_` in tokens keeps `\b` triggers from
        // ever matching inside a token inserted earlier.
        let replaced = re.replace_all(&out, |_: &regex::Captures| {
            let t = token(tokens.len() + 1);
            tokens.push((t.clone(), snippet.expansion.clone()));
            t
        });
        out = replaced.into_owned();
    }
    Protected { text: out, tokens }
}

/// Put the snippet text back. Tokens the model dropped are appended so the
/// user never silently loses a snippet they said.
pub fn expand(text: &str, tokens: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (t, expansion) in tokens {
        if out.contains(t.as_str()) {
            out = out.replace(t.as_str(), expansion);
        } else {
            // Also accept the token with the brackets mangled to single ones.
            let loose = t.trim_start_matches('[').trim_end_matches(']');
            let single = format!("[{loose}]");
            if out.contains(&single) {
                out = out.replace(&single, expansion);
            } else if out.contains(loose) {
                out = out.replace(loose, expansion);
            } else {
                if !out.is_empty() && !out.ends_with(char::is_whitespace) {
                    out.push(' ');
                }
                out.push_str(expansion);
            }
        }
    }
    out
}

/// Expand triggers directly, for paths with no LLM in between.
pub fn apply(text: &str, snippets: &[Snippet]) -> String {
    let p = protect(text, snippets);
    expand(&p.text, &p.tokens)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(trigger: &str, expansion: &str) -> Snippet {
        Snippet {
            id: trigger.into(),
            trigger: trigger.into(),
            expansion: expansion.into(),
        }
    }

    #[test]
    fn protects_and_expands() {
        let snippets = vec![s("my calendly link", "https://calendly.com/akhil/30min")];
        let p = protect("Sure, book here: My Calendly link. Thanks", &snippets);
        assert_eq!(p.text, "Sure, book here: [[SNIPPET_1]] Thanks");
        assert_eq!(
            expand(&p.text, &p.tokens),
            "Sure, book here: https://calendly.com/akhil/30min Thanks"
        );
    }

    #[test]
    fn tolerates_punctuation_between_words() {
        let snippets = vec![s("my calendly link", "LINK")];
        assert_eq!(
            apply("here is my, calendly link", &snippets),
            "here is LINK"
        );
    }

    #[test]
    fn longest_trigger_wins() {
        let snippets = vec![s("my email", "a@x.com"), s("my work email", "a@work.com")];
        assert_eq!(
            apply("send it to my work email", &snippets),
            "send it to a@work.com"
        );
    }

    #[test]
    fn does_not_match_inside_words() {
        let snippets = vec![s("addr", "221B Baker St")];
        assert_eq!(apply("the address is", &snippets), "the address is");
    }

    #[test]
    fn dropped_token_is_appended() {
        let tokens = vec![("[[SNIPPET_1]]".to_string(), "LINK".to_string())];
        assert_eq!(expand("Book a call", &tokens), "Book a call LINK");
        assert_eq!(expand("Book [SNIPPET_1]", &tokens), "Book LINK");
    }

    #[test]
    fn repeated_triggers_get_separate_tokens() {
        let snippets = vec![s("sig", "— A")];
        let p = protect("sig and sig", &snippets);
        assert_eq!(p.tokens.len(), 2);
        assert_eq!(expand(&p.text, &p.tokens), "— A and — A");
    }
}
