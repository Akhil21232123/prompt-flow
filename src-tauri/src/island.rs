//! The Dynamic Island: PromptFlow's one surface outside the settings window.
//!
//! A black pill at the top centre of the screen that merges with the
//! MacBook notch (or sits just under the menu bar on screens without one)
//! and morphs between listening, working, a question, the result, an
//! Autopilot verdict and errors. It lives in the `recording_overlay` panel,
//! which never takes focus from the app being typed into: it ignores the
//! mouse while it's a pill and takes clicks only while it shows buttons.
//!
//! Rust owns the state (`IslandView`) and the window; `src/overlay` draws it.
//! Each view gets an id; the frontend passes it back with every click, so a
//! click on a view that has already been replaced does nothing.

use crate::cloud::dictate::{MemoryChip, ScreenSource};
use crate::notices::Notice;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

pub const WINDOW_LABEL: &str = "recording_overlay";

/// The panel's width. Constant, so changing state never moves the card
/// sideways; only the height changes.
pub const WINDOW_WIDTH: f64 = 640.0;
/// Panel height while it's a pill (listening, working).
pub const COMPACT_HEIGHT: f64 = 132.0;
/// Panel height while it shows a question, a result or an error.
pub const EXPANDED_HEIGHT: f64 = 360.0;

/// How long a result or an error stays before folding away, unless the
/// pointer is over it.
pub const DONE_HOLD: Duration = Duration::from_millis(3200);
pub const ERROR_HOLD: Duration = Duration::from_millis(4500);
pub const NOTICE_HOLD: Duration = Duration::from_millis(4000);
/// An unanswered question folds away after this (the server forgets it at 10 min).
pub const ASK_HOLD: Duration = Duration::from_secs(9 * 60);
/// A verdict with a fix waits longer: the user has to read the issues.
pub const VERDICT_HOLD: Duration = Duration::from_secs(20);
/// How long the fold-away animation runs before the panel is hidden.
const HIDE_DELAY: Duration = Duration::from_millis(420);

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum IslandMode {
    Dictate,
    /// Prompt Engineer.
    Engineer,
    Command,
    /// "This": a prompt about what's on screen.
    This,
    Autopilot,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum IslandStep {
    /// Turning speech into text (and, in the cloud, everything after it).
    Transcribing,
    /// The AI is writing (cleanup, a prompt, an edit).
    Writing,
    /// Autopilot is reading the answer.
    Checking,
}

/// What failed, in the island's words (the frontend has the text).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum IslandError {
    SignIn,
    SessionEnded,
    NothingHeard,
    RateLimited,
    Quota,
    Network,
    Server,
    Provider,
    BadRequest,
    /// Autopilot has no prompt to compare against.
    NothingToCheck,
    /// Autopilot couldn't read an answer on screen.
    NoAnswerFound,
    PasteFailed,
    /// The question timed out on the server.
    AskExpired,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Type)]
pub struct IslandContext {
    pub chars: u32,
    pub source: ScreenSource,
    pub app: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IslandView {
    Hidden,
    Listening {
        mode: IslandMode,
        /// The spoken language setting ("en", "hi", … or "auto").
        language: String,
        /// This recording answers the question that was showing.
        answering: bool,
        /// Prompt modes: the AI the prompt is for ("Prompt for Claude").
        target: Option<String>,
        /// "This": what will go with the prompt.
        context: Option<IslandContext>,
    },
    Working {
        mode: IslandMode,
        step: IslandStep,
        /// The app the text is for, for "Writing for Claude…".
        target: Option<String>,
    },
    Ask {
        question: String,
        options: Vec<String>,
    },
    Done {
        mode: IslandMode,
        /// The start of what was pasted.
        preview: String,
        /// The backend's label, e.g. "Prompt · for Claude".
        label: Option<String>,
        memory: Vec<MemoryChip>,
        /// It was pasted (so ⌘Z can undo it), not just copied.
        pasted: bool,
    },
    Verdict {
        good: bool,
        issues: Vec<String>,
        has_fix: bool,
    },
    Error {
        error: IslandError,
        /// The server's own explanation, when it gave one.
        message: Option<String>,
        retry_after_sec: Option<u32>,
    },
    /// A Handy notice from the on-device pipeline (Private mode).
    Notice {
        notice: Notice,
    },
}

impl IslandView {
    /// A pill: no buttons, so the mouse passes through to the app below.
    pub fn is_compact(&self) -> bool {
        matches!(
            self,
            IslandView::Hidden | IslandView::Listening { .. } | IslandView::Working { .. }
        )
    }

    /// How long the view stays when the pointer isn't over it. `None`: until
    /// something replaces it.
    pub fn hold(&self) -> Option<Duration> {
        match self {
            IslandView::Done { .. } => Some(DONE_HOLD),
            IslandView::Verdict { good: true, .. } => Some(DONE_HOLD),
            IslandView::Verdict { .. } => Some(VERDICT_HOLD),
            IslandView::Error { .. } => Some(ERROR_HOLD),
            IslandView::Notice { .. } => Some(NOTICE_HOLD),
            IslandView::Ask { .. } => Some(ASK_HOLD),
            _ => None,
        }
    }

    pub fn height(&self) -> f64 {
        if self.is_compact() {
            COMPACT_HEIGHT
        } else {
            EXPANDED_HEIGHT
        }
    }
}

/// Where the island sits, so the frontend can draw it into the notch.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Type)]
pub struct IslandGeometry {
    /// The screen has a camera housing the island merges with.
    pub notch: bool,
    pub notch_width: f64,
    /// The notch's (and menu bar's) height; 0 without a notch.
    pub notch_height: f64,
}

impl Default for IslandGeometry {
    fn default() -> Self {
        IslandGeometry {
            notch: false,
            notch_width: 0.0,
            notch_height: 0.0,
        }
    }
}

#[derive(Serialize, Clone, Debug, Type, tauri_specta::Event)]
pub struct IslandEvent {
    pub id: u64,
    pub view: IslandView,
    pub geometry: IslandGeometry,
}

/// Sent while a held view is up: whether the pointer is over the card.
#[derive(Serialize, Deserialize, Clone, Debug, Type, tauri_specta::Event)]
pub struct IslandHover {
    pub id: u64,
    pub hovered: bool,
}

struct Runtime {
    id: u64,
    view: IslandView,
    geometry: IslandGeometry,
    /// The card's size as drawn, reported by the frontend, for hover.
    card: (f64, f64),
    /// The card's top-centre in global top-left points.
    anchor: Option<(f64, f64)>,
}

static STATE: Lazy<Mutex<Runtime>> = Lazy::new(|| {
    Mutex::new(Runtime {
        id: 0,
        view: IslandView::Hidden,
        geometry: IslandGeometry::default(),
        card: (0.0, 0.0),
        anchor: None,
    })
});

pub fn current() -> (u64, IslandView) {
    STATE
        .lock()
        .map(|s| (s.id, s.view.clone()))
        .unwrap_or((0, IslandView::Hidden))
}

pub fn current_geometry() -> IslandGeometry {
    STATE.lock().map(|s| s.geometry).unwrap_or_default()
}

pub fn current_id() -> u64 {
    current().0
}

/// Whether the island shows at all. Always on macOS; elsewhere it follows
/// the overlay setting (Linux defaults to none for WebKitGTK memory reasons).
pub fn enabled(app: &AppHandle) -> bool {
    cfg!(target_os = "macos")
        || crate::settings::get_settings(app).overlay_style != crate::settings::OverlayStyle::None
}

/// The mode and language of the recording in progress, for the on-device
/// pipeline's overlay calls (which don't know them).
static SESSION: Lazy<Mutex<(IslandMode, String)>> =
    Lazy::new(|| Mutex::new((IslandMode::Dictate, "auto".to_string())));

pub fn set_session(mode: IslandMode, language: &str) {
    if let Ok(mut s) = SESSION.lock() {
        *s = (mode, language.to_string());
    }
}

fn session() -> (IslandMode, String) {
    SESSION
        .lock()
        .map(|s| s.clone())
        .unwrap_or((IslandMode::Dictate, "auto".to_string()))
}

/// Listening, for the session set with `set_session`.
pub fn show_listening(app: &AppHandle) -> u64 {
    let (mode, language) = session();
    show(
        app,
        IslandView::Listening {
            mode,
            language,
            answering: false,
            target: None,
            context: None,
        },
    )
}

/// Working on the session set with `set_session`.
pub fn show_working(app: &AppHandle, step: IslandStep) -> u64 {
    show(
        app,
        IslandView::Working {
            mode: session().0,
            step,
            target: None,
        },
    )
}

/// Shows `view`, replacing whatever was there. Returns the view's id.
pub fn show(app: &AppHandle, view: IslandView) -> u64 {
    let id = {
        let Ok(mut s) = STATE.lock() else {
            return 0;
        };
        s.id += 1;
        s.view = view.clone();
        s.id
    };
    if !enabled(app) && view != IslandView::Hidden {
        return id;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || apply(&handle, id, view));
    id
}

/// Updates view `id` in place (same id, same size class), e.g. to add what a
/// listening prompt is for once that's known. Does nothing if it was replaced.
pub fn patch(app: &AppHandle, id: u64, update: impl FnOnce(&mut IslandView)) {
    let view = {
        let Ok(mut s) = STATE.lock() else {
            return;
        };
        if s.id != id {
            return;
        }
        update(&mut s.view);
        s.view.clone()
    };
    let geometry = current_geometry();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if current_id() != id {
            return;
        }
        let _ = IslandEvent { id, view, geometry }.emit(&handle);
    });
}

/// Hides the island if `id` is still the view on screen.
pub fn dismiss(app: &AppHandle, id: u64) {
    if current_id() == id {
        show(app, IslandView::Hidden);
    }
}

pub fn hide(app: &AppHandle) {
    if current().1 != IslandView::Hidden {
        show(app, IslandView::Hidden);
    }
}

/// The frontend's measured card size for view `id`.
pub fn set_card_size(id: u64, width: f64, height: f64) {
    if let Ok(mut s) = STATE.lock() {
        if s.id == id {
            s.card = (width, height);
        }
    }
}

fn apply(app: &AppHandle, id: u64, view: IslandView) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    if current_id() != id {
        return; // a newer view is already queued
    }
    let geometry = if view == IslandView::Hidden {
        STATE.lock().map(|s| s.geometry).unwrap_or_default()
    } else {
        let (geometry, anchor) = place(app, &window, view.height());
        if let Ok(mut s) = STATE.lock() {
            s.geometry = geometry;
            s.anchor = anchor;
            s.card = (0.0, 0.0);
        }
        geometry
    };
    let _ = window.set_ignore_cursor_events(view.is_compact());
    if view != IslandView::Hidden {
        let _ = window.show();
    }
    let event = IslandEvent {
        id,
        view: view.clone(),
        geometry,
    };
    if let Err(e) = event.emit(app) {
        log::warn!("Failed to update the island: {e}");
    }
    match view {
        IslandView::Hidden => {
            let handle = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(HIDE_DELAY);
                if current_id() == id {
                    if let Some(w) = handle.get_webview_window(WINDOW_LABEL) {
                        let _ = w.hide();
                    }
                }
            });
        }
        v => {
            if let Some(hold) = v.hold() {
                start_hold_timer(app.clone(), id, hold);
            }
        }
    }
}

/// Folds view `id` away after `hold`, pausing while the pointer is over it.
fn start_hold_timer(app: AppHandle, id: u64, hold: Duration) {
    std::thread::spawn(move || {
        let tick = Duration::from_millis(100);
        let mut remaining = hold;
        let mut was_hovered = false;
        let started = Instant::now();
        loop {
            std::thread::sleep(tick);
            if current_id() != id {
                return;
            }
            let hovered = pointer_over_card(&app);
            if hovered != was_hovered {
                was_hovered = hovered;
                let _ = IslandHover { id, hovered }.emit(&app);
            }
            if hovered {
                // Leaving restarts a short grace period instead of folding at once.
                remaining = remaining.max(Duration::from_millis(1500));
                continue;
            }
            remaining = remaining.saturating_sub(tick);
            if remaining.is_zero() || started.elapsed() > hold + Duration::from_secs(600) {
                dismiss(&app, id);
                return;
            }
        }
    });
}

fn pointer_over_card(app: &AppHandle) -> bool {
    let Some((x, y)) = crate::input::get_cursor_position(app) else {
        return false;
    };
    let Ok(s) = STATE.lock() else {
        return false;
    };
    let (Some((cx, top)), (w, h)) = (s.anchor, s.card) else {
        return false;
    };
    hit(cx, top, w, h, x as f64, y as f64)
}

/// Whether `(x, y)` is on a card of size `w`×`h` hanging from `(cx, top)`,
/// with a few points of slack so the edge doesn't flicker.
pub fn hit(cx: f64, top: f64, w: f64, h: f64, x: f64, y: f64) -> bool {
    const SLACK: f64 = 6.0;
    w > 0.0
        && h > 0.0
        && x >= cx - w / 2.0 - SLACK
        && x <= cx + w / 2.0 + SLACK
        && y >= top - SLACK
        && y <= top + h + SLACK
}

/// The panel's frame: centred at the top of the screen with the frontmost
/// window, flush with the top edge on a notched screen (so the card merges
/// with the notch), otherwise just under the menu bar. Returns the geometry
/// and the card's anchor (top-centre, global top-left points).
#[cfg(target_os = "macos")]
fn place(
    _app: &AppHandle,
    window: &tauri::WebviewWindow,
    height: f64,
) -> (IslandGeometry, Option<(f64, f64)>) {
    use objc2::{sel, MainThreadMarker};
    use objc2_app_kit::{NSScreen, NSWindow};
    use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect, NSSize};

    /// Gap under the menu bar on screens without a notch.
    const MENU_BAR_GAP: f64 = 6.0;

    let Some(mtm) = MainThreadMarker::new() else {
        return (IslandGeometry::default(), None);
    };
    let screens = NSScreen::screens(mtm);
    let Some(screen) = NSScreen::mainScreen(mtm).or_else(|| screens.firstObject()) else {
        return (IslandGeometry::default(), None);
    };
    let primary_height = screens
        .firstObject()
        .map(|s| s.frame().size.height)
        .unwrap_or_else(|| screen.frame().size.height);
    let frame = screen.frame();
    let visible = screen.visibleFrame();
    let top_edge = frame.origin.y + frame.size.height;

    // safeAreaInsets and the auxiliary areas exist from macOS 12.
    let (notch, notch_width, notch_height) = if screen.respondsToSelector(sel!(safeAreaInsets)) {
        let inset = screen.safeAreaInsets().top;
        if inset > 0.0 {
            let left = screen.auxiliaryTopLeftArea().size.width;
            let right = screen.auxiliaryTopRightArea().size.width;
            let width = (frame.size.width - left - right).max(0.0);
            (width > 0.0, width, inset)
        } else {
            (false, 0.0, 0.0)
        }
    } else {
        (false, 0.0, 0.0)
    };
    let menu_bar = (top_edge - (visible.origin.y + visible.size.height)).max(0.0);
    let card_top = if notch {
        top_edge
    } else {
        top_edge - menu_bar - MENU_BAR_GAP
    };
    let x = frame.origin.x + (frame.size.width - WINDOW_WIDTH) / 2.0;
    let rect = NSRect::new(
        NSPoint::new(x, card_top - height),
        NSSize::new(WINDOW_WIDTH, height),
    );
    if let Ok(ptr) = window.ns_window() {
        if !ptr.is_null() {
            // One atomic move-and-resize, so the card never jumps between states.
            let ns_window: &NSWindow = unsafe { &*ptr.cast::<NSWindow>() };
            ns_window.setFrame_display(rect, true);
        }
    }
    let anchor = (
        frame.origin.x + frame.size.width / 2.0,
        primary_height - card_top,
    );
    (
        IslandGeometry {
            notch,
            notch_width,
            notch_height: if notch { notch_height } else { 0.0 },
        },
        Some(anchor),
    )
}

#[cfg(not(target_os = "macos"))]
fn place(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    height: f64,
) -> (IslandGeometry, Option<(f64, f64)>) {
    let anchor = crate::overlay::place_island_window(app, window, WINDOW_WIDTH, height);
    (IslandGeometry::default(), anchor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pills_let_clicks_through_and_cards_take_them() {
        let listening = IslandView::Listening {
            mode: IslandMode::Engineer,
            language: "en".into(),
            answering: false,
            target: None,
            context: None,
        };
        assert!(listening.is_compact());
        assert!(listening.hold().is_none());
        assert_eq!(listening.height(), COMPACT_HEIGHT);
        let ask = IslandView::Ask {
            question: "Which language?".into(),
            options: vec!["Python".into()],
        };
        assert!(!ask.is_compact());
        assert_eq!(ask.height(), EXPANDED_HEIGHT);
        assert_eq!(ask.hold(), Some(ASK_HOLD));
    }

    #[test]
    fn results_fold_away_but_a_fix_waits() {
        let done = IslandView::Done {
            mode: IslandMode::Dictate,
            preview: "Hi".into(),
            label: None,
            memory: vec![],
            pasted: true,
        };
        assert_eq!(done.hold(), Some(DONE_HOLD));
        let good = IslandView::Verdict {
            good: true,
            issues: vec![],
            has_fix: false,
        };
        let missed = IslandView::Verdict {
            good: false,
            issues: vec!["x".into()],
            has_fix: true,
        };
        assert!(missed.hold() > good.hold());
    }

    #[test]
    fn views_serialize_with_a_kind_tag() {
        let v = serde_json::to_value(IslandView::Working {
            mode: IslandMode::This,
            step: IslandStep::Writing,
            target: Some("Claude".into()),
        })
        .unwrap();
        assert_eq!(v["kind"], "working");
        assert_eq!(v["mode"], "this");
        assert_eq!(v["step"], "writing");
        let hidden = serde_json::to_value(IslandView::Hidden).unwrap();
        assert_eq!(hidden, serde_json::json!({"kind": "hidden"}));
    }

    #[test]
    fn hover_hit_test() {
        // A 300×120 card hanging from (500, 0).
        assert!(hit(500.0, 0.0, 300.0, 120.0, 500.0, 60.0));
        assert!(hit(500.0, 0.0, 300.0, 120.0, 352.0, 2.0));
        assert!(!hit(500.0, 0.0, 300.0, 120.0, 300.0, 60.0));
        assert!(!hit(500.0, 0.0, 300.0, 120.0, 500.0, 140.0));
        assert!(!hit(500.0, 0.0, 0.0, 0.0, 500.0, 0.0), "unmeasured card");
    }
}
