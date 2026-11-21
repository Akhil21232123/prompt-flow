//! Command Mode: select text, hold the Command shortcut and say what to do
//! ("make this more formal", "turn this into bullets", "translate to Hindi").
//! The selection is replaced with the result. With nothing selected, the
//! spoken instruction is treated as a request to write something at the
//! cursor ("write a polite reply declining the meeting").

use super::app_context::AppContext;
use super::prompt_engineer::{strip_think, LlmBackend};
use super::settings::{AppCategory, WritingStyle};

const EDIT_SYSTEM: &str = "\
You edit text by voice command. The user selected some text and spoke an instruction about it. Apply the instruction to the selected text and return only the resulting text; it is pasted over their selection.

- Change only what the instruction asks for. Keep the rest: meaning, facts, names, numbers, links, formatting conventions and language (unless they ask to translate).
- If the instruction is ambiguous, choose the most common interpretation.
- The instruction was spoken, so it may contain filler or self-corrections; follow its final intent.
- Return the edited text only: no preamble, no quotes around it, no explanation, no Markdown code fences unless the selected text was code in fences.";

const WRITE_SYSTEM: &str = "\
The user spoke an instruction for text to write at their cursor, for example \"write a polite reply declining the meeting\" or \"draft a tweet announcing our launch\". Write that text in the user's own voice, ready to paste as is.

- Follow every detail they gave. Do not invent facts, names, dates or numbers; leave a short [placeholder] where something essential is missing.
- Keep it as long as the request needs and no longer.
- Return only the text to paste: no preamble, no explanation, no surrounding quotes.";

fn destination(category: AppCategory, style: WritingStyle) -> String {
    let place = match category {
        AppCategory::Email => "an email",
        AppCategory::WorkChat => "a work chat message",
        AppCategory::PersonalChat => "a personal chat message",
        AppCategory::Code => "a code editor",
        AppCategory::Terminal => "a terminal",
        AppCategory::AiChat => "a message to an AI assistant",
        AppCategory::Docs => "a document",
        AppCategory::Other => "a text field",
    };
    let tone = match style {
        WritingStyle::Formal => "formal",
        WritingStyle::Casual => "casual",
        WritingStyle::VeryCasual => "very casual (lowercase, minimal punctuation)",
    };
    format!("Destination: {place}. Default tone unless the instruction says otherwise: {tone}.")
}

pub fn build_user(
    instruction: &str,
    selection: Option<&str>,
    app: Option<&AppContext>,
    category: AppCategory,
    style: WritingStyle,
) -> String {
    let mut out = String::new();
    if let Some(app) = app {
        out.push_str(&format!("App in front: {}\n", app.describe()));
    }
    out.push_str(&destination(category, style));
    out.push_str(&format!(
        "\n\n<instruction>\n{}\n</instruction>",
        instruction.trim()
    ));
    if let Some(sel) = selection {
        out.push_str(&format!("\n\n<selected_text>\n{sel}\n</selected_text>"));
    }
    out
}

/// Clean a model reply for pasting.
pub fn clean_reply(reply: &str) -> String {
    let t = strip_think(reply);
    let t = t.trim();
    let t = t
        .strip_prefix("<selected_text>")
        .and_then(|r| r.strip_suffix("</selected_text>"))
        .unwrap_or(t)
        .trim();
    // Quotes the model wrapped around the whole reply.
    let t = if t.len() >= 2
        && ((t.starts_with('"') && t.ends_with('"')) || (t.starts_with('“') && t.ends_with('”')))
        && !t[1..t.len() - 1].contains(['"', '“', '”'])
    {
        &t[t.chars().next().unwrap().len_utf8()..t.len() - t.chars().last().unwrap().len_utf8()]
    } else {
        t
    };
    t.to_string()
}

pub async fn run(
    llm: &dyn LlmBackend,
    instruction: &str,
    selection: Option<&str>,
    app: Option<&AppContext>,
    category: AppCategory,
    style: WritingStyle,
) -> Result<String, String> {
    if instruction.trim().is_empty() {
        return Err("no instruction was heard".into());
    }
    let selection = selection.filter(|s| !s.trim().is_empty());
    let system = if selection.is_some() {
        EDIT_SYSTEM
    } else {
        WRITE_SYSTEM
    };
    let reply = llm
        .complete(
            system,
            build_user(instruction, selection, app, category, style),
        )
        .await?;
    let text = clean_reply(&reply);
    if text.is_empty() {
        return Err("the model returned nothing".into());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flow::prompt_engineer::BoxFuture;
    use std::sync::Mutex;

    struct Echo(Mutex<Vec<String>>, &'static str);
    impl LlmBackend for Echo {
        fn complete<'a>(
            &'a self,
            system: &'a str,
            user: String,
        ) -> BoxFuture<'a, Result<String, String>> {
            self.0
                .lock()
                .unwrap()
                .push(format!("{system}\n---\n{user}"));
            let reply = self.1.to_string();
            Box::pin(async move { Ok(reply) })
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
    }

    #[test]
    fn edit_uses_selection() {
        let llm = Echo(Mutex::new(vec![]), "\"Thanks for your patience.\"");
        let out = rt()
            .block_on(run(
                &llm,
                "make it formal",
                Some("thx for waiting"),
                None,
                AppCategory::Email,
                WritingStyle::Formal,
            ))
            .unwrap();
        assert_eq!(out, "Thanks for your patience.");
        let call = llm.0.lock().unwrap()[0].clone();
        assert!(call.contains("You edit text by voice command"));
        assert!(call.contains("<selected_text>\nthx for waiting\n</selected_text>"));
        assert!(call.contains("Destination: an email"));
    }

    #[test]
    fn no_selection_writes_new_text() {
        let llm = Echo(Mutex::new(vec![]), "Hi Sam, I can't make it Friday.");
        rt().block_on(run(
            &llm,
            "decline friday",
            Some("  "),
            None,
            AppCategory::Other,
            WritingStyle::Casual,
        ))
        .unwrap();
        assert!(llm.0.lock().unwrap()[0].contains("text to write at their cursor"));
    }

    #[test]
    fn empty_instruction_errors() {
        let llm = Echo(Mutex::new(vec![]), "x");
        assert!(rt()
            .block_on(run(
                &llm,
                " ",
                None,
                None,
                AppCategory::Other,
                WritingStyle::Casual
            ))
            .is_err());
    }

    #[test]
    fn clean_reply_strips_wrappers_but_keeps_inner_quotes() {
        assert_eq!(clean_reply("<think>x</think>\n\"hello\""), "hello");
        assert_eq!(clean_reply("\"a\" and \"b\""), "\"a\" and \"b\"");
        assert_eq!(clean_reply("<selected_text>done</selected_text>"), "done");
    }
}
