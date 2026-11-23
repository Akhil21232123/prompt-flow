//! PromptFlow cloud: the account, the `/dictate` pipeline, Memory, Autopilot
//! and everything else that talks to the PromptFlow backend (Supabase).
//!
//! Users never see or paste an API key: the app ships the project's
//! publishable key, and every signed-in call carries the user's own session.
//! The local Handy pipeline stays available as Private mode.
//!
//! - `session`  — the signed-in session: storage, refresh, sign-in links
//! - `api`      — HTTP plumbing and the backend's error shape
//! - `dictate`  — the `/dictate` request (meta, WAV) and its three answers
//! - `context`  — what's on screen: the focused field, selection, window text, OCR
//! - `ocr`      — on-device text recognition (macOS Vision) in a helper process
//! - `pipeline` — one recording from stop to paste, ask-back and Autopilot
//! - `commands` — what the settings window can call
//! - `update`   — "Update available" from the mac-latest release

pub mod api;
pub mod commands;
pub mod context;
pub mod dictate;
pub mod ocr;
pub mod pipeline;
pub mod session;
pub mod update;

use crate::settings::AppSettings;

/// The PromptFlow backend.
pub const BASE_URL: &str = "https://fhslwvrspzdcvokajvno.supabase.co";
/// The project's publishable key. Public by design; never a user secret.
pub const PUBLISHABLE_KEY: &str = "sb_publishable_havZ6UNdxBtt0AtqpBZaaw_Y_lr8Lss";

/// Whether recordings go to the PromptFlow cloud (the default) rather than
/// the on-device Private mode pipeline. True even when signed out, so a
/// signed-out press asks the user to sign in instead of silently doing
/// something else.
pub fn cloud_mode(settings: &AppSettings) -> bool {
    !settings.flow.private_mode
}
