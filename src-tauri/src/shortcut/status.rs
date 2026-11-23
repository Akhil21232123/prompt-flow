//! Which shortcuts failed to register, so Settings can say so instead of
//! the key silently doing nothing (⌘Space while Spotlight holds it, a key
//! another app took), and whether a shortcut is being recorded in
//! Settings (so the Fn key stays quiet meanwhile).

use crate::settings::ShortcutBinding;
use serde::Serialize;
use specta::Type;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

static CAPTURING: AtomicBool = AtomicBool::new(false);

/// A new shortcut is being recorded in Settings.
pub fn set_capturing(on: bool) {
    CAPTURING.store(on, Ordering::Relaxed);
}

pub fn capturing() -> bool {
    CAPTURING.load(Ordering::Relaxed)
}

static PROBLEMS: Mutex<BTreeMap<String, (String, String)>> = Mutex::new(BTreeMap::new());
/// What's registered now (binding id → key), so registering a key that's
/// already ours again (a resume after capture) isn't reported as a problem.
static REGISTERED: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

#[derive(Serialize, Debug, Clone, PartialEq, Eq, Type)]
pub struct ShortcutProblem {
    pub id: String,
    /// The key that didn't register, e.g. "command+space".
    pub binding: String,
    pub error: String,
}

/// Whether a binding is set at all. An empty binding is off.
pub fn is_set(binding: &ShortcutBinding) -> bool {
    !binding.current_binding.trim().is_empty()
}

/// Remembers how registering `binding` went.
pub fn note(binding: &ShortcutBinding, result: &Result<(), String>) {
    // Cancel (Escape) is registered only while recording.
    if binding.id == "cancel" {
        return;
    }
    let (Ok(mut problems), Ok(mut registered)) = (PROBLEMS.lock(), REGISTERED.lock()) else {
        return;
    };
    match result {
        Ok(()) => {
            problems.remove(&binding.id);
            registered.insert(binding.id.clone(), binding.current_binding.clone());
        }
        Err(_) if registered.get(&binding.id) == Some(&binding.current_binding) => {}
        Err(e) => {
            problems.insert(
                binding.id.clone(),
                (binding.current_binding.clone(), e.clone()),
            );
        }
    }
}

/// The binding was unregistered (or unset): nothing to report for it.
pub fn clear(id: &str) {
    if let Ok(mut problems) = PROBLEMS.lock() {
        problems.remove(id);
    }
    if let Ok(mut registered) = REGISTERED.lock() {
        registered.remove(id);
    }
}

fn list() -> Vec<ShortcutProblem> {
    PROBLEMS
        .lock()
        .map(|p| {
            p.iter()
                .map(|(id, (binding, error))| ShortcutProblem {
                    id: id.clone(),
                    binding: binding.clone(),
                    error: error.clone(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Shortcuts that are set but didn't register.
#[tauri::command]
#[specta::specta]
pub fn shortcut_problems() -> Vec<ShortcutProblem> {
    list()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(id: &str, key: &str) -> ShortcutBinding {
        ShortcutBinding {
            id: id.into(),
            name: id.into(),
            description: String::new(),
            default_binding: key.into(),
            current_binding: key.into(),
        }
    }

    #[test]
    fn a_failed_key_is_reported_until_it_registers() {
        let plain = binding("transcribe_test_only", "command+space");
        note(&plain, &Err("already in use".into()));
        assert!(list()
            .iter()
            .any(|p| p.id == "transcribe_test_only" && p.binding == "command+space"));
        note(&plain, &Ok(()));
        assert!(!list().iter().any(|p| p.id == "transcribe_test_only"));
        // Registering our own key again (a resume) isn't a problem.
        note(&plain, &Err("already in use".into()));
        assert!(!list().iter().any(|p| p.id == "transcribe_test_only"));
        clear("transcribe_test_only");
        note(&binding("cancel", "escape"), &Err("x".into()));
        assert!(!list().iter().any(|p| p.id == "cancel"));
        assert!(!is_set(&binding("this", " ")));
        assert!(is_set(&binding("this", "f5")));
    }
}
