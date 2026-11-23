//! Hold the Fn / 🌐 key to talk (the Wispr-style default).
//!
//! - Hold Fn: Write. Release to paste.
//! - Double-tap Fn and hold the second press, or hold Fn+Control: Prompt.
//! - Fn with another key (Fn+arrow, Fn+F5…) is left alone.
//!
//! macOS reports Fn only as a modifier change, so a listen-only event tap
//! on flagsChanged (and keyDown, to spot chords) watches it; it never
//! blocks or alters events. Recording starts a beat after the press, so a
//! quick tap or a chord never flashes the island. The tap needs
//! Accessibility; until that's granted it retries quietly.

// The gesture logic only runs on macOS (and in tests elsewhere).
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::{Duration, Instant};

/// A press this long becomes a recording; shorter is a tap.
pub const START_DELAY: Duration = Duration::from_millis(160);
/// The second press of a double tap must come this soon after the first.
pub const DOUBLE_TAP: Duration = Duration::from_millis(420);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FnMode {
    Write,
    Prompt,
}

impl FnMode {
    pub fn binding(self) -> &'static str {
        match self {
            FnMode::Write => "transcribe",
            FnMode::Prompt => "prompt_engineer",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Start a recording after `START_DELAY` unless the generation moved on.
    ScheduleStart {
        mode: FnMode,
        generation: u64,
    },
    Start(FnMode),
    Stop(FnMode),
    /// Drop the recording without pasting (Fn turned out to be a chord).
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    /// Down, recording not started yet.
    Pending {
        mode: FnMode,
    },
    Recording {
        mode: FnMode,
    },
    /// Down as part of a chord: ignored until released.
    Chord,
}

/// The gesture logic, free of timers and the OS so it can be tested.
#[derive(Debug)]
pub struct Gesture {
    state: State,
    generation: u64,
    last_tap: Option<Instant>,
}

impl Default for Gesture {
    fn default() -> Self {
        Gesture {
            state: State::Idle,
            generation: 0,
            last_tap: None,
        }
    }
}

impl Gesture {
    pub fn on_fn_down(&mut self, now: Instant, control: bool) -> Option<Action> {
        if self.state != State::Idle {
            return None; // a repeat
        }
        let double = self
            .last_tap
            .take()
            .is_some_and(|t| now.duration_since(t) <= DOUBLE_TAP);
        let mode = if control || double {
            FnMode::Prompt
        } else {
            FnMode::Write
        };
        self.generation += 1;
        self.state = State::Pending { mode };
        Some(Action::ScheduleStart {
            mode,
            generation: self.generation,
        })
    }

    /// The start delay for `generation` is over.
    pub fn on_timer(&mut self, generation: u64) -> Option<Action> {
        match self.state {
            State::Pending { mode } if generation == self.generation => {
                self.state = State::Recording { mode };
                Some(Action::Start(mode))
            }
            _ => None,
        }
    }

    pub fn on_fn_up(&mut self, now: Instant) -> Option<Action> {
        let state = std::mem::replace(&mut self.state, State::Idle);
        match state {
            State::Pending {
                mode: FnMode::Write,
            } => {
                // A tap: maybe the first of a double tap.
                self.last_tap = Some(now);
                None
            }
            State::Pending { .. } | State::Chord | State::Idle => None,
            State::Recording { mode } => Some(Action::Stop(mode)),
        }
    }

    /// What the keyboard says about Fn right now, from any event: a release
    /// the tap missed (it was briefly disabled, or the up event was lost)
    /// still ends the press.
    pub fn on_fn_state(&mut self, now: Instant, down: bool) -> Option<Action> {
        if down || self.state == State::Idle {
            return None;
        }
        self.on_fn_up(now)
    }

    /// Another key went down: Fn is part of a chord, not a talk press.
    pub fn on_other_key(&mut self) -> Option<Action> {
        self.last_tap = None;
        match self.state {
            State::Pending { .. } => {
                self.state = State::Chord;
                None
            }
            State::Recording { .. } => {
                self.state = State::Chord;
                Some(Action::Cancel)
            }
            State::Idle | State::Chord => None,
        }
    }
}

/// What macOS does when the 🌐/Fn key is pressed on its own
/// (System Settings → Keyboard → "Press 🌐 key to").
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum FnUsage {
    DoNothing,
    ChangeInputSource,
    ShowEmoji,
    StartDictation,
    Unknown,
}

impl FnUsage {
    /// `defaults read com.apple.HIToolbox AppleFnUsageType`.
    pub fn from_defaults(value: Option<&str>) -> FnUsage {
        match value.map(str::trim) {
            Some("0") => FnUsage::DoNothing,
            Some("1") => FnUsage::ChangeInputSource,
            Some("2") => FnUsage::ShowEmoji,
            Some("3") => FnUsage::StartDictation,
            // Unset: recent macOS shows the emoji picker.
            None => FnUsage::ShowEmoji,
            Some(_) => FnUsage::Unknown,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
pub struct FnKeyStatus {
    /// The tap is listening (Accessibility is granted and the setting is on).
    pub active: bool,
    pub usage: FnUsage,
}

pub fn usage() -> FnUsage {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "com.apple.HIToolbox", "AppleFnUsageType"])
            .output();
        match out {
            Ok(o) if o.status.success() => {
                FnUsage::from_defaults(Some(&String::from_utf8_lossy(&o.stdout)))
            }
            Ok(_) => FnUsage::from_defaults(None),
            Err(_) => FnUsage::Unknown,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        FnUsage::Unknown
    }
}

/// Whether the Fn key works and what macOS does with it on its own.
#[tauri::command]
#[specta::specta]
pub fn fn_key_status() -> FnKeyStatus {
    FnKeyStatus {
        active: is_active(),
        usage: usage(),
    }
}

/// Opens System Settings → Keyboard, where "Press 🌐 key to" lives.
#[tauri::command]
#[specta::specta]
pub fn open_keyboard_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("x-apple.systempreferences:com.apple.Keyboard-Settings.extension")
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Keyboard settings are macOS only".into())
    }
}

#[cfg(target_os = "macos")]
pub use platform::{init, is_active};

#[cfg(not(target_os = "macos"))]
pub fn init(_app: &tauri::AppHandle) {}

#[cfg(not(target_os = "macos"))]
pub fn is_active() -> bool {
    false
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Action, FnMode, Gesture, START_DELAY};
    use crate::settings::{get_settings, ShortcutActivation};
    use once_cell::sync::OnceCell;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};

    type CFMachPortRef = *mut c_void;
    type CFRunLoopSourceRef = *mut c_void;
    type CFRunLoopRef = *mut c_void;
    type CGEventRef = *mut c_void;
    type CGEventTapProxy = *mut c_void;
    type TapCallback = extern "C" fn(CGEventTapProxy, u32, CGEventRef, *mut c_void) -> CGEventRef;

    const SESSION_TAP: u32 = 1;
    const HEAD_INSERT: u32 = 0;
    const LISTEN_ONLY: u32 = 1;
    const KEY_DOWN: u32 = 10;
    const FLAGS_CHANGED: u32 = 12;
    const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const TAP_DISABLED_BY_USER: u32 = 0xFFFF_FFFF;
    const FLAG_FN: u64 = 0x0080_0000;
    const FLAG_CONTROL: u64 = 0x0004_0000;
    /// Shift, Option, Command.
    const OTHER_MODIFIERS: u64 = 0x0002_0000 | 0x0008_0000 | 0x0010_0000;
    const FIELD_KEYCODE: u32 = 9;
    const KEYCODE_FN: i64 = 63;
    /// kCGEventSourceStateCombinedSessionState.
    const COMBINED_SESSION_STATE: i32 = 0;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: TapCallback,
            user_info: *mut c_void,
        ) -> CFMachPortRef;
        fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
        fn CGEventGetFlags(event: CGEventRef) -> u64;
        fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
        fn CGEventSourceFlagsState(state_id: i32) -> u64;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFRunLoopCommonModes: *const c_void;
        fn CFMachPortCreateRunLoopSource(
            alloc: *const c_void,
            port: CFMachPortRef,
            order: isize,
        ) -> CFRunLoopSourceRef;
        fn CFRunLoopGetCurrent() -> CFRunLoopRef;
        fn CFRunLoopAddSource(rl: CFRunLoopRef, source: CFRunLoopSourceRef, mode: *const c_void);
        fn CFRunLoopRun();
    }

    static APP: OnceCell<AppHandle> = OnceCell::new();
    static GESTURE: Mutex<Option<Gesture>> = Mutex::new(None);
    static FN_DOWN: AtomicBool = AtomicBool::new(false);
    static ACTIVE: AtomicBool = AtomicBool::new(false);
    static TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    pub fn is_active() -> bool {
        ACTIVE.load(Ordering::Relaxed)
    }

    fn enabled() -> bool {
        APP.get().is_some_and(|app| get_settings(app).flow.fn_key)
    }

    /// Updates the gesture and carries out what it decided while still
    /// holding the lock, so a Start and the Stop that follows it always
    /// reach the coordinator in that order (queuing them doesn't block).
    fn step(f: impl FnOnce(&mut Gesture) -> Option<Action>) {
        let mut g = GESTURE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(action) = f(g.get_or_insert_with(Gesture::default)) {
            run(action);
        }
    }

    /// Whether Fn is held right now, asked of the keyboard state itself.
    fn fn_held_now() -> bool {
        unsafe { CGEventSourceFlagsState(COMBINED_SESSION_STATE) & FLAG_FN != 0 }
    }

    fn run(action: Action) {
        let Some(app) = APP.get().cloned() else {
            return;
        };
        match action {
            Action::ScheduleStart { generation, .. } => {
                std::thread::spawn(move || {
                    std::thread::sleep(START_DELAY);
                    let held = fn_held_now();
                    step(|g| {
                        // Released in the meantime without our seeing it:
                        // it was a tap, not a talk press.
                        if !held {
                            FN_DOWN.store(false, Ordering::Relaxed);
                            return g.on_fn_state(Instant::now(), false);
                        }
                        g.on_timer(generation)
                    });
                });
            }
            Action::Start(mode) => send(&app, mode, true),
            Action::Stop(mode) => send(&app, mode, false),
            Action::Cancel => {
                let _ = app.run_on_main_thread({
                    let app = app.clone();
                    move || crate::utils::cancel_current_operation(&app)
                });
            }
        }
    }

    /// Press or release the mode's shortcut, as push-to-talk.
    fn send(app: &AppHandle, mode: FnMode, pressed: bool) {
        if let Some(c) = app.try_state::<crate::TranscriptionCoordinator>() {
            let settings = get_settings(app);
            c.send_input(
                mode.binding(),
                "fn",
                pressed,
                ShortcutActivation::PushToTalk,
                Duration::from_millis(settings.hold_threshold_ms),
            );
        }
    }

    extern "C" fn callback(
        _proxy: CGEventTapProxy,
        kind: u32,
        event: CGEventRef,
        _user: *mut c_void,
    ) -> CGEventRef {
        if kind == TAP_DISABLED_BY_TIMEOUT || kind == TAP_DISABLED_BY_USER {
            let tap = TAP.load(Ordering::Relaxed);
            if !tap.is_null() {
                unsafe { CGEventTapEnable(tap, true) };
            }
            // Events were missed while the tap was off: if Fn came up
            // meanwhile, end the press now.
            if !fn_held_now() && FN_DOWN.swap(false, Ordering::Relaxed) {
                step(|g| g.on_fn_state(Instant::now(), false));
            }
            return event;
        }
        if event.is_null() || crate::cloud::is_paused() {
            return event;
        }
        let now = Instant::now();
        match kind {
            FLAGS_CHANGED => {
                let flags = unsafe { CGEventGetFlags(event) };
                let keycode = unsafe { CGEventGetIntegerValueField(event, FIELD_KEYCODE) };
                let fn_down = flags & FLAG_FN != 0;
                if keycode == KEYCODE_FN {
                    let was_down = FN_DOWN.swap(fn_down, Ordering::Relaxed);
                    // The setting is read only here, on Fn itself, never on
                    // ordinary typing.
                    if fn_down && !was_down && enabled() {
                        step(|g| g.on_fn_down(now, flags & FLAG_CONTROL != 0));
                    } else if !fn_down && was_down {
                        step(|g| g.on_fn_up(now));
                    }
                } else if FN_DOWN.load(Ordering::Relaxed) {
                    if !fn_down {
                        // Fn's own release was missed; this event says it's up.
                        FN_DOWN.store(false, Ordering::Relaxed);
                        step(|g| g.on_fn_state(now, false));
                    } else if flags & OTHER_MODIFIERS != 0 {
                        // Shift, Option or Command with Fn is a shortcut, not a
                        // talk press. Control joining in is fine (Fn+Control).
                        step(|g| g.on_other_key());
                    }
                }
            }
            KEY_DOWN if FN_DOWN.load(Ordering::Relaxed) => step(|g| g.on_other_key()),
            _ => {}
        }
        event
    }

    /// Starts the tap on its own thread, retrying until Accessibility is
    /// granted.
    pub fn init(app: &AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        std::thread::Builder::new()
            .name("fn-key".into())
            .spawn(|| loop {
                let mask = (1u64 << FLAGS_CHANGED) | (1u64 << KEY_DOWN);
                let tap = unsafe {
                    CGEventTapCreate(
                        SESSION_TAP,
                        HEAD_INSERT,
                        LISTEN_ONLY,
                        mask,
                        callback,
                        std::ptr::null_mut(),
                    )
                };
                if tap.is_null() {
                    std::thread::sleep(Duration::from_secs(3));
                    continue;
                }
                TAP.store(tap, Ordering::Relaxed);
                unsafe {
                    let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
                    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
                    CGEventTapEnable(tap, true);
                }
                ACTIVE.store(true, Ordering::Relaxed);
                log::info!("Fn key listener started");
                unsafe { CFRunLoopRun() };
                ACTIVE.store(false, Ordering::Relaxed);
                log::warn!("Fn key listener stopped; restarting");
                std::thread::sleep(Duration::from_secs(3));
            })
            .map(|_| ())
            .unwrap_or_else(|e| log::error!("Could not start the Fn key listener: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(base: Instant, n: u64) -> Instant {
        base + Duration::from_millis(n)
    }

    #[test]
    fn hold_writes() {
        let t = Instant::now();
        let mut g = Gesture::default();
        let Some(Action::ScheduleStart { mode, generation }) = g.on_fn_down(t, false) else {
            panic!("expected a scheduled start");
        };
        assert_eq!(mode, FnMode::Write);
        assert_eq!(g.on_timer(generation), Some(Action::Start(FnMode::Write)));
        assert_eq!(g.on_fn_up(ms(t, 2000)), Some(Action::Stop(FnMode::Write)));
    }

    #[test]
    fn a_tap_records_nothing() {
        let t = Instant::now();
        let mut g = Gesture::default();
        let Some(Action::ScheduleStart { generation, .. }) = g.on_fn_down(t, false) else {
            panic!();
        };
        assert_eq!(g.on_fn_up(ms(t, 90)), None);
        assert_eq!(g.on_timer(generation), None, "the delayed start is dropped");
    }

    #[test]
    fn double_tap_and_hold_prompts() {
        let t = Instant::now();
        let mut g = Gesture::default();
        g.on_fn_down(t, false);
        g.on_fn_up(ms(t, 90));
        let Some(Action::ScheduleStart { mode, generation }) = g.on_fn_down(ms(t, 250), false)
        else {
            panic!();
        };
        assert_eq!(mode, FnMode::Prompt);
        assert_eq!(g.on_timer(generation), Some(Action::Start(FnMode::Prompt)));
        assert_eq!(g.on_fn_up(ms(t, 3000)), Some(Action::Stop(FnMode::Prompt)));
    }

    #[test]
    fn slow_second_tap_is_a_new_write() {
        let t = Instant::now();
        let mut g = Gesture::default();
        g.on_fn_down(t, false);
        g.on_fn_up(ms(t, 90));
        let action = g.on_fn_down(ms(t, 90 + DOUBLE_TAP.as_millis() as u64 + 50), false);
        assert!(matches!(
            action,
            Some(Action::ScheduleStart {
                mode: FnMode::Write,
                ..
            })
        ));
    }

    #[test]
    fn fn_control_prompts() {
        let mut g = Gesture::default();
        assert!(matches!(
            g.on_fn_down(Instant::now(), true),
            Some(Action::ScheduleStart {
                mode: FnMode::Prompt,
                ..
            })
        ));
    }

    #[test]
    fn chords_are_left_alone() {
        let t = Instant::now();
        let mut g = Gesture::default();
        // Fn+Left before the start delay: never records.
        let Some(Action::ScheduleStart { generation, .. }) = g.on_fn_down(t, false) else {
            panic!();
        };
        assert_eq!(g.on_other_key(), None);
        assert_eq!(g.on_timer(generation), None);
        assert_eq!(g.on_fn_up(ms(t, 400)), None);
        // A chord after recording started cancels it.
        let Some(Action::ScheduleStart { generation, .. }) = g.on_fn_down(ms(t, 2000), false)
        else {
            panic!();
        };
        g.on_timer(generation);
        assert_eq!(g.on_other_key(), Some(Action::Cancel));
        assert_eq!(g.on_fn_up(ms(t, 3000)), None);
    }

    #[test]
    fn a_missed_release_still_ends_the_press() {
        let t = Instant::now();
        let mut g = Gesture::default();
        let Some(Action::ScheduleStart { generation, .. }) = g.on_fn_down(t, false) else {
            panic!();
        };
        g.on_timer(generation);
        assert_eq!(g.on_fn_state(ms(t, 1500), true), None);
        assert_eq!(
            g.on_fn_state(ms(t, 1600), false),
            Some(Action::Stop(FnMode::Write))
        );
        // Nothing to end when idle.
        assert_eq!(g.on_fn_state(ms(t, 1700), false), None);
    }

    #[test]
    fn a_release_before_the_start_never_records() {
        // The start timer finds Fn up: treated as the release it was.
        let t = Instant::now();
        let mut g = Gesture::default();
        let Some(Action::ScheduleStart { generation, .. }) = g.on_fn_down(t, false) else {
            panic!();
        };
        assert_eq!(g.on_fn_up(ms(t, 150)), None);
        assert_eq!(g.on_timer(generation), None);
    }

    #[test]
    fn key_repeat_is_ignored() {
        let t = Instant::now();
        let mut g = Gesture::default();
        assert!(g.on_fn_down(t, false).is_some());
        assert!(g.on_fn_down(ms(t, 30), false).is_none());
    }

    #[test]
    fn fn_usage_from_defaults() {
        assert_eq!(FnUsage::from_defaults(Some("0\n")), FnUsage::DoNothing);
        assert_eq!(FnUsage::from_defaults(Some("2")), FnUsage::ShowEmoji);
        assert_eq!(FnUsage::from_defaults(Some("3")), FnUsage::StartDictation);
        assert_eq!(FnUsage::from_defaults(None), FnUsage::ShowEmoji);
        assert_eq!(FnUsage::from_defaults(Some("9")), FnUsage::Unknown);
    }
}
