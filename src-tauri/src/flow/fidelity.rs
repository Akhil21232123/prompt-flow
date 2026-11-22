//! The fidelity guard: deterministic checks that a rewrite didn't invent
//! facts. In the first live test a small model added "99% accurate", "10%",
//! "95%+" and "1-2 pages" to a prompt the user never said; this catches that
//! class of error without trusting another model. Mirrors
//! `backend/supabase/functions/_shared/fidelity.ts`.
//!
//! Checked: numbers (incl. percentages), URLs, emails, @handles and file
//! names. Every one in the output must be traceable to the source (the
//! transcript plus trusted context such as the dictionary and selection).

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::BTreeSet;

fn small(w: &str) -> Option<u64> {
    Some(match w {
        "zero" | "oh" => 0,
        "one" => 1,
        "two" => 2,
        "three" => 3,
        "four" => 4,
        "five" => 5,
        "six" => 6,
        "seven" => 7,
        "eight" => 8,
        "nine" => 9,
        "ten" => 10,
        "eleven" => 11,
        "twelve" => 12,
        "thirteen" => 13,
        "fourteen" => 14,
        "fifteen" => 15,
        "sixteen" => 16,
        "seventeen" => 17,
        "eighteen" => 18,
        "nineteen" => 19,
        "twenty" => 20,
        "thirty" => 30,
        "forty" => 40,
        "fifty" => 50,
        "sixty" => 60,
        "seventy" => 70,
        "eighty" => 80,
        "ninety" => 90,
        _ => return None,
    })
}

fn ordinal(w: &str) -> Option<u64> {
    Some(match w {
        "first" => 1,
        "second" => 2,
        "third" => 3,
        "fourth" => 4,
        "fifth" => 5,
        "sixth" => 6,
        "seventh" => 7,
        "eighth" => 8,
        "ninth" => 9,
        "tenth" => 10,
        _ => return None,
    })
}

fn scale(w: &str) -> Option<u64> {
    Some(match w {
        "hundred" => 100,
        "thousand" => 1_000,
        "lakh" => 100_000,
        "million" => 1_000_000,
        "crore" => 10_000_000,
        "billion" => 1_000_000_000,
        _ => return None,
    })
}

fn also(w: &str) -> &'static [&'static str] {
    match w {
        "half" => &["0.5", "50"],
        "quarter" => &["0.25", "25"],
        "couple" | "pair" | "double" | "twice" => &["2"],
        "dozen" => &["12"],
        "triple" => &["3"],
        "single" | "once" => &["1"],
        _ => &[],
    }
}

/// Canonical form of a digit string: "1,500" → "1500", "2.50" → "2.5".
fn normalize_number(raw: &str) -> Option<String> {
    let n: f64 = raw.replace(',', "").parse().ok()?;
    if !n.is_finite() {
        return None;
    }
    Some(if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    })
}

static DIGITS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\d[\d,]*(?:\.\d+)?").unwrap());
static NON_WORD: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^a-z\s|-]").unwrap());
static CLAUSE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[.,;:!?]+(\s|$)").unwrap());

/// Every number a transcript mentions, in digits or words.
pub fn spoken_numbers(text: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for m in DIGITS.find_iter(text) {
        if let Some(n) = normalize_number(m.as_str()) {
            out.insert(n);
        }
        for part in m.as_str().split(['.', ',']) {
            if let Some(p) = normalize_number(part) {
                out.insert(p);
            }
        }
    }

    // Punctuation ends a spoken number: "fifteen hundred, two thousand".
    let lower = NON_WORD
        .replace_all(&CLAUSE.replace_all(&text.to_lowercase(), " | "), " ")
        .into_owned();
    let (mut current, mut total, mut in_number) = (0u64, 0u64, false);
    let flush =
        |current: &mut u64, total: &mut u64, in_number: &mut bool, out: &mut BTreeSet<String>| {
            if *in_number {
                out.insert((*total + *current).to_string());
            }
            *current = 0;
            *total = 0;
            *in_number = false;
        };
    for w in lower
        .split(|c: char| c.is_whitespace() || c == '-')
        .filter(|w| !w.is_empty())
    {
        if let Some(v) = small(w) {
            out.insert(v.to_string());
            // "thirty five" is one number, "five thirty" is two.
            if in_number && current % 10 == 0 && current >= 20 && v < 10 {
                current += v;
            } else if in_number && current > 0 && current < 100 {
                flush(&mut current, &mut total, &mut in_number, &mut out);
                current = v;
            } else {
                current += v;
            }
            in_number = true;
        } else if let (Some(s), true) = (scale(w), in_number) {
            if s == 100 {
                current = current.max(1) * 100;
            } else {
                total += current.max(1) * s;
                current = 0;
            }
        } else if w == "and" && in_number {
            continue;
        } else {
            flush(&mut current, &mut total, &mut in_number, &mut out);
            if let Some(o) = ordinal(w) {
                out.insert(o.to_string());
            }
            for v in also(w) {
                out.insert((*v).to_string());
            }
        }
    }
    flush(&mut current, &mut total, &mut in_number, &mut out);
    out
}

static LIST_MARKER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^(\s*)\d+[.)](\s)").unwrap());
static URL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?i)\bhttps?://[^\s<>()"']+|\bwww\.[^\s<>()"']+"#).unwrap());
static EMAIL: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+").unwrap());
static HANDLE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(^|[^\w@])@([A-Za-z][\w.-]+)").unwrap());
static FILE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b[\w-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|swift|rb|php|css|html|json|yaml|yml|toml|md|sql|sh|c|cpp|h)\b").unwrap()
});
static SNIPPET_TOKEN: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[\[SNIPPET_\d+\]\]").unwrap());

#[derive(Debug, Default, PartialEq)]
pub struct Facts {
    pub numbers: Vec<String>,
    pub urls: Vec<String>,
    pub emails: Vec<String>,
    pub handles: Vec<String>,
    pub files: Vec<String>,
}

pub fn extract_facts(text: &str) -> Facts {
    // List markers ("1.", "2)") at line starts are formatting, not facts.
    let body = LIST_MARKER.replace_all(text, "$1$2").into_owned();
    let emails = EMAIL
        .find_iter(&body)
        .map(|m| m.as_str().to_lowercase())
        .collect();
    let urls = URL
        .find_iter(&body)
        .map(|m| {
            m.as_str()
                .trim_end_matches(['.', ',', ';', ':', '!', '?'])
                .to_lowercase()
        })
        .collect();
    let no_links = EMAIL
        .replace_all(&URL.replace_all(&body, " "), " ")
        .into_owned();
    let handles = HANDLE
        .captures_iter(&no_links)
        .map(|c| c[2].trim_end_matches('.').to_lowercase())
        .collect();
    let files = FILE
        .find_iter(&no_links)
        .map(|m| m.as_str().to_lowercase())
        .collect();
    let numbers = DIGITS
        .find_iter(&FILE.replace_all(&no_links, " "))
        .filter_map(|m| normalize_number(m.as_str()))
        .collect();
    Facts {
        numbers,
        urls,
        emails,
        handles,
        files,
    }
}

fn squash(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Facts in `output` that can't be traced to `source`. Empty means the
/// rewrite is safe to paste.
pub fn find_inventions(source: &str, output: &str) -> Vec<String> {
    // Snippet tokens stand for the user's own saved text.
    let output = SNIPPET_TOKEN.replace_all(output, " ");
    let allowed = spoken_numbers(source);
    let src = squash(source);
    let src_lower = source.to_lowercase();
    let facts = extract_facts(&output);
    let mut problems = Vec::new();
    let uniq = |v: Vec<String>| v.into_iter().collect::<BTreeSet<_>>();

    for n in uniq(facts.numbers) {
        if allowed.contains(&n) {
            continue;
        }
        // "2026" spoken as "twenty twenty six"
        if n.len() == 4 && n.bytes().all(|b| b.is_ascii_digit()) {
            let tail = n[2..].parse::<u64>().unwrap_or(0).to_string();
            if allowed.contains(&n[..2]) && allowed.contains(&tail) {
                continue;
            }
        }
        // "1,500" spoken as "fifteen hundred"
        if let Ok(v) = n.parse::<u64>() {
            if v > 0 && v % 100 == 0 && allowed.contains(&(v / 100).to_string()) {
                continue;
            }
        }
        problems.push(format!("number {n}"));
    }
    // Spoken links come out as words ("john at gmail dot com").
    for e in uniq(facts.emails) {
        let at = e.replacen('@', "at", 1);
        let spoken = [squash(&e), squash(&at), squash(&at.replace('.', "dot"))];
        if !spoken.iter().any(|v| src.contains(v.as_str())) {
            problems.push(format!("email {e}"));
        }
    }
    for u in uniq(facts.urls) {
        let core = u
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_start_matches("www.");
        if !src.contains(&squash(core)) && !src.contains(&squash(&core.replace('.', "dot"))) {
            problems.push(format!("link {u}"));
        }
    }
    for h in uniq(facts.handles) {
        if !src_lower.contains(&h) && !src.contains(&squash(&h)) {
            problems.push(format!("mention @{h}"));
        }
    }
    for f in uniq(facts.files) {
        let stem = f.rsplit_once('.').map_or(f.as_str(), |(s, _)| s);
        if !src.contains(&squash(&f))
            && !src.contains(&squash(&f.replacen('.', "dot", 1)))
            && !src.contains(&squash(stem))
        {
            problems.push(format!("file {f}"));
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catches_the_numbers_llama_invented() {
        let said = "write a report on how accurate the app is compared to wispr flow \
                    and how we can make it better keep it short";
        let out = "Write a report showing PromptFlow is 99% accurate, beats Wispr Flow by \
                   10%, reaches 95%+ quality, and fits in 1-2 pages.";
        assert_eq!(
            find_inventions(said, out),
            vec![
                "number 1",
                "number 10",
                "number 2",
                "number 95",
                "number 99"
            ]
        );
    }

    #[test]
    fn accepts_numbers_said_in_words() {
        let said = "meet at five thirty with twenty five people, budget fifteen hundred, \
                    two thousand twenty six plan, first draft, two lakh rupees, half done";
        let out = "Meet at 5:30 with 25 people. Budget: 1,500. 2026 plan, 1st draft, \
                   ₹2,00,000, 50% done.";
        assert!(
            find_inventions(said, out).is_empty(),
            "{:?}",
            find_inventions(said, out)
        );
    }

    #[test]
    fn list_markers_and_snippets_are_not_facts() {
        let said = "buy milk eggs and bread then send [[SNIPPET_0]]";
        let out = "1. Buy milk\n2. Eggs\n3. Bread\n\nThen send [[SNIPPET_0]]";
        assert!(find_inventions(said, out).is_empty());
    }

    #[test]
    fn spoken_links_emails_and_files() {
        let said = "email john at gmail dot com about the auth dot ts file and promptflow dot app";
        let ok = "Email john@gmail.com about auth.ts and https://promptflow.app.";
        assert!(
            find_inventions(said, ok).is_empty(),
            "{:?}",
            find_inventions(said, ok)
        );
        let bad = "Email jane@yahoo.com, ping @sam, see login.py and https://evil.example";
        assert_eq!(
            find_inventions(said, bad),
            vec![
                "email jane@yahoo.com",
                "link https://evil.example",
                "mention @sam",
                "file login.py"
            ]
        );
    }
}
