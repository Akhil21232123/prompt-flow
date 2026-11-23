//! HTTP plumbing for the PromptFlow backend, and every endpoint the Mac uses
//! apart from `/dictate`'s multipart body (see `dictate`).

use super::session;
use super::{BASE_URL, PUBLISHABLE_KEY};
use once_cell::sync::Lazy;
use reqwest::{Method, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use std::time::Duration;
use tauri::AppHandle;

/// What went wrong, as the island and the settings window show it. The
/// backend's `code` values plus the client's own.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// Not signed in, or the session ended.
    Auth,
    BadRequest,
    /// The AI or transcription provider failed.
    Provider,
    RateLimited,
    Quota,
    /// The server couldn't be reached.
    Network,
    /// Anything else the server got wrong.
    Server,
}

impl ErrorCode {
    fn parse(code: &str) -> Option<ErrorCode> {
        Some(match code {
            "auth" | "config" => ErrorCode::Auth,
            "bad_request" => ErrorCode::BadRequest,
            "provider" => ErrorCode::Provider,
            "rate_limited" => ErrorCode::RateLimited,
            "quota" => ErrorCode::Quota,
            _ => return None,
        })
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct ApiError {
    pub code: ErrorCode,
    /// The server's message for the user, or a short client-side one.
    pub message: String,
    pub status: u16,
    pub retry_after_sec: Option<u32>,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({:?}, {})", self.message, self.code, self.status)
    }
}

impl ApiError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        ApiError {
            code,
            message: message.into(),
            status: 0,
            retry_after_sec: None,
        }
    }
    pub fn not_signed_in() -> Self {
        ApiError {
            status: 401,
            ..Self::new(ErrorCode::Auth, "Sign in to PromptFlow first")
        }
    }
    pub fn session_ended() -> Self {
        ApiError {
            status: 401,
            ..Self::new(ErrorCode::Auth, "Your session ended. Sign in again.")
        }
    }
    pub fn server(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Server, message)
    }
    fn network(e: &reqwest::Error) -> Self {
        let message = if e.is_timeout() {
            "PromptFlow took too long to answer"
        } else {
            "Can't reach PromptFlow. Check your internet connection."
        };
        log::warn!("PromptFlow request failed: {e}");
        Self::new(ErrorCode::Network, message)
    }
}

/// The backend's error shape: `{"error": "...", "code": "...", "retry_after_sec": n}`,
/// or GoTrue's `{"msg"|"error_description": "..."}`.
pub fn parse_error(status: u16, body: &str, retry_after_header: Option<u32>) -> ApiError {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let text = |key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
    let message = text("error_description")
        .or_else(|| text("msg"))
        .or_else(|| text("message"))
        .or_else(|| text("error"))
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| format!("PromptFlow had a problem ({status})"));
    let code = text("code")
        .as_deref()
        .and_then(ErrorCode::parse)
        .unwrap_or(match status {
            401 | 403 => ErrorCode::Auth,
            429 => ErrorCode::RateLimited,
            400 | 404 | 413 | 422 => ErrorCode::BadRequest,
            _ => ErrorCode::Server,
        });
    let retry_after_sec = v
        .get("retry_after_sec")
        .and_then(Value::as_f64)
        .map(|s| s.ceil().max(0.0) as u32)
        .or(retry_after_header);
    ApiError {
        code,
        message,
        status,
        retry_after_sec,
    }
}

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(90))
        .user_agent(concat!("promptflow-mac/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default()
});

fn request(method: Method, path: &str) -> RequestBuilder {
    CLIENT
        .request(method, format!("{BASE_URL}{path}"))
        .header("apikey", PUBLISHABLE_KEY)
        .header("x-client-info", "promptflow-mac")
}

/// Sends `req` and returns the body of a 2xx answer.
pub async fn send(req: RequestBuilder) -> Result<String, ApiError> {
    let resp = req.send().await.map_err(|e| ApiError::network(&e))?;
    let status = resp.status();
    let retry_after = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.trim().parse::<u32>().ok());
    let body = resp.text().await.map_err(|e| ApiError::network(&e))?;
    if status.is_success() {
        Ok(body)
    } else {
        Err(parse_error(status.as_u16(), &body, retry_after))
    }
}

fn json_body(body: &str) -> Result<Value, ApiError> {
    if body.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(body)
        .map_err(|_| ApiError::server("PromptFlow sent an answer it couldn't read"))
}

/// A signed-in request. `build` makes the request (called again for one
/// retry after a refresh when the server says the token is no good).
pub async fn authed<F>(app: &AppHandle, build: F) -> Result<String, ApiError>
where
    F: Fn() -> RequestBuilder,
{
    let s = session::valid(app).await?;
    match send(build().bearer_auth(&s.access_token)).await {
        Err(e) if e.status == StatusCode::UNAUTHORIZED.as_u16() => {
            let s = session::force_refresh(app).await?;
            send(build().bearer_auth(&s.access_token)).await
        }
        other => other,
    }
}

pub async fn authed_json<F>(app: &AppHandle, build: F) -> Result<Value, ApiError>
where
    F: Fn() -> RequestBuilder,
{
    json_body(&authed(app, build).await?)
}

pub fn post(path: &str) -> RequestBuilder {
    request(Method::POST, path)
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/// Sends the sign-in email (a link back to promptflow://auth and a code).
pub async fn send_code(email: &str) -> Result<(), ApiError> {
    send(
        request(
            Method::POST,
            "/auth/v1/otp?redirect_to=promptflow%3A%2F%2Fauth",
        )
        .json(&json!({"email": email, "create_user": true})),
    )
    .await
    .map(|_| ())
}

pub async fn verify_code(email: &str, code: &str) -> Result<Value, ApiError> {
    json_body(
        &send(
            request(Method::POST, "/auth/v1/verify")
                .json(&json!({"type": "email", "email": email, "token": code})),
        )
        .await?,
    )
}

pub async fn refresh(refresh_token: &str) -> Result<Value, ApiError> {
    json_body(
        &send(
            request(Method::POST, "/auth/v1/token?grant_type=refresh_token")
                .json(&json!({"refresh_token": refresh_token})),
        )
        .await?,
    )
}

/// Ends the session on the server too (best effort).
pub async fn sign_out(access_token: &str) {
    if let Err(e) =
        send(request(Method::POST, "/auth/v1/logout?scope=local").bearer_auth(access_token)).await
    {
        log::debug!("Server sign-out failed: {e}");
    }
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
pub struct Usage {
    pub today: u32,
    pub daily_limit: u32,
    pub plan: String,
}

pub fn parse_usage(v: &Value) -> Usage {
    let num = |k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0) as u32;
    Usage {
        today: num("today"),
        daily_limit: num("daily_limit"),
        plan: v
            .get("plan")
            .and_then(Value::as_str)
            .unwrap_or("beta")
            .to_string(),
    }
}

pub async fn usage(app: &AppHandle) -> Result<Usage, ApiError> {
    let v = authed_json(app, || request(Method::GET, "/functions/v1/usage")).await?;
    Ok(parse_usage(&v))
}

pub async fn delete_account(app: &AppHandle) -> Result<(), ApiError> {
    authed(app, || {
        request(Method::POST, "/functions/v1/delete_account").json(&json!({}))
    })
    .await
    .map(|_| ())
}

// ---------------------------------------------------------------------------
// Autopilot
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct CheckResult {
    /// The answer did what was asked.
    pub good: bool,
    pub issues: Vec<String>,
    pub follow_up: Option<String>,
}

pub fn parse_check(v: &Value) -> Result<CheckResult, ApiError> {
    let verdict = v
        .get("verdict")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::server("PromptFlow sent an answer it couldn't read"))?;
    let issues = v
        .get("issues")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .take(3)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let good = verdict == "good";
    let follow_up = v
        .get("follow_up")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && !good)
        .map(str::to_string);
    Ok(CheckResult {
        good,
        issues,
        follow_up,
    })
}

/// The longest answer the backend reads.
pub const CHECK_ANSWER_MAX: usize = 12_000;

pub async fn check(
    app: &AppHandle,
    intent: &str,
    answer: &str,
    app_name: Option<&str>,
) -> Result<CheckResult, ApiError> {
    let body = json!({
        "intent": intent,
        "answer": super::context::tail_chars(answer, CHECK_ANSWER_MAX),
        "app": {"name": app_name.unwrap_or("")},
    });
    let v = authed_json(app, || {
        request(Method::POST, "/functions/v1/check").json(&body)
    })
    .await?;
    parse_check(&v)
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct Memory {
    pub id: String,
    pub content: String,
    pub kind: String,
    pub source: String,
    pub pinned: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub last_used_at: Option<String>,
}

pub const MEMORY_KINDS: &[&str] = &["fact", "preference", "project", "person"];
pub const MEMORY_MAX_CHARS: usize = 280;

fn memories_from(v: Value) -> Vec<Memory> {
    match v {
        Value::Array(rows) => rows
            .into_iter()
            .filter_map(|r| serde_json::from_value::<Memory>(r).ok())
            .collect(),
        other => serde_json::from_value::<Memory>(other)
            .map(|m| vec![m])
            .unwrap_or_default(),
    }
}

pub async fn memories(app: &AppHandle) -> Result<Vec<Memory>, ApiError> {
    let v = authed_json(app, || {
        request(
            Method::GET,
            "/rest/v1/memories?select=*&order=pinned.desc,updated_at.desc",
        )
    })
    .await?;
    Ok(memories_from(v))
}

pub async fn add_memory(app: &AppHandle, content: &str, kind: &str) -> Result<Memory, ApiError> {
    let user_id = session::valid(app).await?.user_id;
    let body = json!({
        "user_id": user_id,
        "content": content,
        "kind": kind,
        "source": "manual",
    });
    let v = authed_json(app, || {
        request(Method::POST, "/rest/v1/memories")
            .header("Prefer", "return=representation")
            .json(&body)
    })
    .await?;
    memories_from(v)
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::server("PromptFlow didn't save that memory"))
}

pub async fn update_memory(app: &AppHandle, id: &str, patch: Value) -> Result<Memory, ApiError> {
    let path = format!("/rest/v1/memories?id=eq.{}", urlencode(id));
    let v = authed_json(app, || {
        request(Method::PATCH, &path)
            .header("Prefer", "return=representation")
            .json(&patch)
    })
    .await?;
    memories_from(v)
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::server("That memory is gone"))
}

pub async fn delete_memory(app: &AppHandle, id: &str) -> Result<(), ApiError> {
    let path = format!("/rest/v1/memories?id=eq.{}", urlencode(id));
    authed(app, || request(Method::DELETE, &path))
        .await
        .map(|_| ())
}

fn urlencode(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

// ---------------------------------------------------------------------------
// Settings (`user_settings.settings`)
// ---------------------------------------------------------------------------

pub async fn get_settings(app: &AppHandle) -> Result<Value, ApiError> {
    let v = authed_json(app, || {
        request(
            Method::GET,
            "/rest/v1/user_settings?select=settings&limit=1",
        )
    })
    .await?;
    Ok(v.get(0)
        .and_then(|row| row.get("settings"))
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({})))
}

/// Merges `patch` into the server's settings without overwriting keys other
/// devices own: the `merge_settings` RPC when the backend has it, otherwise
/// read, merge and write.
pub async fn merge_settings(app: &AppHandle, patch: Value) -> Result<Value, ApiError> {
    let body = json!({"patch": patch});
    match authed_json(app, || {
        request(Method::POST, "/rest/v1/rpc/merge_settings").json(&body)
    })
    .await
    {
        Ok(v) if v.is_object() => return Ok(v),
        Ok(_) => return get_settings(app).await,
        Err(e) if e.status == 404 => {}
        Err(e) => return Err(e),
    }
    let mut merged = get_settings(app).await?;
    merge_json(&mut merged, &patch);
    let user_id = session::valid(app).await?.user_id;
    let row = json!({"user_id": user_id, "settings": merged});
    authed(app, || {
        request(Method::POST, "/rest/v1/user_settings?on_conflict=user_id")
            .header("Prefer", "resolution=merge-duplicates,return=minimal")
            .json(&row)
    })
    .await?;
    Ok(merged)
}

/// Shallow merge of `patch`'s keys into `target` (an object).
pub fn merge_json(target: &mut Value, patch: &Value) {
    if !target.is_object() {
        *target = json!({});
    }
    if let (Some(t), Some(p)) = (target.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            t.insert(k.clone(), v.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_errors_keep_code_message_and_retry() {
        let e = parse_error(
            429,
            r#"{"error":"Slow down a little","code":"rate_limited","retry_after_sec":12}"#,
            None,
        );
        assert_eq!(e.code, ErrorCode::RateLimited);
        assert_eq!(e.message, "Slow down a little");
        assert_eq!(e.retry_after_sec, Some(12));

        let q = parse_error(429, r#"{"error":"Daily limit","code":"quota"}"#, Some(3600));
        assert_eq!(q.code, ErrorCode::Quota);
        assert_eq!(q.retry_after_sec, Some(3600));
    }

    #[test]
    fn gotrue_and_unknown_errors() {
        let e = parse_error(400, r#"{"msg":"Token has expired or is invalid"}"#, None);
        assert_eq!(e.code, ErrorCode::BadRequest);
        assert_eq!(e.message, "Token has expired or is invalid");
        let e = parse_error(401, "", None);
        assert_eq!(e.code, ErrorCode::Auth);
        let e = parse_error(502, "<html>bad gateway</html>", None);
        assert_eq!(e.code, ErrorCode::Server);
        assert!(e.message.contains("502"));
        let e = parse_error(500, r#"{"error":"x","code":"provider"}"#, None);
        assert_eq!(e.code, ErrorCode::Provider);
    }

    #[test]
    fn check_verdicts() {
        let v = serde_json::json!({
            "verdict": "missed",
            "issues": ["Used JavaScript; you asked for Python", "", "a", "b"],
            "follow_up": "Please rewrite it in Python."
        });
        let r = parse_check(&v).unwrap();
        assert!(!r.good);
        assert_eq!(r.issues.len(), 3);
        assert_eq!(r.follow_up.as_deref(), Some("Please rewrite it in Python."));

        let good = parse_check(&serde_json::json!({"verdict": "good", "follow_up": "x"})).unwrap();
        assert!(good.good);
        assert!(good.follow_up.is_none());
        assert!(parse_check(&serde_json::json!({})).is_err());
    }

    #[test]
    fn usage_and_memories_parse_leniently() {
        let u = parse_usage(&serde_json::json!({"today": 37, "daily_limit": 300, "plan": "beta"}));
        assert_eq!((u.today, u.daily_limit, u.plan.as_str()), (37, 300, "beta"));
        let rows = serde_json::json!([
            {"id": "1", "content": "Building PromptFlow", "kind": "project", "source": "auto",
             "pinned": true, "created_at": "t", "updated_at": "t", "last_used_at": null},
            {"broken": true}
        ]);
        let m = memories_from(rows);
        assert_eq!(m.len(), 1);
        assert!(m[0].pinned);
    }

    #[test]
    fn merge_is_shallow_and_keeps_other_keys() {
        let mut target = serde_json::json!({"memory_enabled": true, "theme": "dark"});
        merge_json(&mut target, &serde_json::json!({"memory_enabled": false}));
        assert_eq!(
            target,
            serde_json::json!({"memory_enabled": false, "theme": "dark"})
        );
        let mut empty = Value::Null;
        merge_json(&mut empty, &serde_json::json!({"a": 1}));
        assert_eq!(empty, serde_json::json!({"a": 1}));
    }
}
