//! Recordings that couldn't be sent, kept on disk until they are.
//!
//! When a request fails for a reason that may pass (no network, a server
//! error, a timeout), the audio and the request's meta are written to
//! `outbox/` in the app's data folder: `<request id>.wav` and `.json`. They
//! survive a quit, show in History as "Not sent", and leave the outbox when
//! they're sent or the user deletes them. At most `CAP` are kept; the oldest
//! goes first.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The most recordings kept waiting.
pub const CAP: usize = 10;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct OutboxItem {
    /// The request's `request_id`, sent again with every retry so the
    /// server can tell a retry from a new dictation.
    pub id: String,
    /// Unix seconds.
    pub created_at: i64,
    /// `dictate` | `engineer` | `command` (the meta's mode).
    pub mode: String,
    /// The `/dictate` meta, exactly as first sent.
    pub meta_json: String,
    pub app_name: Option<String>,
    pub bundle_id: Option<String>,
    pub target: Option<String>,
    pub duration_sec: f64,
}

/// What History shows for a recording that wasn't sent.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Type)]
pub struct PendingDictation {
    pub id: String,
    pub created_at: i64,
    pub mode: String,
    pub app_name: Option<String>,
    pub duration_sec: f64,
}

impl From<&OutboxItem> for PendingDictation {
    fn from(i: &OutboxItem) -> Self {
        PendingDictation {
            id: i.id.clone(),
            created_at: i.created_at,
            mode: i.mode.clone(),
            app_name: i.app_name.clone(),
            duration_sec: i.duration_sec,
        }
    }
}

fn dir(app: &AppHandle) -> Option<PathBuf> {
    crate::portable::app_data_dir(app)
        .or_else(|_| app.path().app_data_dir())
        .ok()
        .map(|d| d.join("outbox"))
}

/// A request id is a uuid; anything else never becomes a file name.
fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

pub fn save(app: &AppHandle, item: &OutboxItem, wav: &[u8]) -> Result<(), String> {
    let dir = dir(app).ok_or("No data folder")?;
    save_in(&dir, item, wav)
}

fn save_in(dir: &Path, item: &OutboxItem, wav: &[u8]) -> Result<(), String> {
    if !safe_id(&item.id) {
        return Err("Bad request id".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{}.wav", item.id)), wav).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec(item).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{}.json", item.id)), json).map_err(|e| e.to_string())?;
    // Keep the newest CAP.
    for old in list_in(dir).into_iter().skip(CAP) {
        remove_in(dir, &old.id);
    }
    Ok(())
}

/// Newest first.
pub fn list(app: &AppHandle) -> Vec<OutboxItem> {
    dir(app).map(|d| list_in(&d)).unwrap_or_default()
}

fn list_in(dir: &Path) -> Vec<OutboxItem> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut items: Vec<OutboxItem> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .filter_map(|p| std::fs::read(&p).ok())
        .filter_map(|b| serde_json::from_slice::<OutboxItem>(&b).ok())
        .filter(|i| safe_id(&i.id) && dir.join(format!("{}.wav", i.id)).exists())
        .collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.created_at));
    items
}

pub fn get(app: &AppHandle, id: &str) -> Option<(OutboxItem, Vec<u8>)> {
    let dir = dir(app)?;
    get_in(&dir, id)
}

fn get_in(dir: &Path, id: &str) -> Option<(OutboxItem, Vec<u8>)> {
    if !safe_id(id) {
        return None;
    }
    let item = serde_json::from_slice(&std::fs::read(dir.join(format!("{id}.json"))).ok()?).ok()?;
    let wav = std::fs::read(dir.join(format!("{id}.wav"))).ok()?;
    Some((item, wav))
}

pub fn remove(app: &AppHandle, id: &str) {
    if let Some(dir) = dir(app) {
        remove_in(&dir, id);
    }
}

fn remove_in(dir: &Path, id: &str) {
    if !safe_id(id) {
        return;
    }
    let _ = std::fs::remove_file(dir.join(format!("{id}.wav")));
    let _ = std::fs::remove_file(dir.join(format!("{id}.json")));
}

/// The samples of a 16-bit PCM WAV written by `dictate::encode_wav`.
pub fn wav_samples(wav: &[u8]) -> Vec<f32> {
    // Find the data chunk rather than assume a 44-byte header.
    let mut pos = 12;
    while pos + 8 <= wav.len() {
        let id = &wav[pos..pos + 4];
        let len =
            u32::from_le_bytes([wav[pos + 4], wav[pos + 5], wav[pos + 6], wav[pos + 7]]) as usize;
        let start = pos + 8;
        if id == b"data" {
            let end = (start + len).min(wav.len());
            return wav[start..end]
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / i16::MAX as f32)
                .collect();
        }
        pos = start + len + (len & 1);
    }
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, at: i64) -> OutboxItem {
        OutboxItem {
            id: id.into(),
            created_at: at,
            mode: "dictate".into(),
            meta_json: "{}".into(),
            app_name: Some("Notes".into()),
            bundle_id: None,
            target: None,
            duration_sec: 2.0,
        }
    }

    fn uuid(n: u32) -> String {
        format!("00000000-0000-4000-8000-{n:012}")
    }

    #[test]
    fn saved_recordings_survive_and_the_oldest_go_first() {
        let dir = tempfile::tempdir().unwrap();
        for n in 0..(CAP as u32 + 3) {
            save_in(dir.path(), &item(&uuid(n), n as i64), b"RIFFxxxx").unwrap();
        }
        let items = list_in(dir.path());
        assert_eq!(items.len(), CAP);
        assert_eq!(items[0].id, uuid(CAP as u32 + 2), "newest first");
        assert!(get_in(dir.path(), &uuid(0)).is_none(), "oldest dropped");
        let (got, wav) = get_in(dir.path(), &uuid(5)).unwrap();
        assert_eq!(got.app_name.as_deref(), Some("Notes"));
        assert_eq!(wav, b"RIFFxxxx");
        remove_in(dir.path(), &uuid(5));
        assert!(get_in(dir.path(), &uuid(5)).is_none());
    }

    #[test]
    fn ids_never_escape_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert!(save_in(dir.path(), &item("../../evil", 1), b"x").is_err());
        assert!(get_in(dir.path(), "../x").is_none());
    }

    #[test]
    fn wav_round_trip() {
        let wav = crate::cloud::dictate::encode_wav(&[0.0, 0.5, -0.5]);
        let s = wav_samples(&wav);
        assert_eq!(s.len(), 3);
        assert!((s[1] - 0.5).abs() < 0.001);
        assert!(wav_samples(b"nope").is_empty());
    }
}
