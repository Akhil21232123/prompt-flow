//! The macOS grants PromptFlow's keys depend on, and spotting one macOS
//! dropped without saying so.
//!
//! PromptFlow is ad-hoc signed, and every update has a new signature. macOS
//! ties Accessibility to the signature, so after an update System Settings
//! still shows PromptFlow switched on while macOS no longer trusts it: no
//! shortcut, no Fn key, no paste. The only fix is to remove PromptFlow from
//! the list and add it again, so PromptFlow says exactly that.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Type)]
pub struct PermissionHealth {
    /// macOS trusts PromptFlow with Accessibility right now.
    pub accessibility: bool,
    /// It was allowed before, and macOS dropped it (an update).
    pub accessibility_reset: bool,
    /// Input Monitoring, which the Fn key's listener needs.
    pub input_monitoring: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct Seen {
    /// This Mac has trusted PromptFlow with Accessibility before.
    accessibility: bool,
    /// The build that last showed the "re-allow" island at launch.
    #[serde(default)]
    warned_build: Option<u32>,
}

/// Not trusted now, but trusted before (recorded on this Mac): macOS
/// dropped the grant rather than the user never giving it ("Later").
pub fn looks_reset(trusted: bool, seen_before: bool) -> bool {
    !trusted && seen_before
}

/// The launch island says so at most once per build.
pub fn should_warn_at_launch(reset: bool, warned_build: Option<u32>, build: u32) -> bool {
    reset && warned_build != Some(build)
}

pub fn accessibility_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" {
            fn AXIsProcessTrusted() -> u8;
        }
        unsafe { AXIsProcessTrusted() != 0 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

fn seen_path(app: &AppHandle) -> Option<PathBuf> {
    crate::portable::app_data_dir(app)
        .or_else(|_| app.path().app_data_dir())
        .ok()
        .map(|d| d.join("permissions_seen.json"))
}

fn read_seen(app: &AppHandle) -> Seen {
    seen_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_seen(app: &AppHandle, seen: &Seen) {
    if let Some(p) = seen_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(bytes) = serde_json::to_vec(seen) {
            let _ = std::fs::write(p, bytes);
        }
    }
}

pub fn health(app: &AppHandle) -> PermissionHealth {
    let trusted = accessibility_trusted();
    let mut seen = read_seen(app);
    if trusted && !seen.accessibility {
        seen.accessibility = true;
        write_seen(app, &seen);
    }
    PermissionHealth {
        accessibility: trusted,
        accessibility_reset: looks_reset(trusted, seen.accessibility),
        input_monitoring: crate::fn_key::input_monitoring_allowed(),
    }
}

#[tauri::command]
#[specta::specta]
pub fn permission_health(app: AppHandle) -> PermissionHealth {
    health(&app)
}

/// Clears macOS's stale Accessibility entry, asks again and opens the
/// pane, so the user only has to switch PromptFlow on.
#[tauri::command]
#[specta::specta]
pub async fn fix_accessibility(app: AppHandle) -> Result<(), String> {
    crate::commands::reset_macos_permission(
        app.clone(),
        crate::commands::MacPermission::Accessibility,
    )?;
    tauri_plugin_macos_permissions::request_accessibility_permission().await;
    crate::cloud::commands::open_privacy_settings(
        crate::cloud::commands::PrivacyPane::Accessibility,
    )
}

/// A few seconds after launch: if an update cost PromptFlow its
/// Accessibility grant, say so in the island (nothing would work otherwise,
/// and System Settings looks fine).
pub fn check_at_startup(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        let h = health(&app);
        let build = crate::cloud::update::current_build();
        let mut seen = read_seen(&app);
        if should_warn_at_launch(h.accessibility_reset, seen.warned_build, build) {
            seen.warned_build = Some(build);
            write_seen(&app, &seen);
            log::warn!("macOS no longer trusts PromptFlow with Accessibility (likely an update)");
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                crate::cloud::pipeline::show_error(
                    &handle,
                    crate::island::IslandError::PermissionsReset,
                );
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dropped_grant_is_told_apart_from_a_new_install() {
        assert!(!looks_reset(true, true));
        assert!(!looks_reset(false, false), "never allowed (chose Later)");
        assert!(looks_reset(false, true));
    }

    #[test]
    fn the_launch_warning_shows_once_per_build() {
        assert!(should_warn_at_launch(true, None, 14));
        assert!(!should_warn_at_launch(true, Some(14), 14));
        assert!(should_warn_at_launch(true, Some(13), 14));
        assert!(!should_warn_at_launch(false, None, 14));
    }
}
