//! "Update available": compares this build with the `mac-latest` release.
//!
//! CI embeds its run number as `PROMPTFLOW_BUILD` and writes the same number
//! into the release notes (`build:<n>`) when it publishes. Local builds have
//! no number and never report an update.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use std::time::Duration;

const RELEASE_URL: &str =
    "https://api.github.com/repos/Akhil21232123/prompt-flow/releases/tags/mac-latest";
const RELEASE_PAGE: &str = "https://github.com/Akhil21232123/prompt-flow/releases/tag/mac-latest";

/// This build's CI run number; 0 for local builds.
pub fn current_build() -> u32 {
    option_env!("PROMPTFLOW_BUILD")
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct UpdateInfo {
    pub available: bool,
    pub current_build: u32,
    pub latest_build: Option<u32>,
    /// The .dmg to download (or the release page).
    pub download_url: String,
}

static BUILD_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bbuild[\s:#-]*(\d+)").expect("valid regex"));

/// Reads a GitHub release.
pub fn parse_release(v: &Value, current: u32) -> UpdateInfo {
    let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default();
    let latest_build = [text("body"), text("name")]
        .iter()
        .find_map(|t| BUILD_RE.captures(t))
        .and_then(|c| c[1].parse::<u32>().ok());
    let download_url = v
        .get("assets")
        .and_then(Value::as_array)
        .and_then(|assets| {
            assets.iter().find(|a| {
                a.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| n.ends_with(".dmg"))
            })
        })
        .and_then(|a| a.get("browser_download_url"))
        .and_then(Value::as_str)
        .unwrap_or(RELEASE_PAGE)
        .to_string();
    UpdateInfo {
        available: current > 0 && latest_build.is_some_and(|b| b > current),
        current_build: current,
        latest_build,
        download_url,
    }
}

pub async fn check() -> Result<UpdateInfo, String> {
    let current = current_build();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("promptflow-mac-update-check")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(RELEASE_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GitHub answered {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parse_release(&v, current))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn release(body: &str) -> Value {
        json!({
            "name": "PromptFlow for Mac (latest build)",
            "body": body,
            "assets": [
                {"name": "notes.txt", "browser_download_url": "https://x/notes.txt"},
                {"name": "PromptFlow.dmg", "browser_download_url": "https://x/PromptFlow.dmg"}
            ]
        })
    }

    #[test]
    fn newer_build_is_an_update() {
        let info = parse_release(&release("Apple silicon.\n\nbuild:42"), 40);
        assert!(info.available);
        assert_eq!(info.latest_build, Some(42));
        assert_eq!(info.download_url, "https://x/PromptFlow.dmg");
    }

    #[test]
    fn same_or_older_build_is_not() {
        assert!(!parse_release(&release("build:40"), 40).available);
        assert!(!parse_release(&release("Build 39"), 40).available);
    }

    #[test]
    fn local_builds_and_unnumbered_releases_never_update() {
        assert!(!parse_release(&release("build:99"), 0).available);
        let info = parse_release(&json!({"body": "no number"}), 10);
        assert!(!info.available);
        assert_eq!(info.latest_build, None);
        assert_eq!(info.download_url, RELEASE_PAGE);
    }
}
