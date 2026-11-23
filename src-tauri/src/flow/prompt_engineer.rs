//! Prompt Engineer: turns a rambling spoken request into the prompt most
//! likely to get the best result from the AI it is meant for.
//!
//! Pipeline (the "reprompting" loop):
//! 1. **Architect** — one call rewrites the dictation into a structured prompt
//!    for a detected target (coding agent, chat, research, writing, image,
//!    data), following the current Anthropic and OpenAI prompting guides.
//! 2. **Critic** — a separate call with fresh instructions scores the draft
//!    against a rubric (fidelity to what was said, clarity, completeness,
//!    context, proportion) and returns a revised prompt.
//! 3. In Max quality the critic runs again on its own revision until it
//!    scores at least `min_score` or `max_rounds` is reached.
//!
//! The LLM sits behind [`LlmBackend`] so the loop is unit-tested with a fake.

use super::app_context::AppContext;
use super::settings::{
    AppCategory, EngineerQuality, MissingInfoPolicy, PromptEngineerSettings, PromptFormat,
    PromptTarget,
};
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One system+user completion. Returns the model's text.
pub trait LlmBackend: Send + Sync {
    fn complete<'a>(
        &'a self,
        system: &'a str,
        user: String,
    ) -> BoxFuture<'a, Result<String, String>>;
}

pub struct EngineerRequest<'a> {
    pub transcript: &'a str,
    pub app: Option<&'a AppContext>,
    pub category: AppCategory,
    pub settings: &'a PromptEngineerSettings,
    pub dictionary: &'a [String],
    pub has_snippet_tokens: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EngineerOutcome {
    pub prompt: String,
    pub target: PromptTarget,
    /// Critique rounds that ran.
    pub rounds: u8,
    /// The last critic score, if a critic ran.
    pub score: Option<u8>,
    /// Issues the critic raised in each round.
    pub issues: Vec<String>,
}

impl EngineerOutcome {
    /// Short label stored in history next to the result.
    /// What History shows for the prompt, in plain words.
    pub fn summary(&self) -> String {
        let target = match self.target {
            PromptTarget::Auto => return "Prompt".to_string(),
            PromptTarget::CodingAgent => "a coding agent",
            PromptTarget::ChatAssistant => "a chat assistant",
            PromptTarget::Research => "research",
            PromptTarget::Writing => "writing",
            PromptTarget::ImageGeneration => "an image generator",
            PromptTarget::DataAnalysis => "data analysis",
        };
        format!("Prompt · for {target}")
    }
}

const CALL_TIMEOUT: Duration = Duration::from_secs(30);

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const ARCHITECT_SYSTEM: &str = "\
You are an expert prompt engineer. The user dictated a request by voice: rough, out of order, with filler, repetition and self-corrections. Rewrite it into the prompt that will get the best possible result from the AI it is meant for. The user sends your prompt as their own message, so write it in their voice (\"I\", \"my\"), addressed to the AI (\"you\").

How to rewrite:
1. Fidelity comes first. Keep every concrete detail the speaker gave: names, files, numbers, tools, versions, constraints, examples, preferences and anything they said not to do. Resolve self-corrections to their final intent. Never invent facts, requirements, file names or data they did not give.
2. Lead with the task as a direct instruction (\"Build...\", \"Fix...\", \"Write...\", \"Find...\"), not a question about whether the AI could help.
3. Include the context behind the task (who it is for, what it is for, what has been tried, what good looks like) only from what the speaker said in this dictation, the screen text, or a known fact that is plainly about this request. Never describe who the speaker is (role, job, company) unless they said it here. The app they are typing into is where the prompt will be sent, not what the request is about: never mention it, its window or its identifiers unless the request is about that app.
4. Make expectations explicit when the speaker clearly implied them, such as wanting complete working code rather than a sketch, or wanting sources.
5. Specify the deliverable: format, structure, length and what it must include.
6. Add success criteria only when they give the AI a check that the requirements don't already state; never restate a requirement as a criterion. Never repeat a point in two places.
7. Missing information: {missing_info} Never fill a gap with an assumption of your own (\"assume a JSON format\"), and never add constraints, rules or warnings the speaker did not ask for.
8. Match the length to the request. A one-line ask becomes a few sharp lines, not a page. Leave out generic filler that would not change the result (\"be thorough\", \"think step by step\", \"you are a world-class expert\"). Add a one-line role only when it brings real domain expertise.
9. Phrase instructions as what to do. Keep the speaker's own \"don't\"s.
10. Write calm, plain instructions: no ALL CAPS, no \"CRITICAL\" or \"MUST\", no threats or rewards.
11. Write the prompt in the language the speaker used.
{snippets}
Playbook by target:
- coding_agent: State the goal and the user-visible behaviour wanted. Name the files, functions, stack and commands mentioned. Tell the agent to read the relevant code before changing it, keep changes focused on this request, follow the project's existing conventions, and avoid unrelated refactors. For a bug, give observed vs expected behaviour and any error text or repro steps given. Ask it to verify the change (run or add tests, or say how to check) and to finish with a short summary of what changed.
- chat_assistant: State the question precisely, who the answer is for and how deep to go. Ask for the direct answer first, then the supporting detail.
- research: State the research question, scope (time range, region, domain) and source preferences. Ask it to verify claims across several independent sources, cite every source, separate established facts from estimates, flag disagreements, and structure the output (summary first, then findings, then sources).
- writing: State the piece, audience, purpose, tone, length and structure, and the points it must include. Ask for one strong, finished draft unless the speaker asked for options.
- image_generation: Write one vivid descriptive paragraph, with no headings or markup: subject, setting, composition and camera angle, style or medium, lighting, colour palette, mood, and aspect ratio if given. Put any text that must appear in the image in quotes.
- data_analysis: State the data source, the questions to answer, the method or checks wanted, and the output (tables, charts, numbers). Ask it to state assumptions and sanity-check results.

Format: {format}

Reply in exactly this shape, with nothing outside the tags:
<target>coding_agent | chat_assistant | research | writing | image_generation | data_analysis</target>
<prompt>
the finished prompt
</prompt>";

const CRITIC_SYSTEM: &str = "\
You are a demanding reviewer of prompts written for AI models. You get a user's original spoken request and a prompt written from it for a given target. Judge how well the prompt would get the best result from that AI, then fix every problem you find.

Rubric:
- Fidelity: every detail, constraint and preference in the spoken request is in the prompt, self-corrections are resolved to the final intent, and nothing is invented: no role or background the speaker didn't give, no assumptions, no extra rules, no mention of the app the prompt is typed into. Remove anything invented. Any fidelity failure caps the score at 5.
- No repetition: each point appears once; criteria don't restate requirements.
- Clarity: the task is one direct, unambiguous instruction a capable stranger could act on.
- Completeness: the deliverable, its format and the success criteria are specified, and the essentials for this target are covered.
- Context: the purpose, audience and background the speaker gave are included.
- Proportion: the length fits the request, with no generic filler, fake expertise or padding.
- Missing information is handled as the policy says: {missing_info}
- The prompt is in the speaker's voice and language, ready to send.
{snippets}
Give one overall score from 1 to 10, where 10 means you would not change a word. Then write the improved prompt. If it already scores 10, return it unchanged. Keep the same format conventions: {format}

Reply in exactly this shape, with nothing outside the tags:
<score>N</score>
<issues>
- one short line per issue, or \"- none\"
</issues>
<prompt>
the improved prompt
</prompt>";

fn missing_info_text(policy: MissingInfoPolicy) -> &'static str {
    match policy {
        MissingInfoPolicy::StateAssumptions => {
            "where something the AI needs was not said, tell it to make a sensible assumption, state it briefly, and proceed. Do not fill gaps yourself."
        }
        MissingInfoPolicy::AskFirst => {
            "where something important was not said, tell the AI to ask the user specific clarifying questions before starting. Do not fill gaps yourself."
        }
    }
}

const SNIPPET_RULE: &str = "Tokens like [[SNIPPET_1]] stand for text the user saved (links, addresses). Keep each token exactly as written.\n";

/// The markup the prompt should use.
pub fn resolve_format(
    setting: PromptFormat,
    app: Option<&AppContext>,
    category: AppCategory,
) -> PromptFormat {
    if setting != PromptFormat::Auto {
        return setting;
    }
    let claude_like = app.is_some_and(|a| {
        let hay = format!(
            "{} {} {}",
            a.app_name.as_deref().unwrap_or_default(),
            a.bundle_id.as_deref().unwrap_or_default(),
            a.window_title.as_deref().unwrap_or_default()
        )
        .to_ascii_lowercase();
        hay.contains("claude") || hay.contains("anthropic")
    });
    if claude_like || matches!(category, AppCategory::Code | AppCategory::Terminal) {
        PromptFormat::Xml
    } else {
        PromptFormat::Markdown
    }
}

fn format_text(format: PromptFormat) -> &'static str {
    match format {
        PromptFormat::Xml | PromptFormat::Auto => {
            "Open with the task in plain sentences. Put supporting material in descriptive XML tags such as <context>, <requirements>, <constraints>, <output_format> and <success_criteria>, using only the sections this request needs. For image_generation, ignore this and write plain prose."
        }
        PromptFormat::Markdown => {
            "Open with the task in plain sentences. Then use short Markdown sections (bold labels or ### headings, with bullets) such as Context, Requirements, Output and Done when, using only the sections this request needs. For image_generation, ignore this and write plain prose."
        }
        PromptFormat::Plain => "Plain prose paragraphs and simple numbered lists; no Markdown or XML.",
    }
}

fn fill(
    template: &str,
    missing_info: MissingInfoPolicy,
    format: PromptFormat,
    snippets: bool,
) -> String {
    template
        .replace("{missing_info}", missing_info_text(missing_info))
        .replace("{format}", format_text(format))
        .replace("{snippets}", if snippets { SNIPPET_RULE } else { "" })
}

fn category_label(category: AppCategory) -> &'static str {
    match category {
        AppCategory::Email => "email app",
        AppCategory::WorkChat => "work chat",
        AppCategory::PersonalChat => "personal chat",
        AppCategory::Code => "code editor (the prompt is probably for its AI agent)",
        AppCategory::Terminal => "terminal (the prompt is probably for a command-line coding agent such as Claude Code or Codex)",
        AppCategory::AiChat => "AI chat assistant",
        AppCategory::Docs => "documents or notes app",
        AppCategory::Other => "unknown",
    }
}

fn target_instruction(req: &EngineerRequest) -> String {
    match req.settings.target {
        PromptTarget::Auto => match req.category {
            AppCategory::Code | AppCategory::Terminal => {
                "Choose the target from the request; it is most likely coding_agent.".into()
            }
            _ => "Choose the target that fits the request best.".into(),
        },
        fixed => format!("The target is {}.", fixed.as_str()),
    }
}

pub fn build_architect_user(req: &EngineerRequest) -> String {
    let mut ctx = Vec::new();
    if let Some(app) = req.app {
        ctx.push(format!("App in front: {}", app.describe()));
    }
    ctx.push(format!("Kind of app: {}", category_label(req.category)));
    ctx.push(target_instruction(req));
    let custom = req.settings.custom_instructions.trim();
    if !custom.is_empty() {
        ctx.push(format!(
            "Standing context from the user (include it only where relevant): {custom}"
        ));
    }
    let words: Vec<&str> = req
        .dictionary
        .iter()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty())
        .collect();
    if !words.is_empty() {
        ctx.push(format!(
            "Correct spellings of names and terms the user uses (fix misheard words to these): {}",
            words.join(", ")
        ));
    }
    format!(
        "<request_context>\n{}\n</request_context>\n\n<dictation>\n{}\n</dictation>",
        ctx.join("\n"),
        req.transcript.trim()
    )
}

pub fn build_critic_user(transcript: &str, target: PromptTarget, draft: &str) -> String {
    format!(
        "<target>{}</target>\n\n<spoken_request>\n{}\n</spoken_request>\n\n<prompt_to_review>\n{}\n</prompt_to_review>",
        target.as_str(),
        transcript.trim(),
        draft.trim()
    )
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Drop `<think>...</think>` blocks some reasoning models emit.
pub fn strip_think(text: &str) -> String {
    let mut out = text.to_string();
    while let Some(start) = out.find("<think>") {
        match out[start..].find("</think>") {
            Some(end) => out.replace_range(start..start + end + "</think>".len(), ""),
            None => {
                out.truncate(start);
                break;
            }
        }
    }
    out
}

/// Content of the last `<tag>...</tag>`; a missing close tag runs to the end.
pub fn extract_tag(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.rfind(&open)? + open.len();
    let rest = &text[start..];
    let body = match rest.find(&close) {
        Some(end) => &rest[..end],
        None => rest,
    };
    let body = body.trim();
    (!body.is_empty()).then(|| body.to_string())
}

fn strip_fences(text: &str) -> String {
    let t = text.trim();
    if let Some(inner) = t.strip_prefix("```") {
        let inner = inner.split_once('\n').map(|(_, rest)| rest).unwrap_or("");
        return inner.trim_end().trim_end_matches("```").trim().to_string();
    }
    t.to_string()
}

/// The prompt from a reply, tolerating models that skip the tags.
pub fn parse_prompt(reply: &str) -> Option<String> {
    let reply = strip_think(reply);
    if let Some(p) = extract_tag(&reply, "prompt") {
        return Some(strip_fences(&p));
    }
    let has_tags = ["<target>", "<score>", "<issues>"]
        .iter()
        .any(|t| reply.contains(t));
    let bare = strip_fences(&reply);
    (!has_tags && !bare.is_empty()).then_some(bare)
}

pub fn parse_score(reply: &str) -> Option<u8> {
    let raw = extract_tag(&strip_think(reply), "score")?;
    let digits: String = raw.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u8>().ok().map(|s| s.clamp(1, 10))
}

pub fn parse_issues(reply: &str) -> Vec<String> {
    extract_tag(&strip_think(reply), "issues")
        .map(|body| {
            body.lines()
                .map(|l| {
                    l.trim()
                        .trim_start_matches(['-', '*', '•'])
                        .trim()
                        .to_string()
                })
                .filter(|l| !l.is_empty() && !l.eq_ignore_ascii_case("none"))
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

async fn call(llm: &dyn LlmBackend, system: &str, user: String) -> Result<String, String> {
    match tokio::time::timeout(CALL_TIMEOUT, llm.complete(system, user)).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "LLM call timed out after {}s",
            CALL_TIMEOUT.as_secs()
        )),
    }
}

fn critique_rounds(settings: &PromptEngineerSettings) -> u8 {
    match settings.quality {
        EngineerQuality::Fast => 0,
        EngineerQuality::Balanced => 1,
        EngineerQuality::Max => settings.max_rounds.clamp(1, 5),
    }
}

/// Engineer a prompt. Fails only if the first draft fails; a failing critic
/// round keeps the best prompt so far.
pub async fn engineer(
    llm: &dyn LlmBackend,
    req: &EngineerRequest<'_>,
) -> Result<EngineerOutcome, String> {
    if req.transcript.trim().is_empty() {
        return Err("empty dictation".into());
    }
    let s = req.settings;
    let format = resolve_format(s.format, req.app, req.category);
    let architect = fill(
        ARCHITECT_SYSTEM,
        s.missing_info,
        format,
        req.has_snippet_tokens,
    );
    let critic = fill(
        CRITIC_SYSTEM,
        s.missing_info,
        format,
        req.has_snippet_tokens,
    );

    let reply = call(llm, &architect, build_architect_user(req)).await?;
    let mut prompt = parse_prompt(&reply).ok_or("the model returned no prompt")?;
    let target = match s.target {
        PromptTarget::Auto => extract_tag(&strip_think(&reply), "target")
            .and_then(|t| PromptTarget::parse(&t))
            .filter(|t| *t != PromptTarget::Auto)
            .unwrap_or(match req.category {
                AppCategory::Code | AppCategory::Terminal => PromptTarget::CodingAgent,
                _ => PromptTarget::ChatAssistant,
            }),
        fixed => fixed,
    };

    let mut outcome = EngineerOutcome {
        prompt: String::new(),
        target,
        rounds: 0,
        score: None,
        issues: Vec::new(),
    };
    let min_score = s.min_score.clamp(1, 10);
    for _ in 0..critique_rounds(s) {
        let review = match call(
            llm,
            &critic,
            build_critic_user(req.transcript, target, &prompt),
        )
        .await
        {
            Ok(r) => r,
            Err(e) => {
                log::warn!("Prompt critique failed, keeping the current prompt: {e}");
                break;
            }
        };
        outcome.rounds += 1;
        let score = parse_score(&review);
        outcome.issues.extend(parse_issues(&review));
        if let Some(revised) = parse_prompt(&review) {
            prompt = revised;
        }
        outcome.score = score;
        if score.is_some_and(|sc| sc >= min_score) {
            break;
        }
    }
    outcome.prompt = prompt;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Replays canned replies and records every call.
    struct Fake {
        replies: Mutex<Vec<Result<String, String>>>,
        calls: Mutex<Vec<(String, String)>>,
    }

    impl Fake {
        fn new(replies: Vec<Result<&str, &str>>) -> Self {
            Self {
                replies: Mutex::new(
                    replies
                        .into_iter()
                        .rev()
                        .map(|r| r.map(str::to_string).map_err(str::to_string))
                        .collect(),
                ),
                calls: Mutex::new(Vec::new()),
            }
        }
        fn calls(&self) -> Vec<(String, String)> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl LlmBackend for Fake {
        fn complete<'a>(
            &'a self,
            system: &'a str,
            user: String,
        ) -> BoxFuture<'a, Result<String, String>> {
            self.calls.lock().unwrap().push((system.to_string(), user));
            let next = self
                .replies
                .lock()
                .unwrap()
                .pop()
                .unwrap_or(Err("no more replies".into()));
            Box::pin(async move { next })
        }
    }

    fn settings(quality: EngineerQuality) -> PromptEngineerSettings {
        PromptEngineerSettings {
            quality,
            ..Default::default()
        }
    }

    fn request<'a>(
        s: &'a PromptEngineerSettings,
        app: Option<&'a AppContext>,
        category: AppCategory,
    ) -> EngineerRequest<'a> {
        EngineerRequest {
            transcript: "um so fix the login bug in auth dot ts, it crashes when the email is empty, actually when the password is empty",
            app,
            category,
            settings: s,
            dictionary: &[],
            has_snippet_tokens: false,
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
    }

    #[test]
    fn fast_mode_makes_one_call() {
        let s = settings(EngineerQuality::Fast);
        let fake = Fake::new(vec![Ok(
            "<target>coding_agent</target>\n<prompt>\nFix the crash in auth.ts.\n</prompt>",
        )]);
        let out = rt()
            .block_on(engineer(&fake, &request(&s, None, AppCategory::Code)))
            .unwrap();
        assert_eq!(out.prompt, "Fix the crash in auth.ts.");
        assert_eq!(out.target, PromptTarget::CodingAgent);
        assert_eq!(out.rounds, 0);
        assert_eq!(fake.calls().len(), 1);
    }

    #[test]
    fn balanced_runs_one_critique_and_uses_revision() {
        let s = settings(EngineerQuality::Balanced);
        let fake = Fake::new(vec![
            Ok("<target>coding_agent</target><prompt>Fix auth.ts</prompt>"),
            Ok("<score>6</score><issues>\n- lost the empty-password detail\n</issues><prompt>Fix the crash in auth.ts when the password is empty.</prompt>"),
        ]);
        let out = rt()
            .block_on(engineer(&fake, &request(&s, None, AppCategory::Code)))
            .unwrap();
        assert_eq!(
            out.prompt,
            "Fix the crash in auth.ts when the password is empty."
        );
        assert_eq!(out.rounds, 1);
        assert_eq!(out.score, Some(6));
        assert_eq!(out.issues, vec!["lost the empty-password detail"]);
        let calls = fake.calls();
        assert!(calls[1].0.contains("demanding reviewer"));
        assert!(calls[1].1.contains("<prompt_to_review>\nFix auth.ts"));
    }

    #[test]
    fn max_mode_stops_at_min_score() {
        let s = settings(EngineerQuality::Max);
        let fake = Fake::new(vec![
            Ok("<target>coding_agent</target><prompt>v1</prompt>"),
            Ok("<score>7</score><issues>- x</issues><prompt>v2</prompt>"),
            Ok("<score>9</score><issues>- none</issues><prompt>v3</prompt>"),
            Ok("<score>10</score><prompt>never reached</prompt>"),
        ]);
        let out = rt()
            .block_on(engineer(&fake, &request(&s, None, AppCategory::Code)))
            .unwrap();
        assert_eq!(out.prompt, "v3");
        assert_eq!(out.rounds, 2);
        assert_eq!(out.score, Some(9));
        assert_eq!(fake.calls().len(), 3);
    }

    #[test]
    fn failed_critique_keeps_draft() {
        let s = settings(EngineerQuality::Balanced);
        let fake = Fake::new(vec![
            Ok("<target>research</target><prompt>draft</prompt>"),
            Err("500"),
        ]);
        let out = rt()
            .block_on(engineer(&fake, &request(&s, None, AppCategory::AiChat)))
            .unwrap();
        assert_eq!(out.prompt, "draft");
        assert_eq!(out.target, PromptTarget::Research);
        assert_eq!(out.rounds, 0);
    }

    #[test]
    fn failed_draft_is_an_error() {
        let s = settings(EngineerQuality::Fast);
        let fake = Fake::new(vec![Err("401 unauthorized")]);
        assert!(rt()
            .block_on(engineer(&fake, &request(&s, None, AppCategory::Other)))
            .is_err());
    }

    #[test]
    fn fixed_target_overrides_model_choice() {
        let mut s = settings(EngineerQuality::Fast);
        s.target = PromptTarget::ImageGeneration;
        let fake = Fake::new(vec![Ok(
            "<target>writing</target><prompt>A red fox at dawn</prompt>",
        )]);
        let out = rt()
            .block_on(engineer(&fake, &request(&s, None, AppCategory::Other)))
            .unwrap();
        assert_eq!(out.target, PromptTarget::ImageGeneration);
        assert!(fake.calls()[0]
            .1
            .contains("The target is image_generation."));
    }

    #[test]
    fn architect_input_carries_context() {
        let mut s = settings(EngineerQuality::Fast);
        s.custom_instructions = "I use pnpm".into();
        let app = AppContext {
            app_name: Some("Cursor".into()),
            bundle_id: Some("com.todesktop.230313mzl4w4u92".into()),
            window_title: Some("auth.ts — shop".into()),
        };
        let dict = vec!["Supabase".to_string()];
        let mut req = request(&s, Some(&app), AppCategory::Code);
        req.dictionary = &dict;
        let user = build_architect_user(&req);
        assert!(user.contains("App in front: Cursor"));
        assert!(user.contains("most likely coding_agent"));
        assert!(user.contains("I use pnpm"));
        assert!(user.contains("Supabase"));
        assert!(user.contains("<dictation>\num so fix"));
    }

    #[test]
    fn system_prompts_are_fully_filled() {
        for (fmt, snippets) in [
            (PromptFormat::Xml, true),
            (PromptFormat::Markdown, false),
            (PromptFormat::Plain, false),
        ] {
            for t in [ARCHITECT_SYSTEM, CRITIC_SYSTEM] {
                let filled = fill(t, MissingInfoPolicy::AskFirst, fmt, snippets);
                assert!(!filled.contains('{'), "unfilled placeholder in:\n{filled}");
                assert_eq!(filled.contains("[[SNIPPET_1]]"), snippets);
            }
        }
    }

    #[test]
    fn format_auto_resolution() {
        let claude = AppContext {
            app_name: Some("Claude".into()),
            bundle_id: Some("com.anthropic.claudefordesktop".into()),
            window_title: None,
        };
        let chatgpt = AppContext {
            app_name: Some("ChatGPT".into()),
            bundle_id: Some("com.openai.chat".into()),
            window_title: None,
        };
        assert_eq!(
            resolve_format(PromptFormat::Auto, Some(&claude), AppCategory::AiChat),
            PromptFormat::Xml
        );
        assert_eq!(
            resolve_format(PromptFormat::Auto, Some(&chatgpt), AppCategory::AiChat),
            PromptFormat::Markdown
        );
        assert_eq!(
            resolve_format(PromptFormat::Auto, None, AppCategory::Terminal),
            PromptFormat::Xml
        );
        assert_eq!(
            resolve_format(PromptFormat::Plain, Some(&claude), AppCategory::AiChat),
            PromptFormat::Plain
        );
    }

    #[test]
    fn parsing_is_tolerant() {
        assert_eq!(
            parse_prompt("<think>hmm <prompt>no</prompt></think><prompt>yes</prompt>").as_deref(),
            Some("yes")
        );
        assert_eq!(
            parse_prompt("```markdown\nJust the prompt\n```").as_deref(),
            Some("Just the prompt")
        );
        assert_eq!(
            parse_prompt("<prompt>\nunterminated").as_deref(),
            Some("unterminated")
        );
        assert_eq!(parse_prompt("<score>9</score>"), None);
        assert_eq!(parse_score("<score> 8/10 </score>"), Some(8));
        assert_eq!(parse_score("<score>42</score>"), Some(10));
        assert_eq!(
            parse_issues("<issues>\n- a\n* b\n- none\n</issues>"),
            vec!["a", "b"]
        );
    }

    #[test]
    fn summary_label() {
        let o = EngineerOutcome {
            prompt: "p".into(),
            target: PromptTarget::Research,
            rounds: 1,
            score: Some(9),
            issues: vec![],
        };
        assert_eq!(o.summary(), "Prompt · for research");
    }
}
