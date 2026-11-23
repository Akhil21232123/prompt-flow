//! What the settings window and the island can ask of the cloud layer.
//! Tokens stay in Rust: the webviews only ever see the account's email.

use super::api::{self, ApiError, CheckResult, ErrorCode, Memory, Usage};
use super::session::{self, AccountStatus, Session};
use super::update::{self, UpdateInfo};
use crate::flow::settings::FlowSettings;
use crate::island;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

fn clean_email(email: &str) -> Result<String, ApiError> {
    let email = email.trim().to_lowercase();
    let valid = email.len() <= 254
        && email.split_once('@').is_some_and(|(user, domain)| {
            !user.is_empty() && domain.contains('.') && !domain.ends_with('.')
        });
    if valid {
        Ok(email)
    } else {
        Err(ApiError::new(
            ErrorCode::BadRequest,
            "That doesn't look like an email address",
        ))
    }
}

/// Six digits, ignoring spaces and dashes people paste along with them.
pub fn clean_code(code: &str) -> Option<String> {
    let digits: String = code
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    (digits.len() >= 6 && digits.len() <= 10 && digits.chars().all(|c| c.is_ascii_digit()))
        .then_some(digits)
}

#[tauri::command]
#[specta::specta]
pub fn auth_status() -> AccountStatus {
    session::status()
}

#[tauri::command]
#[specta::specta]
pub async fn auth_send_code(email: String) -> Result<(), ApiError> {
    api::send_code(&clean_email(&email)?).await
}

#[tauri::command]
#[specta::specta]
pub async fn auth_verify_code(
    app: AppHandle,
    email: String,
    code: String,
) -> Result<AccountStatus, ApiError> {
    let email = clean_email(&email)?;
    let code = clean_code(&code).ok_or_else(|| {
        ApiError::new(
            ErrorCode::BadRequest,
            "Enter the 6-digit code from the email",
        )
    })?;
    let v = api::verify_code(&email, &code).await.map_err(|mut e| {
        if e.code == ErrorCode::BadRequest || e.status == 403 {
            e.code = ErrorCode::BadRequest;
            e.message = "That code didn't work. Check it, or ask for a new one.".into();
        }
        e
    })?;
    let session = Session::from_auth_json(&v, Some(&email), session::now_secs())
        .ok_or_else(|| ApiError::server("Unexpected sign-in response"))?;
    session::set(&app, Some(session));
    session::emit_changed(&app, None);
    after_sign_in(app);
    Ok(session::status())
}

/// Brings the server's settings in after signing in.
pub fn after_sign_in(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = pull_settings(&app).await {
            log::warn!("Could not load PromptFlow settings: {e}");
        }
    });
}

#[tauri::command]
#[specta::specta]
pub async fn auth_sign_out(app: AppHandle) -> Result<(), ApiError> {
    if let Some(s) = session::current() {
        api::sign_out(&s.access_token).await;
    }
    session::set(&app, None);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn account_usage(app: AppHandle) -> Result<Usage, ApiError> {
    api::usage(&app).await
}

#[tauri::command]
#[specta::specta]
pub async fn account_delete(app: AppHandle) -> Result<(), ApiError> {
    api::delete_account(&app).await?;
    session::set(&app, None);
    Ok(())
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

fn clean_memory(content: &str) -> Result<String, ApiError> {
    let content = content.trim();
    if content.is_empty() {
        return Err(ApiError::new(
            ErrorCode::BadRequest,
            "Write the memory first",
        ));
    }
    if content.chars().count() > api::MEMORY_MAX_CHARS {
        return Err(ApiError::new(
            ErrorCode::BadRequest,
            "Keep a memory under 280 characters",
        ));
    }
    Ok(content.to_string())
}

fn clean_kind(kind: &str) -> String {
    if api::MEMORY_KINDS.contains(&kind) {
        kind.to_string()
    } else {
        "fact".to_string()
    }
}

/// PostgREST's errors are technical; a repeated fact is the one users hit.
fn friendly_memory_error(mut e: ApiError) -> ApiError {
    if e.status == 409 {
        e.code = ErrorCode::BadRequest;
        e.message = "You already have that memory".into();
    } else if e.code == ErrorCode::Server || e.code == ErrorCode::BadRequest {
        e.message = "PromptFlow couldn't save that memory. Please try again.".into();
    }
    e
}

#[tauri::command]
#[specta::specta]
pub async fn memories_list(app: AppHandle) -> Result<Vec<Memory>, ApiError> {
    api::memories(&app).await
}

#[tauri::command]
#[specta::specta]
pub async fn memory_add(app: AppHandle, content: String, kind: String) -> Result<Memory, ApiError> {
    api::add_memory(&app, &clean_memory(&content)?, &clean_kind(&kind))
        .await
        .map_err(friendly_memory_error)
}

#[tauri::command]
#[specta::specta]
pub async fn memory_update(
    app: AppHandle,
    id: String,
    content: Option<String>,
    kind: Option<String>,
    pinned: Option<bool>,
) -> Result<Memory, ApiError> {
    let mut patch = serde_json::Map::new();
    if let Some(c) = content {
        patch.insert("content".into(), json!(clean_memory(&c)?));
    }
    if let Some(k) = kind {
        patch.insert("kind".into(), json!(clean_kind(&k)));
    }
    if let Some(p) = pinned {
        patch.insert("pinned".into(), json!(p));
    }
    api::update_memory(&app, &id, Value::Object(patch))
        .await
        .map_err(friendly_memory_error)
}

#[tauri::command]
#[specta::specta]
pub async fn memory_delete(app: AppHandle, id: String) -> Result<(), ApiError> {
    api::delete_memory(&app, &id).await
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn cloud_history(
    app: AppHandle,
    offset: u32,
    query: String,
) -> Result<Vec<api::CloudDictation>, ApiError> {
    api::history(&app, 50, offset, &query).await
}

/// "Paste again": hides PromptFlow so the app the user was in comes back to
/// the front, then pastes there.
#[tauri::command]
#[specta::specta]
pub async fn paste_again(app: AppHandle, text: String) -> Result<(), String> {
    use tauri::Manager;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::clipboard::paste_cloud(text, handle, true).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Settings sync
// ---------------------------------------------------------------------------

/// The settings the phones and the Mac share, as the server stores them.
pub fn synced_json(flow: &FlowSettings) -> Value {
    json!({
        "memory_enabled": flow.memory_enabled,
        "ask_back": flow.ask_back,
        "spoken_language": flow.spoken_language,
        "prompts_in_english": flow.prompts_in_english,
        "custom_style": flow.custom_style,
    })
}

/// The shared keys that differ between `old` and `new`.
pub fn synced_patch(old: &FlowSettings, new: &FlowSettings) -> Option<Value> {
    let (a, b) = (synced_json(old), synced_json(new));
    let (Some(a), Some(b)) = (a.as_object(), b.as_object()) else {
        return None;
    };
    let patch: serde_json::Map<String, Value> = b
        .iter()
        .filter(|(k, v)| a.get(*k) != Some(*v))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    (!patch.is_empty()).then_some(Value::Object(patch))
}

/// Applies the server's values for the shared keys. Returns whether anything
/// changed.
pub fn apply_server(flow: &mut FlowSettings, server: &Value) -> bool {
    let before = flow.clone();
    if let Some(b) = server.get("memory_enabled").and_then(Value::as_bool) {
        flow.memory_enabled = b;
    }
    if let Some(b) = server.get("ask_back").and_then(Value::as_bool) {
        flow.ask_back = b;
    }
    if let Some(b) = server.get("prompts_in_english").and_then(Value::as_bool) {
        flow.prompts_in_english = b;
    }
    if let Some(lang) = server.get("spoken_language").and_then(Value::as_str) {
        if crate::flow::settings::SPOKEN_LANGUAGES.contains(&lang) {
            flow.spoken_language = lang.to_string();
        }
    }
    if let Some(style) = server.get("custom_style").and_then(Value::as_str) {
        flow.custom_style = style.to_string();
    }
    *flow != before
}

/// Sends a change of shared settings to the server in the background.
pub fn push_settings(app: &AppHandle, patch: Value) {
    if !session::is_signed_in() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = api::merge_settings(&app, patch).await {
            log::warn!("Could not save settings to PromptFlow: {e}");
        }
    });
}

pub async fn pull_settings(app: &AppHandle) -> Result<(), ApiError> {
    let server = api::get_settings(app).await?;
    let mut settings = crate::settings::get_settings(app);
    if apply_server(&mut settings.flow, &server) {
        crate::settings::write_settings(app, settings.clone());
        let _ = app.emit("settings-changed", json!({"setting": "flow"}));
    }
    // Keys the server doesn't have yet get this Mac's values.
    let missing: serde_json::Map<String, Value> = synced_json(&settings.flow)
        .as_object()
        .map(|o| {
            o.iter()
                .filter(|(k, _)| server.get(*k).is_none())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    if !missing.is_empty() {
        api::merge_settings(app, Value::Object(missing)).await?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_settings_sync(app: AppHandle) -> Result<(), ApiError> {
    pull_settings(&app).await
}

// ---------------------------------------------------------------------------
// Island
// ---------------------------------------------------------------------------

/// A tapped option, or `None` for "Skip".
#[tauri::command]
#[specta::specta]
pub async fn island_answer(app: AppHandle, id: u64, answer: Option<String>) -> Result<(), String> {
    super::pipeline::answer(&app, id, answer).await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn island_close(app: AppHandle, id: u64) {
    super::pipeline::close_question(&app, id);
}

#[tauri::command]
#[specta::specta]
pub fn island_dismiss(app: AppHandle, id: u64) {
    island::dismiss(&app, id);
}

#[tauri::command]
#[specta::specta]
pub fn island_undo(app: AppHandle, id: u64) -> Result<(), String> {
    super::pipeline::undo(&app, id)
}

#[tauri::command]
#[specta::specta]
pub fn island_copy(app: AppHandle, id: u64) -> Result<(), String> {
    super::pipeline::copy(&app, id)
}

#[tauri::command]
#[specta::specta]
pub async fn island_send_fix(app: AppHandle, id: u64) -> Result<(), String> {
    super::pipeline::send_fix(&app, id).await
}

/// A redo chip ("As prompt", "Formal", …) on the result in view `id`.
#[tauri::command]
#[specta::specta]
pub async fn island_redo(app: AppHandle, id: u64, kind: island::Redo) -> Result<(), String> {
    super::pipeline::redo(&app, id, kind).await;
    Ok(())
}

/// Sends the kept recording in view `id` again now.
#[tauri::command]
#[specta::specta]
pub async fn island_retry(app: AppHandle, id: u64) -> Result<(), String> {
    super::pipeline::retry(&app, id).await;
    Ok(())
}

/// Transcribes the kept recording in view `id` on this Mac and pastes it.
#[tauri::command]
#[specta::specta]
pub async fn island_paste_raw(app: AppHandle, id: u64) -> Result<(), String> {
    super::pipeline::paste_raw(&app, id).await;
    Ok(())
}

/// 👍 (`up`) or 👎 on the result in view `id`.
#[tauri::command]
#[specta::specta]
pub fn island_rate(app: AppHandle, id: u64, up: bool) {
    super::pipeline::rate(&app, id, up);
}

/// "Report a problem" from Settings or the menu bar.
#[tauri::command]
#[specta::specta]
pub async fn report_problem(
    app: AppHandle,
    note: String,
    include_last: bool,
) -> Result<(), ApiError> {
    if note.trim().is_empty() {
        return Err(ApiError::new(
            ErrorCode::BadRequest,
            "Tell us what went wrong",
        ));
    }
    super::pipeline::report(&app, &note, include_last).await
}

/// The card's drawn size, so hovering it can keep it open.
#[tauri::command]
#[specta::specta]
pub fn island_card_size(id: u64, width: f64, height: f64) {
    island::set_card_size(id, width, height);
}

/// Opens the settings window (e.g. from "Sign in to start").
#[tauri::command]
#[specta::specta]
pub fn island_open_app(app: AppHandle, id: u64) {
    island::dismiss(&app, id);
    crate::show_main_window_public(&app);
}

/// The island's current view, for an island webview that (re)loads.
#[tauri::command]
#[specta::specta]
pub fn island_current() -> island::IslandEvent {
    let (id, view) = island::current();
    island::IslandEvent {
        id,
        view,
        geometry: island::current_geometry(),
    }
}

/// Autopilot from the settings window's "try it" button.
#[tauri::command]
#[specta::specta]
pub async fn autopilot_check_now(app: AppHandle) -> Result<(), String> {
    super::pipeline::autopilot(&app).await;
    Ok(())
}

/// A check of `answer` against `intent`, for the guide's live demo.
#[tauri::command]
#[specta::specta]
pub async fn autopilot_check_text(
    app: AppHandle,
    intent: String,
    answer: String,
) -> Result<CheckResult, ApiError> {
    api::check(&app, &intent, &answer, Some("PromptFlow")).await
}

// ---------------------------------------------------------------------------
// Updates and permissions
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
pub async fn check_mac_update() -> Result<UpdateInfo, String> {
    update::check().await
}

/// Downloads the new build and opens its .dmg.
#[tauri::command]
#[specta::specta]
pub async fn install_mac_update(app: AppHandle, url: String) -> Result<String, String> {
    update::download_and_open(&app, &url).await
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyPane {
    Microphone,
    Accessibility,
    ScreenRecording,
}

pub fn privacy_url(pane: PrivacyPane) -> &'static str {
    match pane {
        PrivacyPane::Microphone => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        PrivacyPane::Accessibility => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
        PrivacyPane::ScreenRecording => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
    }
}

/// Opens the System Settings pane where the user allows `pane`.
#[tauri::command]
#[specta::specta]
pub fn open_privacy_settings(pane: PrivacyPane) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg(privacy_url(pane))
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = privacy_url(pane);
        Err("System Settings panes are macOS only".into())
    }
}

#[tauri::command]
#[specta::specta]
pub fn screen_recording_allowed() -> bool {
    super::ocr::screen_capture_allowed()
}

/// Shows macOS's Screen Recording prompt the first time; afterwards macOS
/// only allows it in System Settings, so that pane opens too.
#[tauri::command]
#[specta::specta]
pub fn request_screen_recording() -> bool {
    let granted = super::ocr::request_screen_capture();
    if !granted {
        let _ = open_privacy_settings(PrivacyPane::ScreenRecording);
    }
    granted
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_and_codes() {
        assert_eq!(clean_email("  Me@Example.com ").unwrap(), "me@example.com");
        assert!(clean_email("nope").is_err());
        assert!(clean_email("a@b").is_err());
        assert_eq!(clean_code(" 123 456 ").as_deref(), Some("123456"));
        assert_eq!(clean_code("123-456").as_deref(), Some("123456"));
        assert_eq!(clean_code("12345"), None);
        assert_eq!(clean_code("12a456"), None);
    }

    #[test]
    fn only_changed_shared_settings_are_pushed() {
        let old = FlowSettings::default();
        let mut new = old.clone();
        assert!(synced_patch(&old, &new).is_none());
        new.memory_enabled = false;
        new.smart_polish = false; // not shared
        assert_eq!(
            synced_patch(&old, &new).unwrap(),
            json!({"memory_enabled": false})
        );
    }

    #[test]
    fn server_settings_apply_and_bad_values_are_ignored() {
        let mut flow = FlowSettings::default();
        let changed = apply_server(
            &mut flow,
            &json!({"ask_back": false, "spoken_language": "te", "theme": "x"}),
        );
        assert!(changed);
        assert!(!flow.ask_back);
        assert_eq!(flow.spoken_language, "te");
        assert!(!apply_server(&mut flow, &json!({"spoken_language": "xx"})));
        assert_eq!(flow.spoken_language, "te");
    }

    #[test]
    fn duplicate_memories_get_plain_words() {
        let e = api::parse_error(409, r#"{"code":"23505","message":"duplicate key"}"#, None);
        let e = friendly_memory_error(e);
        assert_eq!(e.message, "You already have that memory");
        assert_eq!(e.code, ErrorCode::BadRequest);
    }

    #[test]
    fn memory_input_rules() {
        assert!(clean_memory("   ").is_err());
        assert!(clean_memory(&"x".repeat(281)).is_err());
        assert_eq!(clean_memory(" I use pnpm ").unwrap(), "I use pnpm");
        assert_eq!(clean_kind("person"), "person");
        assert_eq!(clean_kind("secret"), "fact");
    }

    #[test]
    fn privacy_panes_deep_link_to_system_settings() {
        assert!(privacy_url(PrivacyPane::ScreenRecording).ends_with("Privacy_ScreenCapture"));
        assert!(privacy_url(PrivacyPane::Microphone).starts_with("x-apple.systempreferences:"));
    }
}
