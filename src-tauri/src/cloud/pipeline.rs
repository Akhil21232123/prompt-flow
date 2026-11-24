//! One cloud recording from the moment the key is released to the paste,
//! plus everything the island's buttons do afterwards: answering a question,
//! undo, copy, Autopilot's check and its fix.

use super::api::{ApiError, ErrorCode};
use super::context::{self, Captured};
use super::dictate::{
    self, ClarifyAnswer, CloudMode, DictateOutcome, Finished, MetaApp, MetaInput, MetaScreen,
    ScreenSource,
};
use super::outbox;
use crate::flow::app_context::AppContext;
use crate::flow::settings::StylePreset;
use crate::flow::FlowMode;
use crate::island::{
    self, IslandContext, IslandError, IslandMode, IslandStep, IslandView, Redo, RetryState,
    SmartHint, SmartKind,
};
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
    /// What was pasted (or copied).
    text: String,
    /// What was said, for redos.
    raw: String,
    mode: FlowMode,
    input: MetaInput,
    /// The app it was pasted into; Undo and redos only send ⌘Z there.
    bundle: Option<String>,
    pasted: bool,
    /// The paste also pressed Return (auto-submit): the text is already sent,
    /// so it can't be undone or replaced.
    submitted: bool,
    /// For feedback.
    dictation_id: Option<String>,
    label: Option<String>,
}

/// The kept recording the island is offering to retry. Its audio and meta
/// are in the outbox.
struct PendingRetry {
    island_id: u64,
    request_id: String,
    attempt: u32,
    /// Retry by itself (network and server errors), or only when asked
    /// (a timeout: the server may still be finishing the first try).
    auto: bool,
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
static PENDING_RETRY: Lazy<Mutex<Option<PendingRetry>>> = Lazy::new(|| Mutex::new(None));

/// Seconds before each automatic retry; after the last, the user retries.
const RETRY_BACKOFF: [u32; 3] = [3, 8, 20];

/// The server keeps a question for 10 minutes; stop offering it a little before.
const ASK_TTL: Duration = Duration::from_secs(9 * 60 + 30);

/// The longest a recording waits, after the key is released, for the screen
/// text that started being read when it began.
const CAPTURE_WAIT: Duration = Duration::from_secs(5);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn island_mode(mode: FlowMode) -> IslandMode {
    match mode {
        FlowMode::Dictate => IslandMode::Dictate,
        FlowMode::PromptEngineer => IslandMode::Engineer,
        FlowMode::Command => IslandMode::Command,
        FlowMode::This => IslandMode::This,
        FlowMode::Auto => IslandMode::Smart,
    }
}

fn cloud_mode(mode: FlowMode) -> CloudMode {
    match mode {
        FlowMode::Dictate => CloudMode::Dictate,
        FlowMode::PromptEngineer | FlowMode::This => CloudMode::Engineer,
        FlowMode::Command => CloudMode::Command,
        FlowMode::Auto => CloudMode::Auto,
    }
}

/// The mode the server settled on (`response.mode`), for a Smart request.
fn resolved_mode(server_mode: &str) -> FlowMode {
    match server_mode {
        "engineer" => FlowMode::PromptEngineer,
        "command" => FlowMode::Command,
        "auto" => FlowMode::Auto,
        _ => FlowMode::Dictate,
    }
}

/// What kind of app is in front, as Smart (and the server) sees it.
fn smart_category(
    app: Option<&AppContext>,
    flow: &crate::flow::settings::FlowSettings,
) -> crate::flow::settings::AppCategory {
    app.map(|ctx| crate::flow::app_context::classify(ctx, &flow.app_overrides))
        .unwrap_or_default()
}

/// The selection Smart may edit: only text selected in a field the user can
/// type into, and never in a terminal (a highlight there is output, and
/// pasting an "edit" of it could run as a command).
fn smart_selection(
    field: &context::FieldContext,
    category: crate::flow::settings::AppCategory,
) -> Option<String> {
    if category == crate::flow::settings::AppCategory::Terminal || !field.selected_editable {
        return None;
    }
    field.selected.clone().filter(|s| !s.trim().is_empty())
}

/// What Smart is about to write, from what's in front as recording starts:
/// a selection is edited, an AI (or code editor) gets a prompt, anything
/// else gets a message for that app.
fn smart_hint(
    app: Option<&AppContext>,
    field: &context::FieldContext,
    category: crate::flow::settings::AppCategory,
) -> SmartHint {
    if smart_selection(field, category).is_some() {
        return SmartHint {
            kind: SmartKind::Edit,
            app: None,
        };
    }
    let web = shows_web_pages(app);
    let app_name = app.and_then(|a| a.app_name.clone());
    let title = field
        .window_title
        .as_deref()
        .or(app.and_then(|a| a.window_title.as_deref()));
    let ai = context::known_ai_target(app_name.as_deref(), web, field.url.as_deref(), title);
    match ai {
        Some(ai) => SmartHint {
            kind: SmartKind::Prompt,
            app: Some(ai),
        },
        None if category.is_ai_target() => SmartHint {
            kind: SmartKind::Prompt,
            app: app_name,
        },
        // A browser's name says nothing about the page: just "Message".
        None => SmartHint {
            kind: SmartKind::Message,
            app: if web { None } else { app_name },
        },
    }
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
        ErrorCode::Timeout => IslandError::Timeout,
        ErrorCode::Server => IslandError::Server,
    }
}

/// Forgets the retry the island was offering (its recording stays in the
/// outbox and History). `Some(id)`: only if view `id` was offering it.
pub fn clear_retry(id: Option<u64>) {
    let mut p = lock(&PENDING_RETRY);
    if id.is_none() || p.as_ref().map(|r| r.island_id) == id {
        *p = None;
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
            retry: None,
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
            retry: None,
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
    // A new recording takes over the island: an offered retry stops (the
    // failed one waits in History).
    clear_retry(None);
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
        language,
        answering,
        target: None,
        context: None,
        hint: None,
        hands_free: false,
    };
    let listening_id = island::show(app, view);

    let wants_screen = mode == FlowMode::This && !answering;
    let handle = app.clone();
    context::begin_capture(wants_screen, move |screen| {
        // Show "Using 2,140 characters from Safari" while still listening.
        let app_name = crate::flow::app_context::peek_name(Duration::from_millis(600));
        let context = IslandContext {
            chars: screen.text.chars().count() as u32,
            source: screen.source,
            app: app_name,
        };
        island::patch(&handle, listening_id, |view| {
            if let IslandView::Listening { context: c, .. } = view {
                *c = Some(context);
            }
        });
    });

    // Smart says what it's about to do: "Prompt for Claude", "Message for
    // Mail", "Edit selection".
    if island_mode == IslandMode::Smart {
        let handle = app.clone();
        let flow = settings.flow.clone();
        std::thread::spawn(move || {
            let wait = Duration::from_millis(1200);
            let app_ctx = crate::flow::app_context::peek(wait);
            let field = context::peek_field(wait).unwrap_or_default();
            let category = smart_category(app_ctx.as_ref(), &flow);
            let hint = smart_hint(app_ctx.as_ref(), &field, category);
            island::patch(&handle, listening_id, |view| {
                if let IslandView::Listening { hint: h, .. } = view {
                    *h = Some(hint);
                }
            });
        });
    }

    // Prompt modes say what the prompt is for: "Prompt for Claude".
    if !matches!(
        island_mode,
        IslandMode::Dictate | IslandMode::Command | IslandMode::Smart
    ) {
        let handle = app.clone();
        std::thread::spawn(move || {
            let wait = Duration::from_millis(1200);
            let app_ctx = crate::flow::app_context::peek(wait);
            let field = context::peek_field(wait).unwrap_or_default();
            let Some(target) = resolve_target(app_ctx.as_ref(), &field) else {
                return;
            };
            island::patch(&handle, listening_id, |view| {
                if let IslandView::Listening { target: t, .. } = view {
                    *t = Some(target);
                }
            });
        });
    }
}

/// Whether the app is a browser or a web app saved from one: its page, not
/// the app, says which AI is in front.
fn shows_web_pages(app: Option<&AppContext>) -> bool {
    app.is_some_and(|a| {
        crate::flow::app_context::is_browser(a)
            || crate::flow::app_context::is_web_app(a.bundle_id.as_deref())
    })
}

/// What a prompt is written for, as the island names it.
fn resolve_target(app: Option<&AppContext>, field: &context::FieldContext) -> Option<String> {
    let title = field
        .window_title
        .as_deref()
        .or(app.and_then(|a| a.window_title.as_deref()));
    context::target_name(
        app.and_then(|a| a.app_name.as_deref()),
        shows_web_pages(app),
        field.url.as_deref(),
        title,
    )
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
    // Reading the screen is bounded on its own, but never let it hold the
    // request for long: without it the prompt is still useful.
    let captured: Captured = tokio::time::timeout(
        CAPTURE_WAIT,
        tokio::task::spawn_blocking(context::take_captured),
    )
    .await
    .ok()
    .and_then(|joined| joined.ok())
    .unwrap_or_else(|| {
        log::warn!("Reading the screen took too long; sending without it");
        Captured::default()
    });

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
    // A browser whose page address the accessibility tree didn't give:
    // ask the browser (web apps have no address to ask for; their title
    // and name say what they are).
    let mut captured = captured;
    // Smart edits only a selection it may edit (the hint said so too).
    if rec.mode == FlowMode::Auto {
        let category = smart_category(rec.app_context.as_ref(), &settings.flow);
        captured.field.selected = smart_selection(&captured.field, category);
    }
    if captured.field.url.is_none() {
        if let Some(bundle) = rec
            .app_context
            .as_ref()
            .filter(|a| crate::flow::app_context::is_browser(a))
            .filter(|a| !crate::flow::app_context::is_web_app(a.bundle_id.as_deref()))
            .and_then(|a| a.bundle_id.clone())
        {
            captured.field.url =
                tauri::async_runtime::spawn_blocking(move || context::browser_url(&bundle))
                    .await
                    .ok()
                    .flatten();
        }
    }
    let target = pending
        .as_ref()
        .and_then(|p| p.target.clone())
        .or_else(|| resolve_target(rec.app_context.as_ref(), &captured.field));
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
    // Somewhere noisy: clean the audio first (a clean recording is sent
    // exactly as recorded).
    let (samples, noise) = clean_recording(app, rec.samples).await;
    let mut meta = dictate::build_meta(cloud_mode(mode), &settings.flow, input.clone(), clarify);
    let request_id = dictate::new_request_id();
    meta.request_id = Some(request_id.clone());
    meta.noise_filtered = noise.filtered;
    meta.snr_db = noise.snr_db.map(|db| (db * 10.0).round() / 10.0);
    let meta_json = serde_json::to_string(&meta).unwrap_or_default();
    let wav = Arc::new(dictate::encode_wav(&samples));

    // History keeps the audio, like the on-device pipeline.
    let hm = Arc::clone(&app.state::<Arc<HistoryManager>>());
    let file_name = format!("handy-{}.wav", chrono::Utc::now().timestamp());
    let wav_path = hm.recordings_dir().join(&file_name);
    let wav_saved = tauri::async_runtime::spawn_blocking(move || {
        crate::audio_toolkit::save_wav_file(&wav_path, &samples).is_ok()
    });

    let result = dictate::send_json(app, &meta_json, Some(wav.as_slice())).await;
    let wav_saved = wav_saved.await.unwrap_or(false);
    if cancelled() {
        island::hide(app);
        set_tray_state(app, TrayIconState::Idle);
        return;
    }
    let history = wav_saved.then_some((hm, file_name));
    let input_app_name = input.app.name.clone();
    let input_bundle = input.app.bundle_id.clone();
    let target_for_retry = target.clone();
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
            retry: Some(RetryPayload {
                attempt: 1,
                item: outbox::OutboxItem {
                    id: request_id,
                    created_at: chrono::Utc::now().timestamp(),
                    mode: cloud_mode(mode).as_str().to_string(),
                    meta_json,
                    app_name: input_app_name.clone(),
                    bundle_id: input_bundle.clone(),
                    target: target_for_retry,
                    duration_sec: duration,
                },
                wav,
            }),
            verify_front: false,
            noise_filtered: noise.filtered,
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
            // The window's title from Accessibility (read as recording
            // starts) is the most reliable; System Events' is the fallback.
            title: field
                .window_title
                .or_else(|| app.and_then(|a| a.window_title.clone())),
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
    /// The request, kept to retry it if it fails for a reason that may pass.
    retry: Option<RetryPayload>,
    /// The result may arrive long after the recording (a retry): paste only
    /// into the app it was recorded in, and only if the island is still ours.
    verify_front: bool,
    /// The audio went through the noise filter (the result card says so).
    noise_filtered: bool,
}

struct RetryPayload {
    /// This request's try number.
    attempt: u32,
    item: outbox::OutboxItem,
    wav: Arc<Vec<u8>>,
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
            // Sent: it no longer waits in the outbox.
            if let Some(payload) = &ctx.retry {
                outbox::remove(app, &payload.item.id);
            }
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
            // Smart: show and remember it as what the server made of it.
            let mode = match ctx.mode {
                FlowMode::Auto => resolved_mode(&finished.mode),
                mode => mode,
            };
            deliver(
                app,
                Delivery {
                    mode,
                    finished,
                    input: ctx.input,
                    working_id: ctx.working_id,
                    sample_count: ctx.sample_count,
                    stop_time: ctx.stop_time,
                    verify_front: ctx.verify_front,
                    noise_filtered: ctx.noise_filtered,
                },
            )
            .await;
        }
        Ok(DictateOutcome::Dropped { reason }) => {
            log::info!("Nothing to paste ({reason})");
            if let Some(payload) = &ctx.retry {
                outbox::remove(app, &payload.item.id);
            }
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
            if let Some(payload) = &ctx.retry {
                outbox::remove(app, &payload.item.id);
            }
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
            set_tray_state(app, TrayIconState::Idle);
            crate::actions::emit_transcription_complete(
                app,
                crate::actions::TranscriptionOutcome::Failed,
                ctx.sample_count,
                ctx.stop_time,
            );
            if !owns_ui() {
                return;
            }
            match (ctx.retry, retry_policy(&e)) {
                // Never lose what was said: keep it on disk and try again.
                (Some(payload), Some(auto)) => {
                    log::warn!("PromptFlow request failed ({e}); keeping the recording to retry");
                    if let Err(err) = outbox::save(app, &payload.item, &payload.wav) {
                        log::error!("Could not keep the recording: {err}");
                        show_api_error(app, &e);
                        return;
                    }
                    offer_retry(
                        app,
                        &e,
                        PendingRetry {
                            island_id: 0,
                            request_id: payload.item.id,
                            attempt: payload.attempt,
                            auto,
                        },
                    );
                }
                (Some(payload), None) => {
                    // A request the server refused won't work next time
                    // either; anything else (limits, sign-in) can wait.
                    if e.code == ErrorCode::BadRequest {
                        outbox::remove(app, &payload.item.id);
                    }
                    show_api_error(app, &e);
                }
                (None, _) => show_api_error(app, &e),
            }
        }
    }
}

/// Whether a failed request is kept to retry, and whether PromptFlow retries
/// it by itself (`Some(true)`) or only when asked (`Some(false)`: a timeout,
/// where the server may still finish and save the first try).
fn retry_policy(e: &ApiError) -> Option<bool> {
    match e.code {
        ErrorCode::Network | ErrorCode::Server | ErrorCode::Provider => Some(true),
        ErrorCode::Timeout => Some(false),
        _ => None,
    }
}

/// Seconds before automatic retry `attempt + 1`, or `None` when PromptFlow
/// stops retrying on its own.
pub fn backoff(attempt: u32) -> Option<u32> {
    RETRY_BACKOFF
        .get(attempt.saturating_sub(1) as usize)
        .copied()
}

/// Whether an on-device model could transcribe a kept recording.
fn local_model_ready(app: &AppHandle) -> bool {
    let selected = get_settings(app).selected_model;
    !selected.is_empty()
        && app
            .state::<Arc<crate::managers::model::ModelManager>>()
            .get_model_info(&selected)
            .is_some_and(|m| m.is_downloaded)
}

fn offer_retry(app: &AppHandle, e: &ApiError, mut pending: PendingRetry) {
    let next = if pending.auto {
        backoff(pending.attempt)
    } else {
        None
    };
    let error = match island_error(e) {
        IslandError::Network => IslandError::Network,
        IslandError::Timeout => IslandError::Timeout,
        _ => IslandError::Server,
    };
    let island_id = island::show(
        app,
        IslandView::Error {
            error,
            message: None,
            retry_after_sec: None,
            retry: Some(RetryState {
                attempt: pending.attempt,
                next_in_sec: next,
                can_paste_raw: local_model_ready(app),
            }),
        },
    );
    pending.island_id = island_id;
    *lock(&PENDING_RETRY) = Some(pending);
    if let Some(secs) = next {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(secs as u64)).await;
            // Only while the island still shows this retry: dismissed or
            // replaced by a new recording, it waits in History instead.
            if island::current_id() == island_id {
                retry(&app, island_id).await;
            }
        });
    }
}

/// Takes the retry view `id` is offering, with its kept recording.
fn take_retry(app: &AppHandle, id: u64) -> Option<(PendingRetry, outbox::OutboxItem, Vec<u8>)> {
    let pending = {
        let mut p = lock(&PENDING_RETRY);
        match p.as_ref() {
            Some(r) if r.island_id == id => p.take(),
            _ => None,
        }
    }?;
    let Some((item, wav)) = outbox::get(app, &pending.request_id) else {
        // Deleted from History meanwhile.
        island::dismiss(app, id);
        return None;
    };
    Some((pending, item, wav))
}

/// What a kept recording knows of where it was recorded.
fn outbox_input(item: &outbox::OutboxItem) -> MetaInput {
    MetaInput {
        duration_sec: Some(item.duration_sec),
        app: MetaApp {
            name: item.app_name.clone(),
            bundle_id: item.bundle_id.clone(),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn outbox_mode(item: &outbox::OutboxItem) -> FlowMode {
    match item.mode.as_str() {
        "engineer" => FlowMode::PromptEngineer,
        "command" => FlowMode::Command,
        _ => FlowMode::Dictate,
    }
}

/// Sends the kept recording shown in island view `id` again, with the same
/// request id.
pub async fn retry(app: &AppHandle, id: u64) {
    let Some((pending, item, wav)) = take_retry(app, id) else {
        return;
    };
    let mode = outbox_mode(&item);
    let working_id = island::show(
        app,
        IslandView::Working {
            mode: island_mode(mode),
            step: IslandStep::Transcribing,
            target: item.target.clone(),
        },
    );
    let result = dictate::send_json(app, &item.meta_json, Some(&wav)).await;
    let noise_filtered = meta_noise_filtered(&item.meta_json);
    handle_outcome(
        app,
        result,
        HandleContext {
            mode,
            input: outbox_input(&item),
            target: item.target.clone(),
            working_id,
            history: None,
            sample_count: (item.duration_sec * 16_000.0) as usize,
            stop_time: Instant::now(),
            retry: Some(RetryPayload {
                attempt: pending.attempt + 1,
                item,
                wav: Arc::new(wav),
            }),
            verify_front: true,
            noise_filtered,
        },
    )
    .await;
}

/// Gives up on the cloud for the kept recording in view `id`: transcribes
/// it on this Mac and pastes the words as heard.
pub async fn paste_raw(app: &AppHandle, id: u64) {
    let Some((_, item, wav)) = take_retry(app, id) else {
        return;
    };
    let working_id = island::show(
        app,
        IslandView::Working {
            mode: IslandMode::Dictate,
            step: IslandStep::Transcribing,
            target: None,
        },
    );
    let handle = app.clone();
    let samples = outbox::wav_samples(&wav);
    let sample_count = samples.len();
    let model = get_settings(app).selected_model;
    let text = tauri::async_runtime::spawn_blocking(move || {
        let tm = handle.state::<Arc<crate::managers::transcription::TranscriptionManager>>();
        if !tm.is_model_loaded() {
            tm.load_model(&model).map_err(|e| e.to_string())?;
        }
        tm.transcribe_recording(samples)
            .map(|t| t.text)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    match text {
        Ok(text) if !text.trim().is_empty() => {
            outbox::remove(app, &item.id);
            let raw = text.trim().to_string();
            deliver(
                app,
                Delivery {
                    mode: FlowMode::Dictate,
                    finished: Finished {
                        id: None,
                        raw: raw.clone(),
                        text: raw,
                        mode: "dictate".into(),
                        label: None,
                        target: None,
                        memory_used: Vec::new(),
                        language: None,
                    },
                    input: outbox_input(&item),
                    working_id,
                    sample_count,
                    stop_time: Instant::now(),
                    verify_front: true,
                    noise_filtered: meta_noise_filtered(&item.meta_json),
                },
            )
            .await;
        }
        Ok(_) => show_error(app, IslandError::NothingHeard),
        Err(e) => {
            log::warn!("On-device transcription failed: {e}");
            show_api_error(app, &ApiError::server(e));
        }
    }
}

/// History's "Retry" for a kept recording: sends it (never asking a
/// question back) and returns the text, which also lands in History.
pub async fn send_kept(app: &AppHandle, id: &str) -> Result<String, ApiError> {
    let (item, wav) = outbox::get(app, id)
        .ok_or_else(|| ApiError::new(ErrorCode::BadRequest, "That recording is gone"))?;
    let mut meta: serde_json::Value =
        serde_json::from_str(&item.meta_json).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(o) = meta.as_object_mut() {
        o.insert("ask_back".into(), serde_json::json!(false));
    }
    match dictate::send_json(app, &meta.to_string(), Some(&wav)).await {
        Ok(DictateOutcome::Done(f)) => {
            outbox::remove(app, id);
            Ok(f.text)
        }
        Ok(_) => {
            outbox::remove(app, id);
            Ok(String::new())
        }
        Err(e) => {
            if e.code == ErrorCode::BadRequest {
                outbox::remove(app, id);
            }
            Err(e)
        }
    }
}

/// Removes `<tag>`-style markup, so an XML-sectioned prompt previews as words.
fn strip_tags(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_tag = false;
    for c in line.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    // An unclosed `<` was not a tag after all.
    if in_tag {
        return line.to_string();
    }
    out
}

/// The first line of words in `text`, short enough for the island.
pub fn preview(text: &str) -> String {
    let line = text
        .lines()
        .map(|l| {
            strip_tags(l)
                .trim()
                .trim_start_matches(['#', '*', '-', '>', ' '])
                .to_string()
        })
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    if line.chars().count() > 140 {
        format!("{}…", context::head_chars(&line, 139).trim_end())
    } else {
        line
    }
}

/// A finished result on its way to the user's app.
struct Delivery {
    mode: FlowMode,
    finished: Finished,
    input: MetaInput,
    working_id: u64,
    sample_count: usize,
    stop_time: Instant,
    /// Paste only if the island is still ours and the recording's app is in
    /// front; otherwise copy (a retried result can arrive much later).
    verify_front: bool,
    noise_filtered: bool,
}

/// The redos offered after a result of `mode`.
pub fn chips_for(mode: FlowMode) -> Vec<Redo> {
    match mode {
        FlowMode::Dictate => vec![Redo::AsPrompt, Redo::Formal, Redo::Shorter],
        FlowMode::PromptEngineer | FlowMode::This => vec![Redo::AsWritten],
        // A Smart result is shown as the mode the server settled on.
        FlowMode::Command | FlowMode::Auto => Vec::new(),
    }
}

/// Pastes a finished result and shows it in the island.
async fn deliver(app: &AppHandle, d: Delivery) {
    let Delivery {
        mode,
        finished,
        input,
        working_id,
        sample_count,
        stop_time,
        verify_front,
        noise_filtered,
    } = d;
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
    let may_paste = if verify_front {
        let front = front_bundle().await;
        island::current_id() == working_id
            && same_app(input.app.bundle_id.as_deref(), front.as_deref())
    } else {
        true
    };
    let pasted = if may_paste {
        paste_blocking(app, text.clone(), false).await
    } else {
        Err("a different app is in front now".to_string())
    };
    let submitted = pasted.is_ok() && crate::clipboard::cloud_paste_submits(app);
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
    show_result(
        app,
        LastResult {
            island_id: 0,
            text,
            raw: finished.raw,
            mode,
            bundle: input.app.bundle_id.clone(),
            input,
            pasted: pasted_ok,
            submitted,
            dictation_id: finished.id,
            label: finished.label,
        },
        finished.memory_used,
        noise_filtered,
    );
}

/// Runs the noise filter over a finished recording off the async runtime.
/// If it fails, the recording goes as it was.
pub(crate) async fn clean_recording(
    app: &AppHandle,
    raw: Vec<f32>,
) -> (Vec<f32>, crate::audio_toolkit::noise::CleanReport) {
    let handle = app.clone();
    let backup = raw.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::managers::audio::clean_for_transcription(&handle, raw)
    })
    .await
    .unwrap_or_else(|e| {
        log::warn!("Noise filter failed ({e}); sending the recording as it was");
        (backup, Default::default())
    })
}

/// Whether a kept request's audio was filtered (it says so in its meta).
fn meta_noise_filtered(meta_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(meta_json)
        .ok()
        .and_then(|v| v.get("noise_filtered").and_then(|b| b.as_bool()))
        .unwrap_or(false)
}

/// Shows `result` in the island and remembers it for Undo, Copy, redos and
/// feedback.
fn show_result(
    app: &AppHandle,
    mut result: LastResult,
    memory: Vec<dictate::MemoryChip>,
    noise_filtered: bool,
) {
    let has_raw = !result.raw.trim().is_empty();
    result.island_id = island::show(
        app,
        IslandView::Done {
            mode: island_mode(result.mode),
            preview: preview(&result.text),
            label: result.label.clone(),
            memory,
            pasted: result.pasted,
            sent: result.submitted,
            chips: if has_raw {
                chips_for(result.mode)
            } else {
                Vec::new()
            },
            rateable: result.dictation_id.is_some(),
            tip: crate::fn_key::take_tip(app),
            noise_filtered,
        },
    );
    *lock(&LAST_RESULT) = Some(result);
}

/// The bundle id of the app in front now.
async fn front_bundle() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::flow::app_context::detect_now().and_then(|a| a.bundle_id)
    })
    .await
    .ok()
    .flatten()
}

/// Whether ⌘Z in the app in front would undo our paste: it went into this
/// same app.
fn same_app(pasted_into: Option<&str>, front: Option<&str>) -> bool {
    matches!((pasted_into, front), (Some(a), Some(b)) if a == b)
}

/// Whether a redo may ⌘Z the earlier paste and paste over it: it was
/// pasted, not already sent with Return, and its app is still in front.
fn redo_replaces(last: &LastResult, front: Option<&str>) -> bool {
    last.pasted && !last.submitted && same_app(last.bundle.as_deref(), front)
}

/// A redo chip: the same words again, another way, replacing the paste.
pub async fn redo(app: &AppHandle, id: u64, kind: Redo) {
    let last = lock(&LAST_RESULT)
        .as_ref()
        .filter(|l| l.island_id == id)
        .cloned();
    let Some(last) = last else {
        return;
    };
    let (mode, preset) = match kind {
        Redo::AsPrompt => (FlowMode::PromptEngineer, None),
        Redo::AsWritten => (FlowMode::Dictate, None),
        Redo::Formal => (FlowMode::Dictate, Some(StylePreset::Formal)),
        Redo::Shorter => (FlowMode::Dictate, Some(StylePreset::Short)),
    };
    let mut flow = get_settings(app).flow;
    if preset.is_some() {
        flow.style_preset = preset;
    }
    let target = (mode == FlowMode::PromptEngineer)
        .then(|| last.input.app.name.clone())
        .flatten();
    let working_id = island::show(
        app,
        IslandView::Working {
            mode: island_mode(mode),
            step: IslandStep::Writing,
            target,
        },
    );
    let meta = dictate::build_meta(cloud_mode(mode), &flow, last.input.clone(), None);
    let result = dictate::rewrite(app, &meta, &last.raw).await;
    if island::current_id() != working_id {
        return;
    }
    let finished = match result {
        Ok(DictateOutcome::Done(f)) => f,
        Ok(DictateOutcome::Dropped { .. }) => {
            show_error(app, IslandError::NothingHeard);
            return;
        }
        Ok(DictateOutcome::Ask(_)) => {
            show_error(app, IslandError::Server);
            return;
        }
        Err(e) => {
            show_api_error(app, &e);
            return;
        }
    };
    let text = finished.text.clone();
    // Replace the paste only where it went, and only if it wasn't already
    // sent with Return; otherwise copy instead.
    let front = front_bundle().await;
    let replace = redo_replaces(&last, front.as_deref());
    let pasted = if replace {
        let handle = app.clone();
        let undone =
            tauri::async_runtime::spawn_blocking(move || crate::clipboard::send_undo(&handle))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r);
        match undone {
            Ok(()) => {
                tokio::time::sleep(Duration::from_millis(150)).await;
                // A redo never presses Return: the user sends it.
                paste_blocking(app, text.clone(), true).await.is_ok()
            }
            Err(e) => {
                log::warn!("Undo before redo failed: {e}");
                false
            }
        }
    } else {
        false
    };
    if !pasted {
        let _ = crate::clipboard::copy_text(app, &text);
    }
    if matches!(mode, FlowMode::PromptEngineer) && pasted {
        *lock(&LAST_PROMPT) = Some(LastPrompt {
            text: text.clone(),
            app: finished.target.clone(),
        });
    }
    show_result(
        app,
        LastResult {
            island_id: 0,
            text,
            raw: last.raw,
            mode,
            input: last.input,
            bundle: last.bundle,
            pasted,
            // An already-sent result stays "sent": its redo is on the clipboard.
            submitted: last.submitted && !pasted,
            dictation_id: finished.id,
            label: finished.label,
        },
        finished.memory_used,
        // A redo rewrites the words; the audio isn't touched again.
        false,
    );
}

/// Pastes on a worker thread (paste sleeps between steps) and waits.
async fn paste_blocking(app: &AppHandle, text: String, never_submit: bool) -> Result<(), String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = crate::clipboard::paste_cloud(text, handle, never_submit);
        match outcome {
            Ok(crate::clipboard::PasteOutcome::Pasted) => Ok(()),
            Ok(crate::clipboard::PasteOutcome::NotPasted) => {
                Err("pasting is turned off".to_string())
            }
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
            // A tapped answer has no recording to keep; it's quick to tap again.
            retry: None,
            verify_front: false,
            noise_filtered: false,
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
    let Some(last) = last.filter(|l| l.island_id == id) else {
        return Ok(());
    };
    island::dismiss(app, id);
    *lock(&LAST_RESULT) = None;
    if !last.pasted || last.submitted {
        return Ok(());
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        // Let the click's mouse-up land first.
        std::thread::sleep(Duration::from_millis(60));
        // ⌘Z only where we pasted: in another app it would undo the user's work.
        let front = crate::flow::app_context::detect_now().and_then(|a| a.bundle_id);
        if !same_app(last.bundle.as_deref(), front.as_deref()) {
            log::info!("Not undoing: a different app is in front now");
            return;
        }
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

/// What feedback says about the result in view `id` (or the last result).
fn feedback_body(last: Option<&LastResult>, rating: &str, note: Option<&str>) -> serde_json::Value {
    let mut body = serde_json::json!({ "rating": rating, "device": "mac" });
    if let Some(note) = note.map(str::trim).filter(|n| !n.is_empty()) {
        body["note"] = serde_json::json!(context::head_chars(note, 2000));
    }
    if let Some(l) = last {
        if let Some(id) = &l.dictation_id {
            body["dictation_id"] = serde_json::json!(id);
        }
        body["mode"] = serde_json::json!(cloud_mode(l.mode).as_str());
        if let Some(label) = &l.label {
            body["label"] = serde_json::json!(label);
        }
        let mut app = serde_json::Map::new();
        if let Some(n) = &l.input.app.name {
            app.insert("name".into(), serde_json::json!(n));
        }
        if let Some(b) = &l.bundle {
            app.insert("bundle_id".into(), serde_json::json!(b));
        }
        if !app.is_empty() {
            body["app"] = serde_json::Value::Object(app);
        }
    }
    body
}

/// 👍/👎 on the result in view `id`. Sent in the background; never fails
/// visibly.
pub fn rate(app: &AppHandle, id: u64, up: bool) {
    let last = lock(&LAST_RESULT)
        .as_ref()
        .filter(|l| l.island_id == id)
        .cloned();
    let Some(last) = last else {
        return;
    };
    let body = feedback_body(Some(&last), if up { "up" } else { "down" }, None);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = super::api::feedback(&app, body).await {
            log::warn!("Feedback wasn't sent: {e}");
        }
    });
}

/// "Report a problem": a note about the last result (when asked to include it).
pub async fn report(app: &AppHandle, note: &str, include_last: bool) -> Result<(), ApiError> {
    let last = include_last.then(|| lock(&LAST_RESULT).clone()).flatten();
    super::api::feedback(app, feedback_body(last.as_ref(), "down", Some(note))).await
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
                    sent: false,
                    chips: Vec::new(),
                    rateable: false,
                    tip: None,
                    noise_filtered: false,
                },
            );
            *lock(&LAST_RESULT) = Some(LastResult {
                island_id,
                text: fix.text,
                raw: String::new(),
                mode: FlowMode::PromptEngineer,
                input: MetaInput::default(),
                bundle: front_bundle().await,
                pasted: true,
                submitted: false,
                dictation_id: None,
                label: None,
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
        assert_eq!(
            preview("<task>\n<goal>Rename photos by date</goal>\n</task>"),
            "Rename photos by date"
        );
        assert_eq!(preview("if a < b then"), "if a < b then");
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
    fn retries_back_off_then_stop() {
        assert_eq!(backoff(1), Some(3));
        assert_eq!(backoff(3), Some(20));
        assert_eq!(backoff(4), None);
        let e = |code| ApiError::new(code, "x");
        assert_eq!(retry_policy(&e(ErrorCode::Network)), Some(true));
        assert_eq!(retry_policy(&e(ErrorCode::Provider)), Some(true));
        // A timeout may still finish on the server: retried only when asked.
        assert_eq!(retry_policy(&e(ErrorCode::Timeout)), Some(false));
        assert_eq!(retry_policy(&e(ErrorCode::Quota)), None);
        assert_eq!(retry_policy(&ApiError::not_signed_in()), None);
    }

    #[test]
    fn redo_chips_fit_the_result() {
        assert_eq!(
            chips_for(FlowMode::Dictate),
            vec![Redo::AsPrompt, Redo::Formal, Redo::Shorter]
        );
        assert_eq!(chips_for(FlowMode::This), vec![Redo::AsWritten]);
        assert!(chips_for(FlowMode::Command).is_empty());
    }

    #[test]
    fn undo_only_where_we_pasted() {
        assert!(same_app(
            Some("com.anthropic.claudefordesktop"),
            Some("com.anthropic.claudefordesktop")
        ));
        assert!(!same_app(Some("com.apple.Safari"), Some("com.apple.mail")));
        assert!(!same_app(None, Some("com.apple.mail")));
        assert!(!same_app(Some("com.apple.mail"), None));
    }

    #[test]
    fn smart_says_what_it_will_write() {
        use crate::flow::settings::AppCategory;
        let mail = AppContext {
            app_name: Some("Mail".into()),
            bundle_id: Some("com.apple.mail".into()),
            window_title: None,
        };
        let empty = context::FieldContext::default();
        assert_eq!(
            smart_hint(Some(&mail), &empty, AppCategory::Email),
            SmartHint {
                kind: SmartKind::Message,
                app: Some("Mail".into())
            }
        );
        let selected = context::FieldContext {
            selected: Some("Dear team".into()),
            selected_editable: true,
            ..Default::default()
        };
        // A highlight on a read-only page, or in a terminal, isn't an edit.
        let read_only = context::FieldContext {
            selected: Some("Dear team".into()),
            selected_editable: false,
            ..Default::default()
        };
        assert_eq!(
            smart_hint(Some(&mail), &read_only, AppCategory::Email).kind,
            SmartKind::Message
        );
        assert_eq!(smart_selection(&read_only, AppCategory::Email), None);
        assert_eq!(smart_selection(&selected, AppCategory::Terminal), None);
        assert_eq!(
            smart_selection(&selected, AppCategory::Email).as_deref(),
            Some("Dear team")
        );
        assert_eq!(
            smart_hint(Some(&mail), &selected, AppCategory::Email).kind,
            SmartKind::Edit
        );
        let cursor = AppContext {
            app_name: Some("Cursor".into()),
            bundle_id: Some("com.todesktop.230313mzl4w4u92".into()),
            window_title: None,
        };
        assert_eq!(
            smart_hint(Some(&cursor), &empty, AppCategory::Code).kind,
            SmartKind::Prompt
        );
        let safari = AppContext {
            app_name: Some("Safari".into()),
            bundle_id: Some("com.apple.Safari".into()),
            window_title: None,
        };
        let claude_page = context::FieldContext {
            url: Some("https://claude.ai/new".into()),
            ..Default::default()
        };
        assert_eq!(
            smart_hint(Some(&safari), &claude_page, AppCategory::Other),
            SmartHint {
                kind: SmartKind::Prompt,
                app: Some("Claude".into())
            }
        );
        assert_eq!(
            smart_hint(Some(&safari), &empty, AppCategory::Other),
            SmartHint {
                kind: SmartKind::Message,
                app: None
            }
        );
        assert_eq!(resolved_mode("engineer"), FlowMode::PromptEngineer);
        assert_eq!(resolved_mode("command"), FlowMode::Command);
        assert_eq!(resolved_mode("dictate"), FlowMode::Dictate);
        assert_eq!(cloud_mode(FlowMode::Auto), CloudMode::Auto);
        assert_eq!(island_mode(FlowMode::Auto), IslandMode::Smart);
    }

    #[test]
    fn redo_never_replaces_a_sent_or_moved_paste() {
        let mut last = LastResult {
            island_id: 1,
            text: "t".into(),
            raw: "r".into(),
            mode: FlowMode::Dictate,
            input: MetaInput::default(),
            bundle: Some("com.apple.Notes".into()),
            pasted: true,
            submitted: false,
            dictation_id: None,
            label: None,
        };
        assert!(redo_replaces(&last, Some("com.apple.Notes")));
        assert!(!redo_replaces(&last, Some("com.apple.Safari")));
        last.submitted = true;
        assert!(!redo_replaces(&last, Some("com.apple.Notes")));
        last.submitted = false;
        last.pasted = false;
        assert!(!redo_replaces(&last, Some("com.apple.Notes")));
    }

    #[test]
    fn a_dismissed_or_replaced_retry_is_forgotten() {
        let pending = |id| PendingRetry {
            island_id: id,
            request_id: "x".into(),
            attempt: 1,
            auto: true,
        };
        *lock(&PENDING_RETRY) = Some(pending(7));
        clear_retry(Some(8));
        assert!(lock(&PENDING_RETRY).is_some(), "another view's dismiss");
        clear_retry(Some(7));
        assert!(lock(&PENDING_RETRY).is_none());
        *lock(&PENDING_RETRY) = Some(pending(9));
        clear_retry(None);
        assert!(lock(&PENDING_RETRY).is_none(), "a new recording");
    }

    #[test]
    fn kept_recordings_know_their_app_and_mode() {
        let item = outbox::OutboxItem {
            id: "a".into(),
            created_at: 0,
            mode: "engineer".into(),
            meta_json: "{}".into(),
            app_name: Some("Claude".into()),
            bundle_id: Some("com.anthropic.claudefordesktop".into()),
            target: None,
            duration_sec: 2.5,
        };
        assert_eq!(outbox_mode(&item), FlowMode::PromptEngineer);
        assert_eq!(
            outbox_input(&item).app.bundle_id.as_deref(),
            Some("com.anthropic.claudefordesktop")
        );
    }

    #[test]
    fn feedback_names_the_result() {
        let last = LastResult {
            island_id: 1,
            text: "t".into(),
            raw: "r".into(),
            mode: FlowMode::PromptEngineer,
            input: MetaInput {
                app: MetaApp {
                    name: Some("Claude".into()),
                    ..Default::default()
                },
                ..Default::default()
            },
            bundle: Some("com.anthropic.claudefordesktop".into()),
            pasted: true,
            submitted: false,
            dictation_id: Some("d1".into()),
            label: Some("Prompt · for Claude".into()),
        };
        let b = feedback_body(Some(&last), "up", Some("  "));
        assert_eq!(b["dictation_id"], "d1");
        assert_eq!(b["rating"], "up");
        assert_eq!(b["mode"], "engineer");
        assert_eq!(b["app"]["name"], "Claude");
        assert!(b.get("note").is_none());
        let r = feedback_body(None, "down", Some("It pasted twice"));
        assert_eq!(r["note"], "It pasted twice");
        assert!(r.get("dictation_id").is_none());
    }

    #[test]
    fn cloud_modes() {
        assert_eq!(cloud_mode(FlowMode::This), CloudMode::Engineer);
        assert_eq!(cloud_mode(FlowMode::Command), CloudMode::Command);
        assert_eq!(island_mode(FlowMode::This), IslandMode::This);
    }
}
