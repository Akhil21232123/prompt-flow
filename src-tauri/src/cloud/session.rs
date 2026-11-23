//! The signed-in PromptFlow session.
//!
//! Stored as `account.json` in the app's data folder, readable only by the
//! user (0600). Not the macOS Keychain: PromptFlow ships ad-hoc signed, so
//! its code identity changes with every build, and the Keychain would ask for
//! the login password after each update before handing the session back. The
//! file has the protection a browser gives a web session (owner-only, inside
//! the user's Library), Supabase rotates the refresh token on every use, and
//! the backend can revoke it. Tokens never reach the webviews.

use super::api::{self, ApiError, ErrorCode};
use once_cell::sync::{Lazy, OnceCell};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

/// Refresh this long before the access token expires.
const REFRESH_MARGIN_SECS: i64 = 120;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds.
    pub expires_at: i64,
    pub user_id: String,
    pub email: String,
}

impl Session {
    /// A session from a GoTrue token response (`/verify`, `/token`).
    pub fn from_auth_json(v: &Value, fallback_email: Option<&str>, now: i64) -> Option<Session> {
        let access_token = v.get("access_token")?.as_str()?.to_string();
        let refresh_token = v.get("refresh_token")?.as_str()?.to_string();
        if access_token.is_empty() || refresh_token.is_empty() {
            return None;
        }
        let expires_at = v
            .get("expires_at")
            .and_then(Value::as_i64)
            .or_else(|| v.get("expires_in").and_then(Value::as_i64).map(|s| now + s))
            .unwrap_or(now + 3600);
        let user = v.get("user");
        let user_id = user
            .and_then(|u| u.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| jwt_claim(&access_token, "sub"))?;
        let email = user
            .and_then(|u| u.get("email"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| jwt_claim(&access_token, "email"))
            .or_else(|| fallback_email.map(str::to_string))
            .unwrap_or_default();
        Some(Session {
            access_token,
            refresh_token,
            expires_at,
            user_id,
            email,
        })
    }

    pub fn needs_refresh(&self, now: i64) -> bool {
        self.expires_at - REFRESH_MARGIN_SECS <= now
    }
}

/// A string claim from a JWT's payload (no signature check: it's our own
/// token, used only to fill in the user id or email).
fn jwt_claim(token: &str, claim: &str) -> Option<String> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v.get(claim)?.as_str().map(str::to_string)
}

/// What the settings window may know about the account.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Type)]
pub struct AccountStatus {
    pub signed_in: bool,
    pub email: Option<String>,
}

/// Sent whenever the user signs in or out (including from a link, or when
/// the server ends the session).
#[derive(Serialize, Deserialize, Clone, Debug, Type, tauri_specta::Event)]
pub struct AccountChanged {
    pub status: AccountStatus,
    /// Set when a sign-in link failed, with the server's explanation.
    pub link_error: Option<String>,
}

static SESSION: Lazy<Mutex<Option<Session>>> = Lazy::new(|| Mutex::new(None));
static STORE_PATH: OnceCell<PathBuf> = OnceCell::new();
/// One refresh at a time: Supabase rotates refresh tokens.
static REFRESH_LOCK: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

pub fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Loads the stored session. Call once at startup.
pub fn init(app: &AppHandle) {
    let dir = crate::portable::app_data_dir(app)
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| std::env::temp_dir());
    let path = dir.join("account.json");
    let loaded = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Session>(&bytes).ok());
    if let Ok(mut s) = SESSION.lock() {
        *s = loaded;
    }
    let _ = STORE_PATH.set(path);
}

pub fn current() -> Option<Session> {
    SESSION.lock().ok().and_then(|s| s.clone())
}

pub fn is_signed_in() -> bool {
    current().is_some()
}

pub fn status() -> AccountStatus {
    let s = current();
    AccountStatus {
        signed_in: s.is_some(),
        email: s.map(|s| s.email).filter(|e| !e.is_empty()),
    }
}

fn persist(session: &Option<Session>) {
    let Some(path) = STORE_PATH.get() else {
        return;
    };
    let result = match session {
        Some(s) => write_private(path, &serde_json::to_vec(s).unwrap_or_default()),
        None => match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
    };
    if let Err(e) = result {
        log::error!("Could not save the PromptFlow session: {e}");
    }
}

/// Writes `bytes` so only the user can read them, replacing the file
/// atomically.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)
}

/// Replaces the session, saves it and tells the windows.
pub fn set(app: &AppHandle, session: Option<Session>) {
    let changed = {
        let Ok(mut s) = SESSION.lock() else {
            return;
        };
        let changed = s.as_ref().map(|x| &x.user_id) != session.as_ref().map(|x| &x.user_id);
        *s = session.clone();
        changed
    };
    persist(&session);
    if changed {
        emit_changed(app, None);
    }
}

pub fn emit_changed(app: &AppHandle, link_error: Option<String>) {
    let event = AccountChanged {
        status: status(),
        link_error,
    };
    if let Err(e) = event.emit(app) {
        log::warn!("Failed to emit account change: {e}");
    }
}

/// A session whose access token is good for a while, refreshing it first if
/// needed. A refresh the server refuses signs the user out.
pub async fn valid(app: &AppHandle) -> Result<Session, ApiError> {
    let session = current().ok_or_else(ApiError::not_signed_in)?;
    if !session.needs_refresh(now_secs()) {
        return Ok(session);
    }
    let _guard = REFRESH_LOCK.lock().await;
    // Another caller may have refreshed while this one waited.
    let session = current().ok_or_else(ApiError::not_signed_in)?;
    if !session.needs_refresh(now_secs()) {
        return Ok(session);
    }
    match api::refresh(&session.refresh_token).await {
        Ok(v) => {
            let fresh = Session::from_auth_json(&v, Some(&session.email), now_secs())
                .ok_or_else(|| ApiError::server("Unexpected sign-in response"))?;
            set(app, Some(fresh.clone()));
            Ok(fresh)
        }
        Err(e) if e.code == ErrorCode::Auth || e.status == 400 || e.status == 401 => {
            log::warn!("The PromptFlow session ended: {}", e.message);
            set(app, None);
            Err(ApiError::session_ended())
        }
        Err(e) => Err(e),
    }
}

/// Call when a signed-in request came back 401: the token is no good.
pub async fn force_refresh(app: &AppHandle) -> Result<Session, ApiError> {
    if let Ok(mut s) = SESSION.lock() {
        if let Some(session) = s.as_mut() {
            session.expires_at = 0;
        }
    }
    valid(app).await
}

// ---------------------------------------------------------------------------
// Sign-in links: promptflow://auth#access_token=…&refresh_token=…
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
pub enum LinkResult {
    /// The link carried a session; trade its refresh token for a fresh one.
    Tokens { refresh_token: String },
    /// The link says why it can't sign in (expired, already used…).
    Error(String),
    /// Not a sign-in link.
    NotAuth,
}

/// Reads a `promptflow://auth…` link. Query and fragment are both checked:
/// GoTrue puts tokens and errors in the fragment, some mail clients move
/// them to the query.
pub fn parse_link(link: &str) -> LinkResult {
    let Ok(parsed) = url::Url::parse(link.trim()) else {
        return LinkResult::NotAuth;
    };
    if parsed.scheme() != "promptflow" {
        return LinkResult::NotAuth;
    }
    // `promptflow://auth` puts "auth" in the host; `promptflow:/auth` in the path.
    let target = parsed
        .host_str()
        .map(str::to_string)
        .unwrap_or_else(|| parsed.path().trim_matches('/').to_string());
    if target != "auth" {
        return LinkResult::NotAuth;
    }
    let mut pairs: Vec<(String, String)> = Vec::new();
    for part in [parsed.query(), parsed.fragment()].into_iter().flatten() {
        pairs.extend(url::form_urlencoded::parse(part.as_bytes()).into_owned());
    }
    let get = |key: &str| {
        pairs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    if let Some(message) = get("error_description").or_else(|| get("error")) {
        return LinkResult::Error(message);
    }
    match get("refresh_token") {
        Some(refresh_token) => LinkResult::Tokens { refresh_token },
        None => LinkResult::Error("That sign-in link is incomplete. Ask for a new one.".into()),
    }
}

/// Signs in from a link the OS handed to the app. Reports the outcome to the
/// windows and shows the settings window so the user sees it worked.
pub async fn complete_link(app: &AppHandle, link: &str) {
    match parse_link(link) {
        LinkResult::NotAuth => {
            log::debug!("Ignoring a promptflow:// link that isn't for signing in");
        }
        LinkResult::Error(message) => {
            log::warn!("Sign-in link failed: {message}");
            emit_changed(app, Some(message));
        }
        LinkResult::Tokens { refresh_token } => match api::refresh(&refresh_token).await {
            Ok(v) => match Session::from_auth_json(&v, None, now_secs()) {
                Some(session) => {
                    set(app, Some(session));
                    // `set` only emits on a change of user; always confirm here.
                    emit_changed(app, None);
                    super::commands::after_sign_in(app.clone());
                }
                None => emit_changed(app, Some("Unexpected sign-in response".into())),
            },
            Err(e) => emit_changed(app, Some(e.message)),
        },
    }
    crate::show_main_window_public(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_tokens_from_the_fragment() {
        let link = "promptflow://auth#access_token=a.b.c&refresh_token=r123&expires_in=3600&token_type=bearer&type=magiclink";
        assert_eq!(
            parse_link(link),
            LinkResult::Tokens {
                refresh_token: "r123".into()
            }
        );
    }

    #[test]
    fn parses_tokens_from_the_query_too() {
        assert_eq!(
            parse_link("promptflow://auth?refresh_token=r%2B1"),
            LinkResult::Tokens {
                refresh_token: "r+1".into()
            }
        );
    }

    #[test]
    fn reports_link_errors_in_plain_words() {
        let link = "promptflow://auth#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";
        assert_eq!(
            parse_link(link),
            LinkResult::Error("Email link is invalid or has expired".into())
        );
    }

    #[test]
    fn incomplete_and_foreign_links() {
        assert!(matches!(
            parse_link("promptflow://auth#access_token=x"),
            LinkResult::Error(_)
        ));
        assert_eq!(
            parse_link("https://example.com/auth#refresh_token=x"),
            LinkResult::NotAuth
        );
        assert_eq!(
            parse_link("promptflow://settings#refresh_token=x"),
            LinkResult::NotAuth
        );
        assert_eq!(parse_link("not a url"), LinkResult::NotAuth);
    }

    #[test]
    fn session_from_verify_response() {
        let v = json!({
            "access_token": "a.b.c",
            "refresh_token": "r",
            "expires_in": 3600,
            "user": {"id": "u1", "email": "me@example.com"}
        });
        let s = Session::from_auth_json(&v, None, 1000).unwrap();
        assert_eq!(s.expires_at, 4600);
        assert_eq!(s.user_id, "u1");
        assert_eq!(s.email, "me@example.com");
        assert!(!s.needs_refresh(1000));
        assert!(s.needs_refresh(4500));
    }

    #[test]
    fn session_falls_back_to_token_claims() {
        use base64::Engine;
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"sub":"u2","email":"jwt@example.com"}"#);
        let token = format!("h.{payload}.s");
        let v = json!({"access_token": token, "refresh_token": "r", "expires_at": 99});
        let s = Session::from_auth_json(&v, Some("typed@example.com"), 0).unwrap();
        assert_eq!(s.user_id, "u2");
        assert_eq!(s.email, "jwt@example.com");
        assert_eq!(s.expires_at, 99);
    }

    #[test]
    fn session_needs_tokens() {
        assert!(Session::from_auth_json(&json!({"access_token": "a"}), None, 0).is_none());
        assert!(Session::from_auth_json(
            &json!({"access_token": "", "refresh_token": "r", "user": {"id": "u"}}),
            None,
            0
        )
        .is_none());
    }

    #[test]
    fn private_write_is_owner_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("account.json");
        write_private(&path, b"{}").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"{}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
