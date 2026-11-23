//! The Fn / 🌐 key: Smart dictation.
//!
//! - Hold Fn and talk, release to finish: PromptFlow writes it right for
//!   the app (a prompt in AI apps and code editors, a message everywhere
//!   else, an edit when text is selected).
//! - Double-tap Fn: hands-free. Recording stays on until Fn is tapped
//!   again (or Esc cancels).
//! - Fn with another key (Fn+arrow, Fn+F5…) is left alone.
//!
//! macOS reports Fn only as a modifier change, so a listen-only event tap
//! on flagsChanged (and keyDown, to spot chords) watches it; it never
//! blocks or alters events. A hold starts recording a beat after the press,
//! so a quick tap or a chord never flashes the island. The tap needs
//! Accessibility (and Input Monitoring on recent macOS); until they're
//! granted it retries quietly.

// The gesture logic only runs on macOS (and in tests elsewhere).
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::{Duration, Instant};

/// A press this long becomes a recording; shorter is a tap.
pub const START_DELAY: Duration = Duration::from_millis(160);
/// The second press of a double tap must come this soon after the first.
pub const DOUBLE_TAP: Duration = Duration::from_millis(420);
/// A hands-free recording that isn't running this long after it started
/// was ended some other way (Esc, an error): the next press starts fresh.
pub const HANDS_FREE_GRACE: Duration = Duration::from_millis(1500);

/// The binding the Fn key drives.
pub const BINDING: &str = "smart";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Start a recording after `START_DELAY` unless the generation moved on.
    ScheduleStart { generation: u64 },
    /// A hold began: record while Fn is down.
    Start,
    /// The hold ended.
    Stop,
    /// A double tap: record until Fn is tapped again.
    StartHandsFree,
    /// The tap that ends hands-free.
    StopHandsFree,
    /// Drop the recording without pasting (Fn turned out to be a chord).
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    /// Down, recording not started yet.
    Pending,
    /// Recording while held.
    Holding,
    /// Recording hands-free. `down`: the second tap is still held.
    HandsFree {
        down: bool,
        since: Instant,
    },
    /// Hands-free, and Fn is down to end it: it ends on release.
    Ending {
        since: Instant,
    },
    /// Down as part of a chord (or a press macOS uses for something else):
    /// ignored until released.
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
    /// Fn went down. `recording`: a recording is running right now, so a
    /// state that expects one but finds none was ended elsewhere (Esc).
    pub fn on_fn_down(&mut self, now: Instant, recording: bool) -> Option<Action> {
        let stale = match self.state {
            State::Holding => !recording,
            State::HandsFree { down: false, since } => {
                !recording && now.duration_since(since) > HANDS_FREE_GRACE
            }
            _ => false,
        };
        if stale {
            self.state = State::Idle;
            self.last_tap = None;
        }
        match self.state {
            State::Idle => {
                let double = self
                    .last_tap
                    .take()
                    .is_some_and(|t| now.duration_since(t) <= DOUBLE_TAP);
                if double {
                    self.state = State::HandsFree {
                        down: true,
                        since: now,
                    };
                    return Some(Action::StartHandsFree);
                }
                self.generation += 1;
                self.state = State::Pending;
                Some(Action::ScheduleStart {
                    generation: self.generation,
                })
            }
            State::HandsFree { down: false, since } => {
                self.state = State::Ending { since };
                None
            }
            // A repeat, or the key is already part of something.
            _ => None,
        }
    }

    /// The start delay for `generation` is over.
    pub fn on_timer(&mut self, generation: u64) -> Option<Action> {
        match self.state {
            State::Pending if generation == self.generation => {
                self.state = State::Holding;
                Some(Action::Start)
            }
            _ => None,
        }
    }

    /// The press for `generation` can't record (macOS uses 🌐 for
    /// something else): ignore it until Fn comes up.
    pub fn on_blocked(&mut self, generation: u64) {
        if self.state == State::Pending && generation == self.generation {
            self.state = State::Chord;
        }
    }

    /// A double tap that can't record (macOS uses 🌐): ignore it until Fn
    /// comes up, so the next tap doesn't count as "finish".
    pub fn block_hands_free(&mut self) {
        if matches!(self.state, State::HandsFree { .. }) {
            self.state = State::Chord;
        }
    }

    pub fn on_fn_up(&mut self, now: Instant) -> Option<Action> {
        let state = std::mem::replace(&mut self.state, State::Idle);
        match state {
            State::Pending => {
                // A tap: maybe the first of a double tap.
                self.last_tap = Some(now);
                None
            }
            State::Holding => Some(Action::Stop),
            State::HandsFree { since, .. } => {
                self.state = State::HandsFree { down: false, since };
                None
            }
            State::Ending { .. } => Some(Action::StopHandsFree),
            State::Chord | State::Idle => None,
        }
    }

    /// What the keyboard says about Fn right now, from any event: a release
    /// the tap missed (it was briefly disabled, or the up event was lost)
    /// still ends the press.
    pub fn on_fn_state(&mut self, now: Instant, down: bool) -> Option<Action> {
        match self.state {
            _ if down => None,
            State::Idle | State::HandsFree { down: false, .. } => None,
            _ => self.on_fn_up(now),
        }
    }

    /// Another key went down while Fn is: Fn is part of a chord.
    pub fn on_other_key(&mut self) -> Option<Action> {
        self.last_tap = None;
        match self.state {
            State::Pending => {
                self.state = State::Chord;
                None
            }
            State::Holding | State::HandsFree { down: true, .. } => {
                self.state = State::Chord;
                Some(Action::Cancel)
            }
            // Fn+arrow while dictating hands-free: keep recording.
            State::Ending { since } => {
                self.state = State::HandsFree { down: true, since };
                None
            }
            State::Idle | State::Chord | State::HandsFree { down: false, .. } => None,
        }
    }

    /// Recording hands-free (so the island can say "tap Fn to finish").
    pub fn hands_free(&self) -> bool {
        matches!(self.state, State::HandsFree { .. } | State::Ending { .. })
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

/// What to tell the user when Fn is pressed and macOS also uses it: `None`
/// when 🌐 does nothing on its own (or the setting can't be read, so as
/// never to block Fn on a guess).
pub fn conflict(usage: FnUsage) -> Option<crate::island::IslandError> {
    match usage {
        FnUsage::DoNothing | FnUsage::Unknown => None,
        FnUsage::ChangeInputSource | FnUsage::ShowEmoji | FnUsage::StartDictation => {
            Some(crate::island::IslandError::FnConflict)
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
pub struct FnKeyStatus {
    /// The tap is listening (permissions granted and the setting is on).
    pub active: bool,
    pub usage: FnUsage,
    /// macOS lets PromptFlow watch the keyboard (Input Monitoring).
    pub input_monitoring: bool,
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
        input_monitoring: input_monitoring_allowed(),
    }
}

/// Opens System Settings → Keyboard, where "Press 🌐 key to" lives.
#[tauri::command]
#[specta::specta]
pub fn open_keyboard_settings() -> Result<(), String> {
    open_settings_url("x-apple.systempreferences:com.apple.Keyboard-Settings.extension")
}

/// Opens Keyboard → Keyboard Shortcuts, where Spotlight's ⌘Space is turned
/// off. PromptFlow never changes system settings itself.
#[tauri::command]
#[specta::specta]
pub fn open_keyboard_shortcuts() -> Result<(), String> {
    open_settings_url("x-apple.systempreferences:com.apple.preference.keyboard?Shortcuts")
}

fn open_settings_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("Keyboard settings are macOS only".into())
    }
}

/// Spotlight's "Show Spotlight search" (symbolic hot key 64) is on and
/// bound to ⌘Space, read from `defaults export com.apple.symbolichotkeys -`.
/// Anything missing means macOS's default: on, ⌘Space.
pub fn spotlight_on_cmd_space(plist_xml: Option<&[u8]>) -> bool {
    /// Space's key code, and the Command modifier.
    const SPACE: i64 = 49;
    const COMMAND: i64 = 1 << 20;
    let Some(bytes) = plist_xml else {
        return true;
    };
    let Ok(root) = plist::Value::from_reader(std::io::Cursor::new(bytes)) else {
        return true;
    };
    let Some(entry) = root
        .as_dictionary()
        .and_then(|d| d.get("AppleSymbolicHotKeys"))
        .and_then(|v| v.as_dictionary())
        .and_then(|d| d.get("64"))
        .and_then(|v| v.as_dictionary())
    else {
        return true;
    };
    let enabled = match entry.get("enabled") {
        Some(plist::Value::Boolean(b)) => *b,
        Some(plist::Value::Integer(i)) => i.as_signed() != Some(0),
        _ => true,
    };
    if !enabled {
        return false;
    }
    let params: Vec<i64> = entry
        .get("value")
        .and_then(|v| v.as_dictionary())
        .and_then(|d| d.get("parameters"))
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|p| p.as_signed_integer()).collect())
        .unwrap_or_default();
    match params.as_slice() {
        [_, key, modifiers, ..] => *key == SPACE && *modifiers == COMMAND,
        _ => true,
    }
}

/// Whether Spotlight still owns ⌘Space, so PromptFlow's ⌘Space can't work
/// until the user turns Spotlight's shortcut off.
#[tauri::command]
#[specta::specta]
pub fn spotlight_owns_cmd_space() -> bool {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/bin/defaults")
            .args(["export", "com.apple.symbolichotkeys", "-"])
            .output();
        match out {
            Ok(o) if o.status.success() => spotlight_on_cmd_space(Some(&o.stdout)),
            _ => spotlight_on_cmd_space(None),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Asks macOS for Input Monitoring (the prompt appears once; after that the
/// System Settings pane is the only way).
#[tauri::command]
#[specta::specta]
pub fn request_input_monitoring() {
    #[cfg(target_os = "macos")]
    {
        if !platform::request_listen_access() {
            let _ = open_settings_url(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
            );
        }
    }
}

#[cfg(target_os = "macos")]
pub use platform::{init, input_monitoring_allowed, is_active};

#[cfg(not(target_os = "macos"))]
pub fn init(_app: &tauri::AppHandle) {}

#[cfg(not(target_os = "macos"))]
pub fn is_active() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn input_monitoring_allowed() -> bool {
    true
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{Action, Gesture, BINDING, START_DELAY};
    use crate::settings::{get_settings, ShortcutActivation};
    use once_cell::sync::OnceCell;
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU8, Ordering};
    use std::sync::{Arc, Mutex};
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
    /// Control, Shift, Option, Command: Fn with any of them is a shortcut
    /// (Fn+Control+arrow…), not a talk press.
    const OTHER_MODIFIERS: u64 = 0x0004_0000 | 0x0002_0000 | 0x0008_0000 | 0x0010_0000;
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
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
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
    /// The last "Press 🌐 key to" check: 0 unknown, 1 fine, 2 conflicts.
    static CONFLICT: AtomicU8 = AtomicU8::new(0);

    pub fn is_active() -> bool {
        ACTIVE.load(Ordering::Relaxed)
    }

    pub fn input_monitoring_allowed() -> bool {
        unsafe { CGPreflightListenEventAccess() }
    }

    /// Shows macOS's Input Monitoring prompt; `true` if already allowed.
    pub fn request_listen_access() -> bool {
        unsafe { CGRequestListenEventAccess() }
    }

    /// Fn is on, and no new shortcut is being recorded in Settings.
    fn enabled() -> bool {
        !crate::shortcut::status::capturing()
            && APP.get().is_some_and(|app| get_settings(app).flow.fn_key)
    }

    fn recording() -> bool {
        APP.get().is_some_and(|app| {
            app.try_state::<Arc<crate::managers::audio::AudioRecordingManager>>()
                .is_some_and(|rm| rm.is_recording())
        })
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

    /// Reads "Press 🌐 key to" (a short subprocess, so never on the tap's
    /// thread) and remembers whether it gets in the way.
    fn check_conflict() -> Option<crate::island::IslandError> {
        let found = super::conflict(super::usage());
        CONFLICT.store(if found.is_some() { 2 } else { 1 }, Ordering::Relaxed);
        found
    }

    fn show_conflict(app: &AppHandle, error: crate::island::IslandError) {
        log::info!("Fn pressed, but macOS uses 🌐 for something else; showing the fix");
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || {
            crate::cloud::pipeline::show_error(&app, error);
        });
    }

    fn run(action: Action) {
        let Some(app) = APP.get().cloned() else {
            return;
        };
        match action {
            Action::ScheduleStart { generation } => {
                std::thread::spawn(move || {
                    let started = Instant::now();
                    let conflict = check_conflict();
                    std::thread::sleep(START_DELAY.saturating_sub(started.elapsed()));
                    let held = fn_held_now();
                    if held {
                        if let Some(error) = conflict {
                            step(|g| {
                                g.on_blocked(generation);
                                None
                            });
                            show_conflict(&app, error);
                            return;
                        }
                    }
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
            Action::Start => send(&app, true, ShortcutActivation::PushToTalk),
            Action::Stop => send(&app, false, ShortcutActivation::PushToTalk),
            Action::StartHandsFree => send(&app, true, ShortcutActivation::Toggle),
            Action::StopHandsFree => send(&app, true, ShortcutActivation::Toggle),
            Action::Cancel => {
                let _ = app.run_on_main_thread({
                    let app = app.clone();
                    move || crate::utils::cancel_current_operation(&app)
                });
            }
        }
    }

    /// A press or release of Smart: push-to-talk for a hold, a toggle for
    /// hands-free.
    fn send(app: &AppHandle, pressed: bool, activation: ShortcutActivation) {
        if crate::cloud::is_paused() {
            if pressed {
                crate::cloud::pipeline::show_error(app, crate::island::IslandError::Paused);
            }
            return;
        }
        if let Some(c) = app.try_state::<crate::TranscriptionCoordinator>() {
            let settings = get_settings(app);
            c.send_input(
                BINDING,
                "fn",
                pressed,
                activation,
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
            log::warn!(
                "Fn key listener was turned off by macOS ({}); turning it back on",
                if kind == TAP_DISABLED_BY_TIMEOUT {
                    "timeout"
                } else {
                    "user input"
                }
            );
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
        if event.is_null() {
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
                    // ordinary typing. Fn with a modifier already held
                    // (Control+Fn+arrow) is a shortcut.
                    if fn_down && !was_down && enabled() && flags & OTHER_MODIFIERS == 0 {
                        let recording = recording();
                        step(|g| {
                            let action = g.on_fn_down(now, recording);
                            // The first tap's check ran a moment ago.
                            if action == Some(Action::StartHandsFree)
                                && CONFLICT.load(Ordering::Relaxed) == 2
                            {
                                g.block_hands_free();
                                if let Some(app) = APP.get() {
                                    show_conflict(app, crate::island::IslandError::FnConflict);
                                }
                                return None;
                            }
                            action
                        });
                    } else if !fn_down && was_down {
                        step(|g| g.on_fn_up(now));
                    }
                } else if FN_DOWN.load(Ordering::Relaxed) {
                    if !fn_down {
                        // Fn's own release was missed; this event says it's up.
                        FN_DOWN.store(false, Ordering::Relaxed);
                        step(|g| g.on_fn_state(now, false));
                    } else if flags & OTHER_MODIFIERS != 0 {
                        step(|g| g.on_other_key());
                    }
                }
            }
            KEY_DOWN if FN_DOWN.load(Ordering::Relaxed) => step(|g| g.on_other_key()),
            _ => {}
        }
        event
    }

    /// Starts the tap on its own thread, retrying until macOS allows it.
    pub fn init(app: &AppHandle) {
        if APP.set(app.clone()).is_err() {
            return;
        }
        std::thread::Builder::new()
            .name("fn-key".into())
            .spawn(|| {
                let mut warned = false;
                loop {
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
                        if !warned {
                            log::warn!(
                                "Fn key listener can't start yet (Accessibility {}, Input Monitoring {}); retrying",
                                crate::permissions::accessibility_trusted(),
                                input_monitoring_allowed()
                            );
                            warned = true;
                        }
                        std::thread::sleep(Duration::from_secs(3));
                        continue;
                    }
                    warned = false;
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
                }
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

    fn scheduled(a: Option<Action>) -> u64 {
        match a {
            Some(Action::ScheduleStart { generation }) => generation,
            other => panic!("expected a scheduled start, got {other:?}"),
        }
    }

    #[test]
    fn hold_is_smart_push_to_talk() {
        let t = Instant::now();
        let mut g = Gesture::default();
        let gen = scheduled(g.on_fn_down(t, false));
        assert_eq!(g.on_timer(gen), Some(Action::Start));
        assert!(!g.hands_free());
        assert_eq!(g.on_fn_up(ms(t, 2000)), Some(Action::Stop));
    }

    #[test]
    fn a_tap_records_nothing() {
        let t = Instant::now();
        let mut g = Gesture::default();
        let gen = scheduled(g.on_fn_down(t, false));
        assert_eq!(g.on_fn_up(ms(t, 90)), None);
        assert_eq!(g.on_timer(gen), None, "the delayed start is dropped");
    }

    #[test]
    fn double_tap_is_hands_free_until_the_next_tap() {
        let t = Instant::now();
        let mut g = Gesture::default();
        g.on_fn_down(t, false);
        g.on_fn_up(ms(t, 90));
        assert_eq!(
            g.on_fn_down(ms(t, 250), false),
            Some(Action::StartHandsFree)
        );
        assert!(g.hands_free());
        // Letting go of the second tap keeps recording.
        assert_eq!(g.on_fn_up(ms(t, 330)), None);
        assert!(g.hands_free());
        // Talking for a while; the next tap ends it on release.
        assert_eq!(g.on_fn_down(ms(t, 9000), true), None);
        assert_eq!(g.on_fn_up(ms(t, 9080)), Some(Action::StopHandsFree));
        assert!(!g.hands_free());
        // And the tap that ended it doesn't count towards a new double tap.
        assert!(matches!(
            g.on_fn_down(ms(t, 9200), false),
            Some(Action::ScheduleStart { .. })
        ));
    }

    #[test]
    fn hands_free_ended_by_esc_starts_fresh() {
        let t = Instant::now();
        let mut g = Gesture::default();
        g.on_fn_down(t, false);
        g.on_fn_up(ms(t, 90));
        g.on_fn_down(ms(t, 250), false);
        g.on_fn_up(ms(t, 330));
        // Esc cancelled it: no recording when Fn is next pressed.
        assert!(matches!(
            g.on_fn_down(ms(t, 6000), false),
            Some(Action::ScheduleStart { .. })
        ));
    }

    #[test]
    fn fn_arrow_while_hands_free_keeps_recording() {
        let t = Instant::now();
        let mut g = Gesture::default();
        g.on_fn_down(t, false);
        g.on_fn_up(ms(t, 90));
        g.on_fn_down(ms(t, 250), false);
        g.on_fn_up(ms(t, 330));
        assert_eq!(g.on_fn_down(ms(t, 3000), true), None);
        assert_eq!(g.on_other_key(), None);
        assert_eq!(g.on_fn_up(ms(t, 3200)), None);
        assert!(g.hands_free());
    }

    #[test]
    fn slow_second_tap_is_a_new_hold() {
        let t = Instant::now();
        let mut g = Gesture::default();
        g.on_fn_down(t, false);
        g.on_fn_up(ms(t, 90));
        let action = g.on_fn_down(ms(t, 90 + DOUBLE_TAP.as_millis() as u64 + 50), false);
        assert!(matches!(action, Some(Action::ScheduleStart { .. })));
    }

    #[test]
    fn chords_are_left_alone() {
        let t = Instant::now();
        let mut g = Gesture::default();
        // Fn+Left before the start delay: never records.
        let gen = scheduled(g.on_fn_down(t, false));
        assert_eq!(g.on_other_key(), None);
        assert_eq!(g.on_timer(gen), None);
        assert_eq!(g.on_fn_up(ms(t, 400)), None);
        // A chord after recording started cancels it.
        let gen = scheduled(g.on_fn_down(ms(t, 2000), false));
        g.on_timer(gen);
        assert_eq!(g.on_other_key(), Some(Action::Cancel));
        assert_eq!(g.on_fn_up(ms(t, 3000)), None);
    }

    #[test]
    fn a_press_macos_uses_never_records() {
        let t = Instant::now();
        let mut g = Gesture::default();
        let gen = scheduled(g.on_fn_down(t, false));
        g.on_blocked(gen);
        assert_eq!(g.on_timer(gen), None);
        assert_eq!(g.on_fn_up(ms(t, 900)), None);
    }

    #[test]
    fn a_blocked_double_tap_never_records() {
        let t = Instant::now();
        let mut g = Gesture::default();
        g.on_fn_down(t, false);
        g.on_fn_up(ms(t, 90));
        assert_eq!(
            g.on_fn_down(ms(t, 250), false),
            Some(Action::StartHandsFree)
        );
        g.block_hands_free();
        assert!(!g.hands_free());
        assert_eq!(g.on_fn_up(ms(t, 330)), None);
        // The next press is a fresh one, not "finish".
        assert!(matches!(
            g.on_fn_down(ms(t, 900), false),
            Some(Action::ScheduleStart { .. })
        ));
    }

    #[test]
    fn a_missed_release_still_ends_the_press() {
        let t = Instant::now();
        let mut g = Gesture::default();
        let gen = scheduled(g.on_fn_down(t, false));
        g.on_timer(gen);
        assert_eq!(g.on_fn_state(ms(t, 1500), true), None);
        assert_eq!(g.on_fn_state(ms(t, 1600), false), Some(Action::Stop));
        // Nothing to end when idle.
        assert_eq!(g.on_fn_state(ms(t, 1700), false), None);
    }

    #[test]
    fn a_hold_that_lost_its_recording_starts_fresh() {
        // The release was never seen and Esc ended the recording: the
        // next press must work, not count as a repeat.
        let t = Instant::now();
        let mut g = Gesture::default();
        let gen = scheduled(g.on_fn_down(t, false));
        g.on_timer(gen);
        assert!(matches!(
            g.on_fn_down(ms(t, 5000), false),
            Some(Action::ScheduleStart { .. })
        ));
    }

    #[test]
    fn a_release_before_the_start_never_records() {
        let t = Instant::now();
        let mut g = Gesture::default();
        let gen = scheduled(g.on_fn_down(t, false));
        assert_eq!(g.on_fn_up(ms(t, 150)), None);
        assert_eq!(g.on_timer(gen), None);
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

    #[test]
    fn fn_conflicts_say_how_to_fix_them() {
        use crate::island::IslandError;
        assert_eq!(conflict(FnUsage::DoNothing), None);
        assert_eq!(conflict(FnUsage::Unknown), None);
        for usage in [
            FnUsage::ShowEmoji,
            FnUsage::ChangeInputSource,
            FnUsage::StartDictation,
        ] {
            assert_eq!(conflict(usage), Some(IslandError::FnConflict));
        }
    }

    fn hotkeys(entry_64: &str) -> Vec<u8> {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>AppleSymbolicHotKeys</key><dict>
<key>65</key><dict><key>enabled</key><true/></dict>
{entry_64}
</dict></dict></plist>"#
        )
        .into_bytes()
    }

    #[test]
    fn spotlight_detection() {
        let cmd_space = r#"<key>64</key><dict><key>enabled</key><ENABLED/><key>value</key><dict>
<key>parameters</key><array><integer>32</integer><integer>49</integer><integer>1048576</integer></array>
<key>type</key><string>standard</string></dict></dict>"#;
        assert!(spotlight_on_cmd_space(Some(&hotkeys(
            &cmd_space.replace("<ENABLED/>", "<true/>")
        ))));
        assert!(!spotlight_on_cmd_space(Some(&hotkeys(
            &cmd_space.replace("<ENABLED/>", "<false/>")
        ))));
        assert!(!spotlight_on_cmd_space(Some(&hotkeys(
            &cmd_space.replace("<ENABLED/>", "<integer>0</integer>")
        ))));
        // Moved to ⌥Space: ⌘Space is free.
        let moved = cmd_space
            .replace("<ENABLED/>", "<true/>")
            .replace("1048576", "524288");
        assert!(!spotlight_on_cmd_space(Some(&hotkeys(&moved))));
        // Never changed (no entry), unreadable, or missing: macOS's default.
        assert!(spotlight_on_cmd_space(Some(&hotkeys(""))));
        assert!(spotlight_on_cmd_space(Some(b"not a plist")));
        assert!(spotlight_on_cmd_space(None));
    }
}
