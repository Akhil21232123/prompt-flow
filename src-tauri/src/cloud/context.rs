//! What's on screen when a recording starts: the focused field (for
//! `surrounding_text`), the page URL, the selection, and for "This" the text
//! of the focused window, read through the Accessibility API, or recognised
//! on-device from a screenshot when the app exposes no text.

use super::dictate::{MetaScreen, ScreenSource};
use std::sync::Mutex;
use std::thread::JoinHandle;

/// The first `max` characters of `s`.
pub fn head_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// The last `max` characters of `s`.
pub fn tail_chars(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    s.chars().skip(count - max).collect()
}

/// Collapses runs of blank lines and trims each line, so screen text spends
/// its character budget on words.
pub fn tidy_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank = 0;
    for line in s.lines() {
        let line = line.trim();
        if line.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(line);
    }
    out.trim().to_string()
}

/// The focused text field and its window, as far as the app exposes them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FieldContext {
    /// Text before the cursor in the focused field.
    pub before_cursor: Option<String>,
    /// The selected text, read without touching the clipboard.
    pub selected: Option<String>,
    /// The page's address, when the window shows a web page.
    pub url: Option<String>,
    /// The focused window's title (for web apps and browsers, usually the
    /// page's title: the best clue to which AI is in front).
    pub window_title: Option<String>,
}

/// Everything captured for one recording.
#[derive(Debug, Clone, Default)]
pub struct Captured {
    pub field: FieldContext,
    /// For "This": the text the prompt is about.
    pub screen: Option<MetaScreen>,
}

/// Below this many characters, window text is treated as "no text" and the
/// window is read with OCR instead.
const MIN_WINDOW_TEXT: usize = 200;

/// Window text gathered for "This" before it's cut to the contract's limit.
const WINDOW_TEXT_BUDGET: usize = super::dictate::SCREEN_MAX_CHARS;

static PENDING: Mutex<Option<JoinHandle<Captured>>> = Mutex::new(None);
/// The latest capture's field, readable before the capture finishes.
static LATEST_FIELD: Mutex<Option<FieldContext>> = Mutex::new(None);

/// The field read by the latest `begin_capture`, waiting up to `wait`.
pub fn peek_field(wait: std::time::Duration) -> Option<FieldContext> {
    let deadline = std::time::Instant::now() + wait;
    loop {
        if let Some(f) = LATEST_FIELD.lock().ok().and_then(|f| f.clone()) {
            return Some(f);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
}

/// Starts reading the focused field (and, for "This", the screen) on a
/// background thread. Call when recording starts, while the user's app is in
/// front. `on_screen` runs on that thread once screen text is in.
pub fn begin_capture<F>(want_screen: bool, on_screen: F)
where
    F: FnOnce(&MetaScreen) + Send + 'static,
{
    if let Ok(mut latest) = LATEST_FIELD.lock() {
        *latest = None;
    }
    let handle = std::thread::spawn(move || {
        let field = platform::focused_field();
        if let Ok(mut latest) = LATEST_FIELD.lock() {
            *latest = Some(field.clone());
        }
        let screen = if want_screen {
            screen_text(&field)
        } else {
            None
        };
        if let Some(screen) = &screen {
            on_screen(screen);
        }
        Captured { field, screen }
    });
    if let Ok(mut pending) = PENDING.lock() {
        *pending = Some(handle);
    }
}

/// Drops the pending capture without waiting for it (its thread finishes
/// on its own).
pub fn discard_captured() {
    if let Ok(mut pending) = PENDING.lock() {
        pending.take();
    }
}

/// The capture started by the last `begin_capture`, waiting for it.
pub fn take_captured() -> Captured {
    let handle = PENDING.lock().ok().and_then(|mut p| p.take());
    handle.and_then(|h| h.join().ok()).unwrap_or_default()
}

/// The text "This" is about: the selection, else the window's text, else OCR.
fn screen_text(field: &FieldContext) -> Option<MetaScreen> {
    if let Some(sel) = field.selected.as_deref().map(tidy_text) {
        if !sel.is_empty() {
            return Some(MetaScreen {
                text: head_chars(&sel, WINDOW_TEXT_BUDGET),
                source: ScreenSource::Selection,
            });
        }
    }
    let window = platform::window_text(WINDOW_TEXT_BUDGET * 2)
        .map(|t| tidy_text(&t))
        .unwrap_or_default();
    if window.chars().count() >= MIN_WINDOW_TEXT {
        return Some(MetaScreen {
            text: head_chars(&window, WINDOW_TEXT_BUDGET),
            source: ScreenSource::Window,
        });
    }
    if let Some(ocr) = super::ocr::read_focused_window().map(|t| tidy_text(&t)) {
        if ocr.chars().count() > window.chars().count() {
            return Some(MetaScreen {
                text: head_chars(&ocr, WINDOW_TEXT_BUDGET),
                source: ScreenSource::Ocr,
            });
        }
    }
    if window.is_empty() {
        return None;
    }
    Some(MetaScreen {
        text: window,
        source: ScreenSource::Window,
    })
}

/// For Autopilot: the AI's answer. The selection when there is one,
/// otherwise the end of the focused window's text (the newest reply is at
/// the bottom of a chat). Reads on the calling thread.
pub fn answer_text(max: usize) -> Option<(String, ScreenSource)> {
    let field = platform::focused_field();
    if let Some(sel) = field.selected.map(|s| tidy_text(&s)) {
        if sel.chars().count() >= 2 {
            return Some((tail_chars(&sel, max), ScreenSource::Selection));
        }
    }
    let window = platform::window_text(max * 4).map(|t| tidy_text(&t))?;
    if window.chars().count() >= 20 {
        return Some((tail_chars(&window, max), ScreenSource::Window));
    }
    let ocr = super::ocr::read_focused_window().map(|t| tidy_text(&t))?;
    (ocr.chars().count() >= 20).then(|| (tail_chars(&ocr, max), ScreenSource::Ocr))
}

/// AI products people prompt, by a word in their address, app name or page
/// title, with the name to show ("Prompt for Gemini").
const AI_PRODUCTS: &[(&str, &str)] = &[
    ("claude", "Claude"),
    ("chatgpt", "ChatGPT"),
    ("chat.openai", "ChatGPT"),
    ("gemini", "Gemini"),
    ("aistudio.google", "AI Studio"),
    ("notebooklm", "NotebookLM"),
    ("perplexity", "Perplexity"),
    ("copilot", "Copilot"),
    ("grok", "Grok"),
    ("deepseek", "DeepSeek"),
    ("chat.mistral", "Le Chat"),
    ("meta.ai", "Meta AI"),
    ("poe.com", "Poe"),
    ("midjourney", "Midjourney"),
    ("lovable", "Lovable"),
    ("bolt.new", "Bolt"),
    ("v0.dev", "v0"),
    ("v0.app", "v0"),
    ("cursor", "Cursor"),
];

fn known_ai(haystack: &str) -> Option<&'static str> {
    let h = haystack.to_lowercase();
    AI_PRODUCTS
        .iter()
        .find(|(needle, _)| h.contains(needle))
        .map(|(_, name)| *name)
}

/// The name of what a prompt is written for: a known AI from the page's
/// address or title in a browser or web app, otherwise the app's own name.
/// `None` for a browser showing something unrecognised.
pub fn target_name(
    app_name: Option<&str>,
    in_browser: bool,
    url: Option<&str>,
    title: Option<&str>,
) -> Option<String> {
    let host = url
        .and_then(|u| url::Url::parse(u).ok())
        .and_then(|u| u.host_str().map(str::to_string));
    let found = host
        .as_deref()
        .and_then(known_ai)
        .or_else(|| app_name.and_then(known_ai))
        .or_else(|| in_browser.then(|| title.and_then(known_ai)).flatten());
    if let Some(name) = found {
        return Some(name.to_string());
    }
    if in_browser {
        return None;
    }
    app_name
        .map(str::trim)
        .filter(|n| !n.is_empty() && !n.eq_ignore_ascii_case("web app"))
        .map(str::to_string)
}

/// The front tab's address, asked of the browser by AppleScript, for when
/// its accessibility tree doesn't say. macOS asks the user once per browser.
pub fn browser_url(bundle_id: &str) -> Option<String> {
    let script = browser_url_script(bundle_id)?;
    #[cfg(target_os = "macos")]
    {
        let out = super::ocr::run_with_timeout(
            std::process::Command::new("/usr/bin/osascript").args(["-e", &script]),
            std::time::Duration::from_millis(2500),
        )?;
        let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (out.status.success() && (url.starts_with("http://") || url.starts_with("https://")))
            .then_some(url)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = script;
        None
    }
}

fn browser_url_script(bundle_id: &str) -> Option<String> {
    // Bundle ids are plain reverse-DNS; refuse anything that could break
    // out of the script's string.
    if !bundle_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return None;
    }
    let lower = bundle_id.to_ascii_lowercase();
    let safari = ["com.apple.safari", "com.apple.safaritechnologypreview"];
    let chromium = [
        "com.google.chrome",
        "com.google.chrome.canary",
        "com.brave.browser",
        "com.microsoft.edgemac",
        "com.vivaldi.vivaldi",
        "company.thebrowser.browser",
        "com.operasoftware.opera",
    ];
    if safari.contains(&lower.as_str()) {
        Some(format!(
            r#"tell application id "{bundle_id}" to return URL of front document"#
        ))
    } else if chromium.contains(&lower.as_str()) {
        Some(format!(
            r#"tell application id "{bundle_id}" to return URL of active tab of front window"#
        ))
    } else {
        None
    }
}

/// The focused window's frame in global points (top-left origin), for OCR.
pub fn focused_window_frame() -> Option<(f64, f64, f64, f64)> {
    platform::focused_window_frame()
}

#[cfg(target_os = "macos")]
mod platform {
    //! The Accessibility API through its C interface. Every call is bounded
    //! by a messaging timeout, and walks stop at a node and time budget, so
    //! an app that hangs can't hold a recording.

    use super::FieldContext;
    use std::ffi::{c_char, c_void};
    use std::time::{Duration, Instant};

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type AXUIElementRef = *const c_void;

    const UTF8: u32 = 0x0800_0100;
    const AX_VALUE_CGPOINT: u32 = 1;
    const AX_VALUE_CGSIZE: u32 = 2;
    const AX_VALUE_CFRANGE: u32 = 4;

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct CFRange {
        location: isize,
        _length: isize,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXUIElementCreateSystemWide() -> AXUIElementRef;
        fn AXUIElementCopyAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: *mut CFTypeRef,
        ) -> i32;
        fn AXUIElementSetAttributeValue(
            element: AXUIElementRef,
            attribute: CFStringRef,
            value: CFTypeRef,
        ) -> i32;
        fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> i32;
        fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut c_void) -> u8;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: CFTypeRef;
        fn CFRelease(cf: CFTypeRef);
        fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
        fn CFGetTypeID(cf: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFArrayGetTypeID() -> usize;
        fn CFURLGetTypeID() -> usize;
        fn CFStringCreateWithBytes(
            alloc: *const c_void,
            bytes: *const u8,
            num_bytes: isize,
            encoding: u32,
            is_external: u8,
        ) -> CFStringRef;
        fn CFStringGetLength(s: CFStringRef) -> isize;
        fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
        fn CFStringGetCString(
            s: CFStringRef,
            buffer: *mut c_char,
            size: isize,
            encoding: u32,
        ) -> u8;
        fn CFArrayGetCount(a: CFTypeRef) -> isize;
        fn CFArrayGetValueAtIndex(a: CFTypeRef, index: isize) -> CFTypeRef;
        fn CFURLGetString(url: CFTypeRef) -> CFStringRef;
    }

    /// An owned CoreFoundation reference.
    struct Cf(CFTypeRef);
    impl Drop for Cf {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) };
            }
        }
    }

    fn cf_str(s: &str) -> Cf {
        Cf(unsafe {
            CFStringCreateWithBytes(std::ptr::null(), s.as_ptr(), s.len() as isize, UTF8, 0)
        })
    }

    /// Reads a CFString (borrowed) into Rust.
    fn rust_string(s: CFStringRef) -> Option<String> {
        if s.is_null() || unsafe { CFGetTypeID(s) } != unsafe { CFStringGetTypeID() } {
            return None;
        }
        let len = unsafe { CFStringGetLength(s) };
        let cap = unsafe { CFStringGetMaximumSizeForEncoding(len, UTF8) } + 1;
        if cap <= 0 {
            return None;
        }
        let mut buf = vec![0u8; cap as usize];
        let ok = unsafe { CFStringGetCString(s, buf.as_mut_ptr().cast(), cap, UTF8) };
        if ok == 0 {
            return None;
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        buf.truncate(end);
        String::from_utf8(buf).ok()
    }

    fn attr(el: AXUIElementRef, name: &str) -> Option<Cf> {
        let key = cf_str(name);
        if key.0.is_null() {
            return None;
        }
        let mut value: CFTypeRef = std::ptr::null();
        let err = unsafe { AXUIElementCopyAttributeValue(el, key.0, &mut value) };
        (err == 0 && !value.is_null()).then_some(Cf(value))
    }

    fn attr_string(el: AXUIElementRef, name: &str) -> Option<String> {
        attr(el, name).and_then(|v| rust_string(v.0))
    }

    fn attr_children(el: AXUIElementRef) -> Vec<Cf> {
        let Some(arr) = attr(el, "AXChildren") else {
            return Vec::new();
        };
        if unsafe { CFGetTypeID(arr.0) } != unsafe { CFArrayGetTypeID() } {
            return Vec::new();
        }
        let n = unsafe { CFArrayGetCount(arr.0) }.max(0);
        (0..n)
            .filter_map(|i| {
                let child = unsafe { CFArrayGetValueAtIndex(arr.0, i) };
                if child.is_null() {
                    return None;
                }
                // The array's items are borrowed: retain each so it
                // outlives the array.
                Some(Cf(unsafe { CFRetain(child) }))
            })
            .collect()
    }

    fn ax_value<T: Default>(el: AXUIElementRef, name: &str, kind: u32) -> Option<T> {
        let v = attr(el, name)?;
        let mut out = T::default();
        let ok = unsafe { AXValueGetValue(v.0, kind, (&mut out as *mut T).cast()) };
        (ok != 0).then_some(out)
    }

    fn trusted() -> bool {
        unsafe { AXIsProcessTrusted() != 0 }
    }

    fn system() -> Option<Cf> {
        if !trusted() {
            return None;
        }
        let sys = Cf(unsafe { AXUIElementCreateSystemWide() });
        if sys.0.is_null() {
            return None;
        }
        unsafe { AXUIElementSetMessagingTimeout(sys.0, 0.3) };
        Some(sys)
    }

    fn focused_app() -> Option<Cf> {
        let sys = system()?;
        let app = attr(sys.0, "AXFocusedApplication")?;
        unsafe { AXUIElementSetMessagingTimeout(app.0, 0.3) };
        // Chromium and Electron apps build their accessibility tree only
        // when asked; this asks without the side effects of
        // AXEnhancedUserInterface.
        let key = cf_str("AXManualAccessibility");
        unsafe { AXUIElementSetAttributeValue(app.0, key.0, kCFBooleanTrue) };
        Some(app)
    }

    const TEXT_ROLES: &[&str] = &["AXTextArea", "AXTextField", "AXComboBox", "AXSearchField"];

    pub fn focused_field() -> FieldContext {
        let mut out = FieldContext::default();
        let Some(app) = focused_app() else {
            return out;
        };
        if let Some(el) = attr(app.0, "AXFocusedUIElement") {
            let role = attr_string(el.0, "AXRole").unwrap_or_default();
            let subrole = attr_string(el.0, "AXSubrole").unwrap_or_default();
            let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField";
            if !secure {
                out.selected = attr_string(el.0, "AXSelectedText").filter(|s| !s.trim().is_empty());
                if TEXT_ROLES.contains(&role.as_str()) || role == "AXWebArea" {
                    if let Some(value) = attr_string(el.0, "AXValue") {
                        let range: Option<CFRange> =
                            ax_value(el.0, "AXSelectedTextRange", AX_VALUE_CFRANGE);
                        out.before_cursor = Some(before_cursor(&value, range.map(|r| r.location)));
                    }
                }
            }
        }
        if let Some(window) = attr(app.0, "AXFocusedWindow") {
            out.window_title = attr_string(window.0, "AXTitle").filter(|t| !t.trim().is_empty());
            // Safari (and its web apps) name the page in the window's
            // document; other browsers only in the web area.
            out.url = attr_string(window.0, "AXDocument")
                .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
                .or_else(|| find_url(window.0));
        }
        out
    }

    /// The text before a UTF-16 cursor offset (the whole value without one).
    fn before_cursor(value: &str, cursor: Option<isize>) -> String {
        match cursor {
            Some(loc) if loc >= 0 => {
                let utf16: Vec<u16> = value.encode_utf16().collect();
                let end = (loc as usize).min(utf16.len());
                String::from_utf16_lossy(&utf16[..end])
            }
            _ => value.to_string(),
        }
    }

    /// The first web area's address: breadth-first, so the page (a few
    /// levels down) is reached before the toolbar's many buttons are walked.
    fn find_url(window: AXUIElementRef) -> Option<String> {
        let deadline = Instant::now() + Duration::from_millis(500);
        let mut queue: std::collections::VecDeque<(Cf, usize)> =
            attr_children(window).into_iter().map(|c| (c, 1)).collect();
        let mut visited = 0;
        while let Some((el, depth)) = queue.pop_front() {
            visited += 1;
            if visited > 1500 || Instant::now() > deadline {
                break;
            }
            let role = attr_string(el.0, "AXRole").unwrap_or_default();
            if matches!(
                role.as_str(),
                "AXToolbar" | "AXMenuBar" | "AXButton" | "AXStaticText"
            ) {
                continue;
            }
            if role == "AXWebArea" {
                let url = attr(el.0, "AXURL")?;
                if unsafe { CFGetTypeID(url.0) } == unsafe { CFURLGetTypeID() } {
                    let s = rust_string(unsafe { CFURLGetString(url.0) })?;
                    return (s.starts_with("http://") || s.starts_with("https://")).then_some(s);
                }
                return rust_string(url.0);
            }
            if depth < 10 {
                queue.extend(attr_children(el.0).into_iter().map(|c| (c, depth + 1)));
            }
        }
        None
    }

    const SKIP_ROLES: &[&str] = &["AXMenuBar", "AXMenu", "AXToolbar", "AXScrollBar", "AXImage"];
    const VALUE_ROLES: &[&str] = &["AXStaticText", "AXTextArea", "AXTextField", "AXHeading"];

    /// The focused window's visible text in reading order, up to `max` chars.
    pub fn window_text(max: usize) -> Option<String> {
        let app = focused_app()?;
        let window = attr(app.0, "AXFocusedWindow")?;
        let deadline = Instant::now() + Duration::from_millis(1500);
        let mut out = String::new();
        let mut nodes = 0usize;
        // Depth-first, children in order: a stack holding them reversed.
        let mut stack = vec![window];
        while let Some(el) = stack.pop() {
            nodes += 1;
            if nodes > 8000 || out.len() >= max * 4 || Instant::now() > deadline {
                break;
            }
            let role = attr_string(el.0, "AXRole").unwrap_or_default();
            if SKIP_ROLES.contains(&role.as_str()) || role == "AXSecureTextField" {
                continue;
            }
            if VALUE_ROLES.contains(&role.as_str()) {
                if let Some(text) = attr_string(el.0, "AXValue") {
                    let text = text.trim();
                    if !text.is_empty() {
                        out.push_str(text);
                        out.push('\n');
                    }
                }
                // Static text has no useful children; a text area's children
                // repeat its value.
                if role != "AXHeading" {
                    continue;
                }
            }
            let mut children = attr_children(el.0);
            children.reverse();
            stack.extend(children);
        }
        let text = out.trim().to_string();
        (!text.is_empty()).then(|| super::head_chars(&text, max))
    }

    pub fn focused_window_frame() -> Option<(f64, f64, f64, f64)> {
        let app = focused_app()?;
        let window = attr(app.0, "AXFocusedWindow")?;
        let pos: CGPoint = ax_value(window.0, "AXPosition", AX_VALUE_CGPOINT)?;
        let size: CGSize = ax_value(window.0, "AXSize", AX_VALUE_CGSIZE)?;
        (size.width >= 40.0 && size.height >= 40.0).then_some((
            pos.x,
            pos.y,
            size.width,
            size.height,
        ))
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn cursor_offsets_are_utf16() {
            assert_eq!(super::before_cursor("héllo 😀 world", Some(8)), "héllo 😀");
            assert_eq!(super::before_cursor("abc", Some(99)), "abc");
            assert_eq!(super::before_cursor("abc", None), "abc");
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    //! Reading other apps is macOS-only; elsewhere every read is empty.
    use super::FieldContext;

    pub fn focused_field() -> FieldContext {
        FieldContext::default()
    }

    pub fn window_text(_max: usize) -> Option<String> {
        None
    }

    pub fn focused_window_frame() -> Option<(f64, f64, f64, f64)> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_and_tail_count_characters() {
        assert_eq!(head_chars("héllo", 2), "hé");
        assert_eq!(tail_chars("héllo", 3), "llo");
        assert_eq!(tail_chars("ab", 5), "ab");
    }

    #[test]
    fn targets_come_from_the_page_or_the_app() {
        assert_eq!(
            target_name(Some("Gemini"), false, None, None).as_deref(),
            Some("Gemini")
        );
        assert_eq!(
            target_name(
                Some("Safari"),
                true,
                Some("https://gemini.google.com/app/1"),
                None
            )
            .as_deref(),
            Some("Gemini")
        );
        assert_eq!(
            target_name(Some("Web App"), true, None, Some("Google Gemini")).as_deref(),
            Some("Gemini")
        );
        assert_eq!(
            target_name(Some("Claude"), false, None, Some("Chat")).as_deref(),
            Some("Claude")
        );
        assert_eq!(
            target_name(Some("Safari"), true, None, Some("BBC News")),
            None
        );
        assert_eq!(
            target_name(Some("Slack"), false, None, Some("claude talk")).as_deref(),
            Some("Slack"),
            "titles only count in browsers"
        );
    }

    #[test]
    fn browser_url_scripts() {
        assert!(browser_url_script("com.apple.Safari")
            .unwrap()
            .contains("front document"));
        assert!(browser_url_script("com.google.Chrome")
            .unwrap()
            .contains("active tab"));
        assert!(browser_url_script("com.apple.Safari.WebApp.X").is_none());
        assert!(browser_url_script("org.mozilla.firefox").is_none());
        assert!(browser_url_script("evil\" to do shell script").is_none());
    }

    #[test]
    fn tidy_text_drops_extra_blank_lines() {
        assert_eq!(tidy_text("  a  \n\n\n\n b \n"), "a\n\nb");
        assert_eq!(tidy_text("\n\n"), "");
    }
}
