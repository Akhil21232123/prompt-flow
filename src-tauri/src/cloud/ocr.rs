//! On-device text recognition for "This" and Autopilot, for apps whose text
//! the Accessibility API can't reach (images, PDFs, canvas apps, games).
//!
//! The focused window is captured with `screencapture` (needs Screen
//! Recording permission; PromptFlow never asks for it mid-dictation) and read
//! by macOS Vision in a helper process: PromptFlow runs its own binary with
//! `--pf-ocr <png>`. A Vision failure or hang can then only end the helper,
//! never the app, and it is killed after a few seconds.

use std::time::{Duration, Instant};

const HELPER_FLAG: &str = "--pf-ocr";
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(3);
const HELPER_TIMEOUT: Duration = Duration::from_secs(8);

/// Runs the OCR helper when this process was started as one. Call first
/// thing in `main`; `Some(exit code)` means exit now.
pub fn run_helper_if_invoked() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(HELPER_FLAG)) {
        return None;
    }
    let Some(path) = args.next() else {
        return Some(2);
    };
    Some(match platform::recognize(&path.to_string_lossy()) {
        Ok(text) => {
            use std::io::Write;
            let mut out = std::io::stdout().lock();
            let _ = out.write_all(text.as_bytes());
            let _ = out.flush();
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    })
}

/// Whether macOS lets PromptFlow capture other apps' windows.
pub fn screen_capture_allowed() -> bool {
    platform::screen_capture_allowed()
}

/// Shows macOS's Screen Recording prompt (first time) or does nothing.
pub fn request_screen_capture() -> bool {
    platform::request_screen_capture()
}

/// Text recognised in the focused window, or `None` (no permission, nothing
/// found, or it took too long).
pub fn read_focused_window() -> Option<String> {
    if !screen_capture_allowed() {
        log::debug!("OCR skipped: Screen Recording is not allowed");
        return None;
    }
    let (x, y, w, h) = super::context::focused_window_frame()?;
    let png = std::env::temp_dir().join(format!(
        "promptflow-ocr-{}-{}.png",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    let text = capture_and_read(x, y, w, h, &png);
    let _ = std::fs::remove_file(&png);
    text
}

fn capture_and_read(x: f64, y: f64, w: f64, h: f64, png: &std::path::Path) -> Option<String> {
    let region = format!("{},{},{},{}", x.round(), y.round(), w.round(), h.round());
    let started = Instant::now();
    let captured = run_with_timeout(
        std::process::Command::new("/usr/sbin/screencapture")
            .args(["-x", "-o", "-t", "png", "-R", &region])
            .arg(png),
        CAPTURE_TIMEOUT,
    )
    .is_some_and(|out| out.status.success());
    if !captured || !png.exists() {
        log::warn!("OCR: the window capture failed");
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let out = run_with_timeout(
        std::process::Command::new(exe).arg(HELPER_FLAG).arg(png),
        HELPER_TIMEOUT,
    )?;
    if !out.status.success() {
        log::warn!(
            "OCR helper failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    log::debug!(
        "OCR read {} chars in {:?}",
        text.chars().count(),
        started.elapsed()
    );
    (!text.is_empty()).then_some(text)
}

/// Runs `cmd`, killing it after `timeout`.
fn run_with_timeout(
    cmd: &mut std::process::Command,
    timeout: Duration,
) -> Option<std::process::Output> {
    use std::process::Stdio;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    // Drain stdout on a thread so a large result can't fill the pipe and
    // stall the child before it exits.
    let stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stdout {
            use std::io::Read;
            let _ = s.read_to_end(&mut buf);
        }
        buf
    });
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!("A helper took longer than {timeout:?} and was stopped");
                return None;
            }
        }
    };
    let stdout = reader.join().unwrap_or_default();
    let mut stderr = Vec::new();
    if let Some(mut s) = child.stderr.take() {
        use std::io::Read;
        let _ = s.read_to_end(&mut stderr);
    }
    Some(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

/// Orders recognised lines top to bottom, then left to right. Vision boxes
/// are normalised with the origin at the bottom left.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn reading_order(mut lines: Vec<(f64, f64, String)>) -> String {
    lines.sort_by(|a, b| {
        // Same row when the tops are within 1% of the image height.
        if (a.1 - b.1).abs() < 0.01 {
            a.0.total_cmp(&b.0)
        } else {
            b.1.total_cmp(&a.1)
        }
    });
    lines
        .into_iter()
        .map(|(_, _, t)| t)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, sel};
    use objc2_foundation::{NSArray, NSDictionary, NSError, NSRect, NSString, NSURL};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    #[link(name = "Vision", kind = "framework")]
    extern "C" {}

    pub fn screen_capture_allowed() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    pub fn request_screen_capture() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }

    /// Runs in the helper process only.
    pub fn recognize(path: &str) -> Result<String, String> {
        let request_class =
            AnyClass::get(c"VNRecognizeTextRequest").ok_or("Text recognition isn't available")?;
        let handler_class =
            AnyClass::get(c"VNImageRequestHandler").ok_or("Text recognition isn't available")?;
        unsafe {
            let request: Retained<AnyObject> = msg_send![request_class, new];
            // VNRequestTextRecognitionLevelAccurate
            let _: () = msg_send![&*request, setRecognitionLevel: 0isize];
            let _: () = msg_send![&*request, setUsesLanguageCorrection: true];
            let detects: Bool = msg_send![
                &*request,
                respondsToSelector: sel!(setAutomaticallyDetectsLanguage:)
            ];
            if detects.as_bool() {
                let _: () = msg_send![&*request, setAutomaticallyDetectsLanguage: true];
            }

            let url = NSURL::fileURLWithPath(&NSString::from_str(path));
            let options = NSDictionary::<NSString, AnyObject>::new();
            let handler: Allocated<AnyObject> = msg_send![handler_class, alloc];
            let handler: Retained<AnyObject> =
                msg_send![handler, initWithURL: &*url, options: &*options];

            let requests = NSArray::from_retained_slice(&[request.clone()]);
            let performed: Result<(), Retained<NSError>> =
                msg_send![&*handler, performRequests: &*requests, error: _];
            if let Err(e) = performed {
                return Err(e.localizedDescription().to_string());
            }

            let results: Option<Retained<NSArray<AnyObject>>> = msg_send![&*request, results];
            let Some(results) = results else {
                return Ok(String::new());
            };
            let mut lines = Vec::new();
            for observation in results.iter() {
                let candidates: Retained<NSArray<AnyObject>> =
                    msg_send![&*observation, topCandidates: 1usize];
                let Some(best) = candidates.firstObject() else {
                    continue;
                };
                let text: Retained<NSString> = msg_send![&*best, string];
                let bbox: NSRect = msg_send![&*observation, boundingBox];
                let top = bbox.origin.y + bbox.size.height;
                lines.push((bbox.origin.x, top, text.to_string()));
            }
            Ok(super::reading_order(lines))
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn screen_capture_allowed() -> bool {
        false
    }

    pub fn request_screen_capture() -> bool {
        false
    }

    pub fn recognize(_path: &str) -> Result<String, String> {
        Err("Text recognition needs macOS".into())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn lines_read_top_to_bottom_then_left_to_right() {
        let lines = vec![
            (0.5, 0.5, "middle right".to_string()),
            (0.1, 0.9, "top".to_string()),
            (0.1, 0.505, "middle left".to_string()),
            (0.1, 0.1, "bottom".to_string()),
        ];
        assert_eq!(
            super::reading_order(lines),
            "top\nmiddle left\nmiddle right\nbottom"
        );
    }
}
