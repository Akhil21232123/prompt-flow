//! One cloud recording from the moment the key is released to the paste,
//! plus everything the island's buttons do afterwards: answering a question,
//! undo, copy, Autopilot's check and its fix.

use super::api::{ApiError, ErrorCode};
use super::context::{self, Captured};
use super::dictate::{
    self, ClarifyAnswer, CloudMode, DictateOutcome, Finished, MetaApp, MetaInput, MetaScreen,
    ScreenSource,
};
use crate::flow::app_context::AppContext;
use crate::flow::FlowMode;
use crate::island::{self, IslandContext, IslandError, IslandMode, IslandStep, IslandView};
use crate::managers::history::HistoryManager;
use crate::settings::get_settings;
use crate::tray::{set_tray_state, TrayIconState};
use once_cell::sync::Lazy;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// A question from the server, waiting for an answer.
#[derive(Clone)]
struct PendingAsk {
    session: String,
    created: Instant,
    /// The view showing it.
    island_id: u64,
    /// Sent again with the answer, so the prompt is still for the same app.
    input: MetaInput,
    target: Option<String>,
    /// A recording started to answer it by voice.
    answering: bool,
}

/// What the island's Undo and Copy act on.
#[derive(Clone)]
struct LastResult {
    island_id: u64,
    text: String,
}

/// The last prompt PromptFlow wrote, for Autopilot to check answers against.
#[derive(Clone)]
struct LastPrompt {
    text: String,
    app: Option<String>,
}

/// Autopilot's follow-up, waiting for "Send fix".
#[derive(Clone)]
struct PendingFix {
    island_id: u64,
    text: String,
}

static PENDING_ASK: Lazy<Mutex<Option<PendingAsk>>> = Lazy::new(|| Mutex::new(None));
static LAST_RESULT: Lazy<Mutex<Option<LastResult>>> = Lazy::new(|| Mutex::new(None));
static LAST_PROMPT: Lazy<Mutex<Option<LastPrompt>>> = Lazy::new(|| Mutex::new(None));
static PENDING_FIX: Lazy<Mutex<Option<PendingFix>>> = Lazy::new(|| Mutex::new(None));

/// The server keeps a question for 10 minutes; stop offering it a little before.
const ASK_TTL: Duration = Duration::from_secs(9 * 60 + 30);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn island_mode(mode: FlowMode) -> IslandMode {
    match mode {
        FlowMode::Dictate => IslandMode::Dictate,
        FlowMode::PromptEngineer => IslandMode::Engineer,
        FlowMode::Command => IslandMode::Command,
        FlowMode::This => IslandMode::This,
    }
}

fn cloud_mode(mode: FlowMode) -> CloudMode {
    match mode {
        FlowMode::Dictate => CloudMode::Dictate,
        FlowMode::PromptEngineer | FlowMode::This => CloudMode::Engineer,
        FlowMode::Command => CloudMode::Command,
    }
}

/// The friendly name of an app for "Writing for Claude…".
fn target_name(app: Option<&AppContext>) -> Option<String> {
    app.and_then(|a| a.app_name.clone())
        .filter(|n| !n.trim().is_empty())
}

pub fn island_error(e: &ApiError) -> IslandError {
    match e.code {
        ErrorCode::Auth if crate::cloud::session::is_signed_in() => IslandError::SessionEnded,
        ErrorCode::Auth if e.message.contains("ended") => IslandError::SessionEnded,
        ErrorCode::Auth => IslandError::SignIn,
        ErrorCode::BadRequest => IslandError::BadRequest,
        ErrorCode::Provider => IslandError::Provider,
        ErrorCode::RateLimited => IslandError::RateLimited,
        ErrorCode::Quota => IslandError::Quota,
        ErrorCode::Network => IslandError::Network,
        ErrorCode::Server => IslandError::Server,
    }
}

fn show_api_error(app: &AppHandle, e: &ApiError) {
    log::warn!("PromptFlow request failed: {e}");
    let error = island_error(e);
    // The server's message is written for users; ours for network trouble
    // is too. Codes with their own copy in the island don't need it.
    let message = match error {
        IslandError::BadRequest | IslandError::Provider | IslandError::Server => {
            Some(e.message.clone())
        }
        _ => None,
    };
    island::show(
        app,
        IslandView::Error {
            error,
            message,
            retry_after_sec: e.retry_after_sec,
        },
    );
}

pub fn show_error(app: &AppHandle, error: IslandError) {
    island::show(
        app,
        IslandView::Error {
            error,
            message: None,
            retry_after_sec: None,
        },
    );
}

// ---------------------------------------------------------------------------
// Recording start
// ---------------------------------------------------------------------------

/// Called when a cloud recording starts: decides whether it answers the
/// question on screen, starts reading the screen, and shows the island.
pub fn on_recording_start(app: &AppHandle, mode: FlowMode) {
    let settings = get_settings(app);
    let answering = {
        let mut pending = lock(&PENDING_ASK);
        let (id, view) = island::current();
        let live = pending.as_ref().is_some_and(|p| {
            p.island_id == id
                && matches!(view, IslandView::Ask { .. })
                && p.created.elapsed() < ASK_TTL
        });
        if live {
            if let Some(p) = pending.as_mut() {
                p.answering = true;
            }
        } else {
            *pending = None;
        }
        live
    };
    let island_mode = if answering {
        IslandMode::Engineer
    } else {
        island_mode(mode)
    };
    let language = settings.flow.spoken_language.clone();
    island::set_session(island_mode, &language);
    let view = IslandView::Listening {
        mode: island_mode,
        language: language.clone(),
        answering,
        context: None,
    };
    let listening_id = island::show(app, view);

    let wants_screen = mode == FlowMode::This && !answering;
    let handle = app.clone();
    context::begin_capture(wants_screen, move |screen| {
        // Show "Using: 2,140 chars from Safari" while still listening.
        if island::current_id() != listening_id {
            return;
        }
        let app_name = crate::flow::app_context::peek_name(Duration::from_millis(600));
        island::show(
            &handle,
            IslandView::Listening {
                mode: island_mode,
                language,
                answering,
                context: Some(IslandContext {
                    chars: screen.text.chars().count() as u32,
                    source: screen.source,
                    app: app_name,
                }),
            },
        );
    });
}

// ---------------------------------------------------------------------------
// Recording stop → /dictate → paste
// ---------------------------------------------------------------------------

pub struct Recording {
    pub mode: FlowMode,
    pub samples: Vec<f32>,
    pub app_context: Option<AppContext>,
    /// Copied with ⌘C after the keys came up (Command and "This").
    pub copied_selection: Option<String>,
    pub stop_time: Instant,
}

/// Runs a finished cloud recording. `cancelled` reports a cancel (Esc)
/// since the recording stopped.
pub async fn run_recording<C>(app: &AppHandle, rec: Recording, cancelled: C)
where
    C: Fn() -> bool,
{
    let settings = get_settings(app);
    let sample_count = rec.samples.len();
    let duration =
        sample_count as f64 / crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE as f64;
    let captured: Captured = tokio::task::spawn_blocking(context::take_captured)
        .await
        .unwrap_or_default();

    let pending = {
        let mut p = lock(&PENDING_ASK);
        match p.as_ref() {
            Some(ask) if ask.answering && ask.created.elapsed() < ASK_TTL => p.take(),
            _ => None,
        }
    };

    let mode = if pending.is_some() {
        FlowMode::PromptEngineer
    } else {
        rec.mode
    };
    let target = pending
        .as_ref()
        .and_then(|p| p.target.clone())
        .or_else(|| target_name(rec.app_context.as_ref()));
    let working_id = island::show(
        app,
        IslandView::Working {
            mode: island_mode(mode),
            step: IslandStep::Transcribing,
            target: target.clone(),
        },
    );

    let (input, clarify) = match pending {
        Some(ask) => {
            let mut input = ask.input.clone();
            input.duration_sec = Some(duration);
            (input, Some((ask.session, ClarifyAnswer::Voice)))
        }
        None => (
            meta_input(
                rec.mode,
                duration,
                rec.app_context.as_ref(),
                captured,
                rec.copied_selection,
            ),
            None,
        ),
    };
    let meta = dictate::build_meta(cloud_mode(mode), &settings.flow, input.clone(), clarify);
    let wav = dictate::encode_wav(&rec.samples);

    // History keeps the audio, like the on-device pipeline.
    let hm = Arc::clone(&app.state::<Arc<HistoryManager>>());
    let file_name = format!("handy-{}.wav", chrono::Utc::now().timestamp());
    let wav_path = hm.recordings_dir().join(&file_name);
    let samples = rec.samples;
    let wav_saved = tauri::async_runtime::spawn_blocking(move || {
        crate::audio_toolkit::save_wav_file(&wav_path, &samples).is_ok()
    });

    let result = dictate::send(app, &meta, Some(&wav)).await;
    let wav_saved = wav_saved.await.unwrap_or(false);
    if cancelled() {
        island::hide(app);
        set_tray_state(app, TrayIconState::Idle);
        return;
    }
    let history = wav_saved.then_some((hm, file_name));
    handle_outcome(
        app,
        result,
        HandleContext {
            mode,
            input,
            target,
            working_id,
            history,
            sample_count,
            stop_time: rec.stop_time,
        },
    )
    .await;
}

fn meta_input(
    mode: FlowMode,
    duration: f64,
    app: Option<&AppContext>,
    captured: Captured,
    copied_selection: Option<String>,
) -> MetaInput {
    let Captured { field, screen } = captured;
    let selection = copied_selection
        .clone()
        .or(field.selected.clone())
        .filter(|s| !s.trim().is_empty());
    // "This": a selection beats window text and OCR.
    let screen = match (mode, copied_selection) {
        (FlowMode::This, Some(sel)) if !sel.trim().is_empty() => Some(MetaScreen {
            text: sel,
            source: ScreenSource::Selection,
        }),
        (FlowMode::This, _) => screen,
        _ => None,
    };
    MetaInput {
        duration_sec: Some(duration),
        app: MetaApp {
            name: app.and_then(|a| a.app_name.clone()),
            bundle_id: app.and_then(|a| a.bundle_id.clone()),
            title: app.and_then(|a| a.window_title.clone()),
            surrounding_text: field.before_cursor,
            url: field.url,
        },
        selection,
        screen,
    }
}

struct HandleContext {
    mode: FlowMode,
    input: MetaInput,
    target: Option<String>,
    working_id: u64,
    history: Option<(Arc<HistoryManager>, String)>,
    sample_count: usize,
    stop_time: Instant,
}

async fn handle_outcome(
    app: &AppHandle,
    result: Result<DictateOutcome, ApiError>,
    ctx: HandleContext,
) {
    // A newer session owns the island: report nothing over it.
    let owns_ui = || island::current_id() == ctx.working_id;
    match result {
        Ok(DictateOutcome::Done(finished)) => {
            if let Some((hm, file_name)) = &ctx.history {
                if let Err(e) = hm.save_entry(
                    file_name.clone(),
                    finished.raw.clone(),
                    true,
                    Some(finished.text.clone()),
                    finished.label.clone(),
                    None,
                ) {
                    log::error!("Failed to save history entry: {e}");
                }
            }
            deliver(
                app,
                ctx.mode,
                finished,
                ctx.working_id,
                ctx.sample_count,
                ctx.stop_time,
            )
            .await;
        }
        Ok(DictateOutcome::Dropped { reason }) => {
            log::info!("Nothing to paste ({reason})");
            if owns_ui() {
                show_error(app, IslandError::NothingHeard);
            }
            set_tray_state(app, TrayIconState::Idle);
            crate::actions::emit_transcription_complete(
                app,
                crate::actions::TranscriptionOutcome::Empty,
                ctx.sample_count,
                ctx.stop_time,
            );
        }
        Ok(DictateOutcome::Ask(clarify)) => {
            set_tray_state(app, TrayIconState::Idle);
            if !owns_ui() {
                return;
            }
            let island_id = island::show(
                app,
                IslandView::Ask {
                    question: clarify.question.clone(),
                    options: clarify.options.clone(),
                },
            );
            *lock(&PENDING_ASK) = Some(PendingAsk {
                session: clarify.session,
                created: Instant::now(),
                island_id,
                input: MetaInput {
                    duration_sec: None,
                    ..ctx.input
                },
                target: ctx.target,
                answering: false,
            });
        }
        Err(e) => {
            if owns_ui() {
                show_api_error(app, &e);
            }
            set_tray_state(app, TrayIconState::Idle);
            crate::actions::emit_transcription_complete(
                app,
                crate::actions::TranscriptionOutcome::Failed,
                ctx.sample_count,
                ctx.stop_time,
            );
        }
    }
}

/// The first line of `text`, short enough for the island.
pub fn preview(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let line = line.trim_start_matches(['#', '*', '-', '>', ' ']);
    if line.chars().count() > 140 {
        format!("{}…", context::head_chars(line, 139).trim_end())
    } else {
        line.to_string()
    }
}

/// Pastes a finished result and shows it in the island.
async fn deliver(
    app: &AppHandle,
    mode: FlowMode,
    finished: Finished,
    working_id: u64,
    sample_count: usize,
    stop_time: Instant,
) {
    let text = crate::transcription_hook::apply(app, finished.text.clone()).await;
    if text.trim().is_empty() {
        if island::current_id() == working_id {
            show_error(app, IslandError::NothingHeard);
        }
        set_tray_state(app, TrayIconState::Idle);
        return;
    }
    if matches!(mode, FlowMode::PromptEngineer | FlowMode::This) {
        *lock(&LAST_PROMPT) = Some(LastPrompt {
            text: text.clone(),
            app: finished.target.clone(),
        });
    }
    let pasted = paste_blocking(app, text.clone(), false).await;
    set_tray_state(app, TrayIconState::Idle);
    crate::actions::emit_transcription_complete(
        app,
        if pasted.is_ok() {
            crate::actions::TranscriptionOutcome::Typed
        } else {
            crate::actions::TranscriptionOutcome::Failed
        },
        sample_count,
        stop_time,
    );
    if island::current_id() != working_id {
        return;
    }
    let pasted_ok = match pasted {
        Ok(()) => true,
        Err(e) => {
            log::warn!("Paste failed: {e}; leaving the text on the clipboard");
            let _ = crate::clipboard::copy_text(app, &text);
            false
        }
    };
    let island_id = island::show(
        app,
        IslandView::Done {
            mode: island_mode(mode),
            preview: preview(&text),
            label: finished.label,
            memory: finished.memory_used,
            pasted: pasted_ok,
        },
    );
    *lock(&LAST_RESULT) = Some(LastResult { island_id, text });
}

/// Pastes on a worker thread (paste sleeps between steps) and waits.
async fn paste_blocking(app: &AppHandle, text: String, never_submit: bool) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = if never_submit {
            crate::clipboard::paste_without_submit(text, handle)
        } else {
            crate::clipboard::paste(text, handle)
        };
        match outcome {
            Ok(crate::clipboard::PasteOutcome::Pasted) => Ok(()),
            Ok(crate::clipboard::PasteOutcome::Blocked) => {
                Err("the window takes no input from PromptFlow".to_string())
            }
            Err(e) => Err(e),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Island buttons
// ---------------------------------------------------------------------------

/// A tapped option (`Some`) or "Skip" (`None`) for the question in view `id`.
pub async fn answer(app: &AppHandle, id: u64, answer: Option<String>) {
    let ask = {
        let mut p = lock(&PENDING_ASK);
        match p.as_ref() {
            Some(ask) if ask.island_id == id => p.take(),
            _ => None,
        }
    };
    let Some(ask) = ask else {
        return;
    };
    if ask.created.elapsed() >= ASK_TTL {
        show_error(app, IslandError::AskExpired);
        return;
    }
    let settings = get_settings(app);
    let working_id = island::show(
        app,
        IslandView::Working {
            mode: IslandMode::Engineer,
            step: IslandStep::Writing,
            target: ask.target.clone(),
        },
    );
    let reply = match answer
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
    {
        Some(text) => ClarifyAnswer::Text(text),
        None => ClarifyAnswer::Skip,
    };
    let meta = dictate::build_meta(
        CloudMode::Engineer,
        &settings.flow,
        ask.input.clone(),
        Some((ask.session.clone(), reply)),
    );
    // No audio for a tapped answer, so nothing for History to keep.
    let result = dictate::send(app, &meta, None).await;
    handle_outcome(
        app,
        result,
        HandleContext {
            mode: FlowMode::PromptEngineer,
            input: ask.input,
            target: ask.target,
            working_id,
            history: None,
            sample_count: 0,
            stop_time: Instant::now(),
        },
    )
    .await;
}

/// Closes the question without writing anything.
pub fn close_question(app: &AppHandle, id: u64) {
    let mut p = lock(&PENDING_ASK);
    if p.as_ref().is_some_and(|a| a.island_id == id) {
        *p = None;
    }
    drop(p);
    island::dismiss(app, id);
}

pub fn undo(app: &AppHandle, id: u64) -> Result<(), String> {
    let last = lock(&LAST_RESULT).clone();
    if last.is_none_or(|l| l.island_id != id) {
        return Ok(());
    }
    island::dismiss(app, id);
    *lock(&LAST_RESULT) = None;
    let handle = app.clone();
    std::thread::spawn(move || {
        // Let the click's mouse-up land first.
        std::thread::sleep(Duration::from_millis(60));
        if let Err(e) = crate::clipboard::send_undo(&handle) {
            log::warn!("Undo failed: {e}");
        }
    });
    Ok(())
}

pub fn copy(app: &AppHandle, id: u64) -> Result<(), String> {
    let text = lock(&LAST_RESULT)
        .as_ref()
        .filter(|l| l.island_id == id)
        .map(|l| l.text.clone())
        .ok_or("Nothing to copy")?;
    crate::clipboard::copy_text(app, &text)
}

/// Autopilot: checks the AI's answer on screen against the last prompt.
pub async fn autopilot(app: &AppHandle) {
    let settings = get_settings(app);
    if !super::cloud_mode(&settings) {
        log::info!("Autopilot needs the PromptFlow cloud; Private mode is on");
        show_error(app, IslandError::SignIn);
        return;
    }
    if !super::session::is_signed_in() {
        show_error(app, IslandError::SignIn);
        return;
    }
    let Some(intent) = lock(&LAST_PROMPT).clone() else {
        show_error(app, IslandError::NothingToCheck);
        return;
    };
    let working_id = island::show(
        app,
        IslandView::Working {
            mode: IslandMode::Autopilot,
            step: IslandStep::Checking,
            target: None,
        },
    );
    let read = tauri::async_runtime::spawn_blocking(|| {
        let answer = context::answer_text(super::api::CHECK_ANSWER_MAX);
        let app_name = crate::flow::app_context::detect_now().and_then(|a| a.app_name);
        (answer, app_name)
    })
    .await;
    let (answer, app_name) = read.unwrap_or((None, None));
    let Some((answer, _source)) = answer else {
        if island::current_id() == working_id {
            show_error(app, IslandError::NoAnswerFound);
        }
        return;
    };
    let app_name = app_name.or(intent.app.clone());
    let result = super::api::check(app, &intent.text, &answer, app_name.as_deref()).await;
    if island::current_id() != working_id {
        return;
    }
    match result {
        Ok(check) => {
            let has_fix = check.follow_up.is_some();
            let island_id = island::show(
                app,
                IslandView::Verdict {
                    good: check.good,
                    issues: check.issues,
                    has_fix,
                },
            );
            *lock(&PENDING_FIX) = check.follow_up.map(|text| PendingFix { island_id, text });
        }
        Err(e) => show_api_error(app, &e),
    }
}

/// "Send fix": pastes Autopilot's follow-up into the focused field. Never
/// presses Return; the user sends it.
pub async fn send_fix(app: &AppHandle, id: u64) -> Result<(), String> {
    let fix = {
        let mut f = lock(&PENDING_FIX);
        match f.as_ref() {
            Some(fix) if fix.island_id == id => f.take(),
            _ => None,
        }
    };
    let Some(fix) = fix else {
        return Ok(());
    };
    island::dismiss(app, id);
    // Let the panel's click finish before keys go to the app.
    tokio::time::sleep(Duration::from_millis(80)).await;
    match paste_blocking(app, fix.text.clone(), true).await {
        Ok(()) => {
            let island_id = island::show(
                app,
                IslandView::Done {
                    mode: IslandMode::Autopilot,
                    preview: preview(&fix.text),
                    label: None,
                    memory: Vec::new(),
                    pasted: true,
                },
            );
            *lock(&LAST_RESULT) = Some(LastResult {
                island_id,
                text: fix.text,
            });
            Ok(())
        }
        Err(e) => {
            let _ = crate::clipboard::copy_text(app, &fix.text);
            show_error(app, IslandError::PasteFailed);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_is_the_first_real_line() {
        assert_eq!(preview("\n\n## Goal\nBuild it"), "Goal");
        assert_eq!(preview("  hello world  "), "hello world");
        let long = "word ".repeat(60);
        let p = preview(&long);
        assert!(p.ends_with('…'));
        assert!(p.chars().count() <= 140);
    }

    #[test]
    fn this_prefers_a_copied_selection() {
        let captured = Captured {
            field: Default::default(),
            screen: Some(MetaScreen {
                text: "window text".into(),
                source: ScreenSource::Window,
            }),
        };
        let input = meta_input(
            FlowMode::This,
            2.0,
            None,
            captured.clone(),
            Some("picked".into()),
        );
        let screen = input.screen.unwrap();
        assert_eq!(screen.text, "picked");
        assert_eq!(screen.source, ScreenSource::Selection);

        let input = meta_input(FlowMode::This, 2.0, None, captured.clone(), None);
        assert_eq!(input.screen.unwrap().source, ScreenSource::Window);

        let input = meta_input(FlowMode::Dictate, 2.0, None, captured, None);
        assert!(input.screen.is_none());
    }

    #[test]
    fn api_errors_map_to_island_errors() {
        let e = |code| ApiError::new(code, "x");
        assert_eq!(island_error(&e(ErrorCode::Quota)), IslandError::Quota);
        assert_eq!(
            island_error(&e(ErrorCode::RateLimited)),
            IslandError::RateLimited
        );
        assert_eq!(island_error(&e(ErrorCode::Network)), IslandError::Network);
        assert_eq!(
            island_error(&ApiError::not_signed_in()),
            IslandError::SignIn
        );
        assert_eq!(
            island_error(&ApiError::session_ended()),
            IslandError::SessionEnded
        );
    }

    #[test]
    fn cloud_modes() {
        assert_eq!(cloud_mode(FlowMode::This), CloudMode::Engineer);
        assert_eq!(cloud_mode(FlowMode::Command), CloudMode::Command);
        assert_eq!(island_mode(FlowMode::This), IslandMode::This);
    }
}
