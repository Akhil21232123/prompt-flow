//! Which app the user is dictating into, and what kind of app it is.
//!
//! Detection on macOS asks System Events for the frontmost process (approach
//! adapted from OpenTypeless, MIT). It runs on a background thread when the
//! shortcut is pressed, so its ~100 ms never adds to the wait after speaking.

use super::settings::{AppCategory, AppCategoryOverride};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Mutex;
use std::thread::JoinHandle;

#[derive(Serialize, Deserialize, Debug, Clone, Default, PartialEq, Eq, Type)]
pub struct AppContext {
    pub app_name: Option<String>,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
}

impl AppContext {
    pub fn is_empty(&self) -> bool {
        self.app_name.is_none() && self.bundle_id.is_none() && self.window_title.is_none()
    }

    /// One line for prompts, e.g. `Slack (com.tinyspeck.slackmacgap) — window "#eng"`.
    pub fn describe(&self) -> String {
        let mut out = self
            .app_name
            .clone()
            .unwrap_or_else(|| "Unknown app".into());
        if let Some(id) = &self.bundle_id {
            out.push_str(&format!(" ({id})"));
        }
        if let Some(title) = &self.window_title {
            // Window titles can carry a lot (document text in some editors).
            let title: String = title.chars().take(160).collect();
            out.push_str(&format!(" — window \"{title}\""));
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Per-recording capture
// ---------------------------------------------------------------------------

static PENDING: Mutex<Option<JoinHandle<Option<AppContext>>>> = Mutex::new(None);

/// Start detecting the frontmost app. Call when recording starts, while the
/// user's target app is still in front.
pub fn begin_capture() {
    let handle = std::thread::spawn(detect_frontmost);
    if let Ok(mut pending) = PENDING.lock() {
        *pending = Some(handle);
    }
}

/// The app captured by the last `begin_capture`, waiting for it if needed.
pub fn take_captured() -> Option<AppContext> {
    let handle = PENDING.lock().ok()?.take()?;
    handle.join().ok().flatten().filter(|ctx| !ctx.is_empty())
}

#[cfg(target_os = "macos")]
fn detect_frontmost() -> Option<AppContext> {
    let output = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", FRONT_APP_SCRIPT])
        .output()
        .ok()?;
    if !output.status.success() {
        log::debug!(
            "Front app detection failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return None;
    }
    parse_osascript_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(target_os = "macos"))]
fn detect_frontmost() -> Option<AppContext> {
    // Windows and Linux detection are not implemented yet; dictation still
    // works and simply uses the "Other" style.
    None
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const FRONT_APP_SCRIPT: &str = r#"
tell application "System Events"
    set frontProcess to first application process whose frontmost is true
    set appName to name of frontProcess
    try
        set bundleId to bundle identifier of frontProcess
    on error
        set bundleId to ""
    end try
    try
        set windowName to name of front window of frontProcess
    on error
        set windowName to ""
    end try
    return appName & (ASCII character 31) & bundleId & (ASCII character 31) & windowName
end tell
"#;

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn non_empty(s: Option<&str>) -> Option<String> {
    s.map(str::trim)
        .filter(|s| !s.is_empty() && *s != "missing value")
        .map(str::to_string)
}

/// Parses `name \x1f bundle id \x1f window title`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_osascript_output(raw: &str) -> Option<AppContext> {
    let mut fields = raw.trim_end_matches(['\n', '\r']).split('\u{1f}');
    let ctx = AppContext {
        app_name: non_empty(fields.next()),
        bundle_id: non_empty(fields.next()),
        window_title: non_empty(fields.next()),
    };
    (!ctx.is_empty()).then_some(ctx)
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/// Bundle id (lowercase, exact or `prefix.*`) → category.
const BUNDLE_RULES: &[(&str, AppCategory)] = &[
    // Email
    ("com.apple.mail", AppCategory::Email),
    ("com.microsoft.outlook", AppCategory::Email),
    ("com.readdle.smartemail-mac", AppCategory::Email),
    ("com.superhuman.electron", AppCategory::Email),
    ("com.mimestream.mimestream", AppCategory::Email),
    ("it.bloop.airmail2", AppCategory::Email),
    // Work chat
    ("com.tinyspeck.slackmacgap", AppCategory::WorkChat),
    ("com.microsoft.teams", AppCategory::WorkChat),
    ("com.microsoft.teams2", AppCategory::WorkChat),
    ("us.zoom.xos", AppCategory::WorkChat),
    ("com.linear", AppCategory::WorkChat),
    // Personal chat
    ("com.apple.mobilesms", AppCategory::PersonalChat),
    ("net.whatsapp.whatsapp", AppCategory::PersonalChat),
    ("desktop.whatsapp", AppCategory::PersonalChat),
    ("ru.keepcoder.telegram", AppCategory::PersonalChat),
    ("org.telegram.desktop", AppCategory::PersonalChat),
    ("com.hnc.discord", AppCategory::PersonalChat),
    (
        "org.whispersystems.signal-desktop",
        AppCategory::PersonalChat,
    ),
    ("com.facebook.archon", AppCategory::PersonalChat),
    ("com.tencent.xinwechat", AppCategory::PersonalChat),
    // Code editors
    ("com.todesktop.230313mzl4w4u92", AppCategory::Code), // Cursor
    ("com.exafunction.windsurf", AppCategory::Code),
    ("com.microsoft.vscode", AppCategory::Code),
    ("com.microsoft.vscodeinsiders", AppCategory::Code),
    ("com.vscodium", AppCategory::Code),
    ("dev.zed.zed", AppCategory::Code),
    ("com.apple.dt.xcode", AppCategory::Code),
    ("com.sublimetext.4", AppCategory::Code),
    ("com.jetbrains.*", AppCategory::Code),
    ("com.google.android.studio", AppCategory::Code),
    // Terminals
    ("com.apple.terminal", AppCategory::Terminal),
    ("com.googlecode.iterm2", AppCategory::Terminal),
    ("dev.warp.warp-stable", AppCategory::Terminal),
    ("com.mitchellh.ghostty", AppCategory::Terminal),
    ("net.kovidgoyal.kitty", AppCategory::Terminal),
    ("org.alacritty", AppCategory::Terminal),
    ("io.alacritty", AppCategory::Terminal),
    ("com.github.wez.wezterm", AppCategory::Terminal),
    // AI chat apps
    ("com.anthropic.claudefordesktop", AppCategory::AiChat),
    ("com.openai.chat", AppCategory::AiChat),
    ("ai.perplexity.mac", AppCategory::AiChat),
    // Documents and notes
    ("com.apple.iwork.pages", AppCategory::Docs),
    ("com.microsoft.word", AppCategory::Docs),
    ("notion.id", AppCategory::Docs),
    ("md.obsidian", AppCategory::Docs),
    ("com.apple.notes", AppCategory::Docs),
    ("com.craft.craft", AppCategory::Docs),
    ("com.lukilabs.lukiapp", AppCategory::Docs),
];

/// App names for when no bundle id is available (and for Linux/Windows later).
const NAME_RULES: &[(&str, AppCategory)] = &[
    ("mail", AppCategory::Email),
    ("outlook", AppCategory::Email),
    ("spark", AppCategory::Email),
    ("superhuman", AppCategory::Email),
    ("slack", AppCategory::WorkChat),
    ("microsoft teams", AppCategory::WorkChat),
    ("messages", AppCategory::PersonalChat),
    ("whatsapp", AppCategory::PersonalChat),
    ("telegram", AppCategory::PersonalChat),
    ("discord", AppCategory::PersonalChat),
    ("signal", AppCategory::PersonalChat),
    ("cursor", AppCategory::Code),
    ("windsurf", AppCategory::Code),
    ("code", AppCategory::Code),
    ("zed", AppCategory::Code),
    ("xcode", AppCategory::Code),
    ("terminal", AppCategory::Terminal),
    ("iterm2", AppCategory::Terminal),
    ("warp", AppCategory::Terminal),
    ("ghostty", AppCategory::Terminal),
    ("claude", AppCategory::AiChat),
    ("chatgpt", AppCategory::AiChat),
    ("perplexity", AppCategory::AiChat),
    ("notion", AppCategory::Docs),
    ("obsidian", AppCategory::Docs),
    ("notes", AppCategory::Docs),
    ("pages", AppCategory::Docs),
    ("microsoft word", AppCategory::Docs),
];

/// Browser window titles (the page title, usually "<page> - <site>") → category.
const TITLE_RULES: &[(&str, AppCategory)] = &[
    ("claude", AppCategory::AiChat),
    ("chatgpt", AppCategory::AiChat),
    ("gemini", AppCategory::AiChat),
    ("perplexity", AppCategory::AiChat),
    ("ai studio", AppCategory::AiChat),
    ("grok", AppCategory::AiChat),
    ("deepseek", AppCategory::AiChat),
    ("lovable", AppCategory::AiChat),
    ("bolt.new", AppCategory::AiChat),
    ("v0 by vercel", AppCategory::AiChat),
    ("replit", AppCategory::Code),
    ("github", AppCategory::Code),
    ("gmail", AppCategory::Email),
    ("inbox", AppCategory::Email),
    ("outlook", AppCategory::Email),
    ("slack", AppCategory::WorkChat),
    ("linear", AppCategory::WorkChat),
    ("jira", AppCategory::WorkChat),
    ("whatsapp", AppCategory::PersonalChat),
    ("messenger", AppCategory::PersonalChat),
    ("telegram", AppCategory::PersonalChat),
    ("google docs", AppCategory::Docs),
    ("notion", AppCategory::Docs),
];

const BROWSER_IDS: &[&str] = &[
    "com.apple.safari",
    "com.google.chrome",
    "com.google.chrome.canary",
    "company.thebrowser.browser",
    "company.thebrowser.dia",
    "org.mozilla.firefox",
    "com.brave.browser",
    "com.microsoft.edgemac",
    "com.vivaldi.vivaldi",
    "com.operasoftware.opera",
    "app.zen-browser.zen",
    "com.openai.atlas",
];

fn bundle_matches(rule: &str, bundle: &str) -> bool {
    match rule.strip_suffix(".*") {
        Some(prefix) => bundle.starts_with(prefix) && bundle.len() > prefix.len(),
        None => rule == bundle,
    }
}

fn contains_word(haystack: &str, needle: &str) -> bool {
    haystack.match_indices(needle).any(|(i, _)| {
        let before = haystack[..i].chars().next_back();
        let after = haystack[i + needle.len()..].chars().next();
        let boundary = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric());
        boundary(before) && boundary(after)
    })
}

pub fn is_browser(ctx: &AppContext) -> bool {
    let bundle = ctx
        .bundle_id
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if BROWSER_IDS.contains(&bundle.as_str()) {
        return true;
    }
    let name = ctx
        .app_name
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    [
        "safari",
        "google chrome",
        "arc",
        "firefox",
        "brave browser",
        "microsoft edge",
        "dia",
        "zen",
    ]
    .contains(&name.as_str())
}

/// Categorise an app, honouring user overrides first.
pub fn classify(ctx: &AppContext, overrides: &[AppCategoryOverride]) -> AppCategory {
    let bundle = ctx
        .bundle_id
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let name = ctx
        .app_name
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();

    for o in overrides {
        let key = o.app.trim().to_ascii_lowercase();
        if !key.is_empty() && (key == bundle || key == name) {
            return o.category;
        }
    }

    if is_browser(ctx) {
        let title = ctx
            .window_title
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase();
        return TITLE_RULES
            .iter()
            .find(|(needle, _)| contains_word(&title, needle))
            .map(|(_, c)| *c)
            .unwrap_or(AppCategory::Other);
    }

    if !bundle.is_empty() {
        if let Some((_, c)) = BUNDLE_RULES
            .iter()
            .find(|(rule, _)| bundle_matches(rule, &bundle))
        {
            return *c;
        }
    }

    if let Some((_, c)) = NAME_RULES.iter().find(|(n, _)| *n == name) {
        return *c;
    }

    AppCategory::Other
}

/// Code editors where `@file` mentions attach files to the AI chat.
pub fn supports_file_tags(ctx: &AppContext) -> bool {
    let bundle = ctx
        .bundle_id
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let name = ctx
        .app_name
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    bundle == "com.todesktop.230313mzl4w4u92"
        || bundle == "com.exafunction.windsurf"
        || bundle.starts_with("com.microsoft.vscode")
        || name == "cursor"
        || name == "windsurf"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(name: &str, bundle: &str, title: &str) -> AppContext {
        AppContext {
            app_name: non_empty(Some(name)),
            bundle_id: non_empty(Some(bundle)),
            window_title: non_empty(Some(title)),
        }
    }

    #[test]
    fn parses_osascript_fields() {
        let parsed =
            parse_osascript_output("Slack\u{1f}com.tinyspeck.slackmacgap\u{1f}#eng - Acme\n")
                .unwrap();
        assert_eq!(parsed.app_name.as_deref(), Some("Slack"));
        assert_eq!(
            parsed.bundle_id.as_deref(),
            Some("com.tinyspeck.slackmacgap")
        );
        assert_eq!(parsed.window_title.as_deref(), Some("#eng - Acme"));
    }

    #[test]
    fn parses_missing_fields() {
        let parsed = parse_osascript_output("Finder\u{1f}\u{1f}\n").unwrap();
        assert_eq!(parsed.app_name.as_deref(), Some("Finder"));
        assert!(parsed.bundle_id.is_none() && parsed.window_title.is_none());
        assert!(parse_osascript_output("\u{1f}\u{1f}").is_none());
    }

    #[test]
    fn classifies_native_apps() {
        assert_eq!(
            classify(&ctx("Cursor", "com.todesktop.230313mzl4w4u92", ""), &[]),
            AppCategory::Code
        );
        assert_eq!(
            classify(&ctx("Mail", "com.apple.mail", ""), &[]),
            AppCategory::Email
        );
        assert_eq!(
            classify(&ctx("Claude", "com.anthropic.claudefordesktop", ""), &[]),
            AppCategory::AiChat
        );
        assert_eq!(
            classify(&ctx("IntelliJ IDEA", "com.jetbrains.intellij", ""), &[]),
            AppCategory::Code
        );
        assert_eq!(
            classify(&ctx("Ghostty", "com.mitchellh.ghostty", ""), &[]),
            AppCategory::Terminal
        );
        assert_eq!(
            classify(&ctx("Finder", "com.apple.finder", ""), &[]),
            AppCategory::Other
        );
    }

    #[test]
    fn classifies_browser_tabs_by_title() {
        let chrome = |title| ctx("Google Chrome", "com.google.chrome", title);
        assert_eq!(
            classify(&chrome("New chat - Claude"), &[]),
            AppCategory::AiChat
        );
        assert_eq!(
            classify(&chrome("Inbox (3) - me@x.com - Gmail"), &[]),
            AppCategory::Email
        );
        assert_eq!(classify(&chrome("Weather today"), &[]), AppCategory::Other);
        // "claude" inside another word is not a match.
        assert_eq!(
            classify(&chrome("Claudette's bakery"), &[]),
            AppCategory::Other
        );
    }

    #[test]
    fn overrides_win() {
        let overrides = vec![AppCategoryOverride {
            app: "com.tinyspeck.slackmacgap".into(),
            category: AppCategory::PersonalChat,
        }];
        assert_eq!(
            classify(&ctx("Slack", "com.tinyspeck.slackmacgap", ""), &overrides),
            AppCategory::PersonalChat
        );
    }

    #[test]
    fn name_fallback_without_bundle() {
        assert_eq!(
            classify(&ctx("WhatsApp", "", ""), &[]),
            AppCategory::PersonalChat
        );
    }

    #[test]
    fn file_tag_support() {
        assert!(supports_file_tags(&ctx(
            "Cursor",
            "com.todesktop.230313mzl4w4u92",
            ""
        )));
        assert!(!supports_file_tags(&ctx("Xcode", "com.apple.dt.xcode", "")));
    }
}
