//! Cleaning a recording made somewhere very noisy (a busy café, traffic)
//! before it is transcribed, and leaving everything else exactly as it is.
//!
//! 1. **Measure.** The noise floor is the energy of the quiet 20 ms frames
//!    (the pre-roll before speech and the gaps between words), the speech
//!    level that of the loudest. Their ratio is the SNR.
//! 2. **Decide** ([`plan`]). Auto treats only clips below
//!    [`AUTO_THRESHOLD_DB`], and in the cloud it sends the raw recording
//!    *and* the filtered one: the server transcribes both and keeps the
//!    transcript Whisper is surer of. Always sends only the filtered one.
//!    On this Mac (Private mode) there's no second decode to compare, so
//!    only Always filters.
//! 3. **Denoise** with RNNoise (`nnnoiseless`, a pure-Rust port, BSD-3) at
//!    48 kHz: 16 kHz → 48 kHz → RNNoise in 480-sample frames → 16 kHz, with
//!    the resampler the recorder uses (rubato).
//! 4. **Level** speech gently toward -20 dBFS RMS (never more than +18 dB,
//!    never past -1 dBFS peak), so quiet speech over the noise isn't lost;
//!    never when the voice detector found no speech at all.
//! 5. **Trim**, only when the recorder's own voice detector didn't run
//!    (it already keeps 450 ms either side of speech): the raw audio is
//!    scored and 450 ms kept before and after the speech.
//!
//! Why 8 dB: a live run through the real /dictate Whisper (scripts/
//! noise_eval.py: speech mixed with noise, then RNNoise) measured word
//! error rate raw → denoised as: quiet 0 → 0; traffic at 0/5/10/20 dB
//! 0 → 0; café babble at 0 dB 67% → 52% and at 5 dB 5% → 2%; pink noise
//! at 0 dB 11% → 26% (worse); anything at 10 dB or more unchanged. So
//! filtering helps with background voices, can hurt with steady hiss, and
//! does nothing from about 8 dB up: below 8 dB both go to the server and it
//! keeps the better transcript.
//!
//! Cost: about 9 ms of CPU per second of audio in a release build (both
//! resamples included), and about 330 KB of binary (RNNoise's weights and
//! code).

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;

/// Auto treats a recording measured below this SNR (see the module docs).
pub const AUTO_THRESHOLD_DB: f32 = 8.0;
/// RNNoise's rate and frame.
const DENOISE_RATE: usize = 48_000;
const DENOISE_FRAME: usize = nnnoiseless::DenoiseState::FRAME_SIZE;
/// RNNoise works on 16-bit sample values.
const I16_SCALE: f32 = 32_768.0;
/// Energy frames for the SNR estimate: 20 ms.
const SNR_FRAME: usize = 320;
/// Too little audio to say anything about its noise.
const MIN_SNR_FRAMES: usize = 10;
/// Speech level target and limits for the gentle level step.
const TARGET_RMS_DBFS: f32 = -20.0;
const MAX_GAIN_DB: f32 = 18.0;
const PEAK_LIMIT: f32 = 0.891; // -1 dBFS
/// Speech probability that counts as speech when trimming: the recorder's
/// own Silero threshold.
const TRIM_SPEECH_PROB: f32 = 0.3;
/// Kept around the speech when trimming: the recorder's own pre-roll and
/// hangover (`VAD_PREFILL_MS`, `VAD_OFFLINE_HANGOVER_MS`), so soft starts
/// and a trailing "thanks" stay.
const TRIM_PAD_BEFORE_MS: usize = crate::audio_toolkit::vad::VAD_PREFILL_MS as usize;
const TRIM_PAD_AFTER_MS: usize = crate::audio_toolkit::vad::VAD_OFFLINE_HANGOVER_MS as usize;
/// The loudest frames are speech peaks, louder than speech on average by
/// about this much (measured on the synthetic speech in the tests).
const PEAK_TO_MEAN_DB: f32 = 3.0;

/// Settings → Sound → Noise filter.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default, Type)]
#[serde(rename_all = "snake_case")]
pub enum NoiseFilter {
    /// Only when the recording is very noisy.
    #[default]
    Auto,
    Always,
    Off,
}

/// What goes to the transcriber.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Plan {
    /// The recording as it is.
    #[default]
    Raw,
    /// The recording as it is, and the filtered one beside it (the cloud
    /// keeps whichever transcript is surer).
    Both,
    /// Only the filtered recording.
    Clean,
}

/// What was done to one recording.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct CleanReport {
    /// The estimated speech-to-noise ratio, when there was enough audio.
    pub snr_db: Option<f32>,
    pub plan: Plan,
    /// The level step's gain (0 when it was skipped).
    pub gain_db: f32,
    /// Samples trimmed from the start and the end of the filtered audio.
    pub trimmed: (usize, usize),
}

impl CleanReport {
    /// A filtered recording was made.
    pub fn filtered(&self) -> bool {
        self.plan != Plan::Raw
    }
}

/// A recording ready to send: `audio` (the `audio` field, or what the local
/// model decodes) and, for [`Plan::Both`], the filtered one (`audio_clean`).
#[derive(Debug, Clone, Default)]
pub struct Prepared {
    pub audio: Vec<f32>,
    pub clean: Option<Vec<f32>>,
    pub report: CleanReport,
}

/// What to send for a recording with this estimate. `on_device`: the local
/// model, which can't compare two decodes, so Auto leaves it alone.
pub fn plan(mode: NoiseFilter, snr_db: Option<f32>, on_device: bool) -> Plan {
    match mode {
        NoiseFilter::Off => Plan::Raw,
        NoiseFilter::Always => Plan::Clean,
        NoiseFilter::Auto if on_device => Plan::Raw,
        // Unknown (a very short clip): leave it alone.
        NoiseFilter::Auto => match snr_db {
            Some(snr) if snr < AUTO_THRESHOLD_DB => Plan::Both,
            _ => Plan::Raw,
        },
    }
}

fn frame_energies(samples: &[f32]) -> Vec<f32> {
    samples
        .chunks_exact(SNR_FRAME)
        .map(|f| f.iter().map(|s| s * s).sum::<f32>() / SNR_FRAME as f32)
        .collect()
}

fn mean(values: &[f32]) -> f32 {
    if values.is_empty() {
        0.0
    } else {
        values.iter().sum::<f32>() / values.len() as f32
    }
}

/// The speech-to-noise ratio in dB: the loudest fifth of 20 ms frames
/// (speech, plus the noise under it) against the quiet ones between the
/// 10th and 30th percentile (noise alone: pre-roll and gaps between words;
/// the very quietest are skipped, as noise dips below its average there).
/// `None` for too little audio or digital silence.
pub fn estimate_snr(samples: &[f32]) -> Option<f32> {
    let mut energies = frame_energies(samples);
    if energies.len() < MIN_SNR_FRAMES {
        return None;
    }
    energies.sort_by(|a, b| a.total_cmp(b));
    let n = energies.len();
    let noise = mean(&energies[n / 10..(3 * n / 10).max(n / 10 + 1)]);
    let loud = mean(&energies[n - (n / 5).max(1)..]);
    if loud <= 1e-10 {
        return None;
    }
    // Floor the noise at about a 16-bit quantisation step, so the silence
    // between words in a dead-quiet room reads as very clean.
    let noise = noise.max(1e-9);
    let speech = (loud - noise).max(1e-12);
    Some((10.0 * (speech / noise).log10() - PEAK_TO_MEAN_DB).clamp(-20.0, 80.0))
}

/// Resamples a whole clip, `from` → `to` Hz. The resampler's startup delay
/// is dropped by hand (rubato 5.0's `process_all` splices it wrongly, and
/// the recorder pins 5.0), and the result is exactly `ceil(len * to /
/// from)` long.
pub fn resample(samples: &[f32], from: usize, to: usize) -> Vec<f32> {
    if samples.is_empty() || from == to {
        return samples.to_vec();
    }
    let run = || -> Option<Vec<f32>> {
        let mut resampler = Fft::<f32>::new(from, to, 1024, 1, FixedSync::Input).ok()?;
        let len = samples.len();
        let expected = (resampler.resample_ratio() * len as f64).ceil() as usize;
        let mut delay = resampler.output_delay();
        let input = InterleavedSlice::new(samples, 1, len).ok()?;
        let mut scratch = vec![0.0f32; resampler.output_frames_max()];
        let mut out = Vec::with_capacity(expected + scratch.len());
        let mut offset = 0;
        // Past the end, silence pushes the held-back delay out.
        let mut rounds_left = expected / resampler.output_frames_max().max(1) + len + 16;
        while out.len() < expected {
            rounds_left = rounds_left.checked_sub(1)?;
            let next = resampler.input_frames_next();
            let mut indexing = Indexing::new().input_offset(offset.min(len));
            if len - offset.min(len) < next {
                indexing.partial_len = Some(len - offset.min(len));
            }
            let scratch_len = scratch.len();
            let mut buffer = InterleavedSlice::new_mut(&mut scratch[..], 1, scratch_len).ok()?;
            let (taken, produced) = resampler
                .process_into_buffer(&input, &mut buffer, Some(&indexing))
                .ok()?;
            offset += taken;
            let dropped = delay.min(produced);
            delay -= dropped;
            out.extend_from_slice(&scratch[dropped..produced]);
        }
        out.truncate(expected);
        Some(out)
    };
    run().unwrap_or_else(|| {
        log::warn!("Resampling {from} → {to} Hz failed; leaving the audio as it was");
        samples.to_vec()
    })
}

/// RNNoise over a 16 kHz recording; the result has the same length.
pub fn denoise(samples: &[f32]) -> Vec<f32> {
    let rate = WHISPER_SAMPLE_RATE as usize;
    let up = resample(samples, rate, DENOISE_RATE);
    if up.len() == samples.len() {
        // Resampling failed: no denoise rather than a wrong length.
        return samples.to_vec();
    }
    let mut state = nnnoiseless::DenoiseState::new();
    // RNNoise's output lags its input by one frame: feed one more and drop
    // the first, which also discards its fade-in.
    let frames = up.len().div_ceil(DENOISE_FRAME) + 1;
    let mut input = vec![0.0f32; DENOISE_FRAME];
    let mut output = vec![0.0f32; DENOISE_FRAME];
    let mut clean = Vec::with_capacity(frames * DENOISE_FRAME);
    for i in 0..frames {
        let start = i * DENOISE_FRAME;
        for (j, slot) in input.iter_mut().enumerate() {
            *slot = up.get(start + j).copied().unwrap_or(0.0) * I16_SCALE;
        }
        state.process_frame(&mut output, &input);
        if i > 0 {
            clean.extend(output.iter().map(|s| s / I16_SCALE));
        }
    }
    clean.truncate(up.len());
    let mut down = resample(&clean, DENOISE_RATE, rate);
    down.resize(samples.len(), 0.0);
    down
}

/// Brings speech gently toward -20 dBFS RMS without clipping. Returns the
/// gain applied, in dB.
pub fn level(samples: &mut [f32]) -> f32 {
    let mut energies = frame_energies(samples);
    if energies.is_empty() {
        return 0.0;
    }
    energies.sort_by(|a, b| a.total_cmp(b));
    // The speech level: the loudest third of frames.
    let n = energies.len();
    let speech_rms = mean(&energies[n - (n / 3).max(1)..]).sqrt();
    let peak = samples.iter().fold(0.0f32, |m, s| m.max(s.abs()));
    if speech_rms <= 1e-6 || peak <= 1e-6 {
        return 0.0;
    }
    let target = 10f32.powf(TARGET_RMS_DBFS / 20.0);
    let wanted = (target / speech_rms).min(10f32.powf(MAX_GAIN_DB / 20.0));
    let gain = wanted.min(PEAK_LIMIT / peak);
    for s in samples.iter_mut() {
        *s *= gain;
    }
    20.0 * gain.log10()
}

/// What a voice detector made of a recording.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Speech {
    /// Speech in this range (with the margins kept).
    In(std::ops::Range<usize>),
    /// No frame sounded like speech.
    None,
}

/// From a little before the first frame that sounds like speech to a little
/// after the last one.
pub fn speech_bounds(scores: &[f32], frame_samples: usize, len: usize) -> Speech {
    let (Some(first), Some(last)) = (
        scores.iter().position(|p| *p >= TRIM_SPEECH_PROB),
        scores.iter().rposition(|p| *p >= TRIM_SPEECH_PROB),
    ) else {
        return Speech::None;
    };
    let per_ms = WHISPER_SAMPLE_RATE as usize / 1000;
    let start = (first * frame_samples).saturating_sub(TRIM_PAD_BEFORE_MS * per_ms);
    let end = ((last + 1) * frame_samples + TRIM_PAD_AFTER_MS * per_ms).min(len);
    if start < end {
        Speech::In(start..end)
    } else {
        Speech::None
    }
}

/// Speech probabilities for whole frames of `samples` (the last one padded
/// with silence), from a voice detector, and the frame size.
pub type Scorer<'a> = &'a mut dyn FnMut(&[f32]) -> Option<(Vec<f32>, usize)>;

/// Gets a recording ready for the transcriber (see the module docs).
/// `score` is given only when the recorder's own voice detector didn't run:
/// it trims the filtered audio, and says when there's no speech at all.
pub fn prepare(
    samples: Vec<f32>,
    mode: NoiseFilter,
    on_device: bool,
    score: Option<Scorer<'_>>,
) -> Prepared {
    let snr_db = estimate_snr(&samples);
    let mut report = CleanReport {
        snr_db,
        plan: plan(mode, snr_db, on_device),
        ..Default::default()
    };
    if report.plan == Plan::Raw {
        return Prepared {
            audio: samples,
            clean: None,
            report,
        };
    }
    // Scored on the recording as it is: denoising can make speech sound
    // less like speech to a detector.
    let speech = score
        .and_then(|score| score(&samples))
        .map(|(scores, frame)| speech_bounds(&scores, frame, samples.len()));
    let mut clean = denoise(&samples);
    // Nothing but noise: don't turn it up for Whisper to imagine words in.
    if speech != Some(Speech::None) {
        report.gain_db = level(&mut clean);
    }
    if let Some(Speech::In(range)) = speech {
        report.trimmed = (range.start, clean.len() - range.end);
        clean = clean[range].to_vec();
    }
    match report.plan {
        Plan::Both => Prepared {
            audio: samples,
            clean: Some(clean),
            report,
        },
        _ => Prepared {
            audio: clean,
            clean: None,
            report,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    const RATE: usize = 16_000;

    /// A tiny deterministic PRNG, so tests never depend on a crate or seed.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f32 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
        }
    }

    /// Speech-like audio: voiced syllables (a gliding pitch with harmonics
    /// under a syllable envelope), short fricative bursts, and pauses, after
    /// half a second of silence. Generated, so there's no copyrighted audio.
    fn speech(seconds: f32) -> Vec<f32> {
        let n = (seconds * RATE as f32) as usize;
        let mut out = vec![0.0f32; n];
        let mut rng = Lcg(7);
        let mut t = RATE / 2;
        let mut syllable = 0;
        while t < n {
            let len = RATE * (140 + (syllable * 37) % 160) / 1000;
            let f0 = 110.0 + 70.0 * ((syllable as f32) * 0.7).sin().abs();
            for i in 0..len.min(n - t) {
                let x = i as f32 / len as f32;
                let env = (std::f32::consts::PI * x).sin().powf(0.6);
                let f = f0 * (1.0 + 0.15 * x);
                let phase = 2.0 * std::f32::consts::PI * f * (t + i) as f32 / RATE as f32;
                let mut v = 0.0;
                for h in 1..=12 {
                    v += (phase * h as f32).sin() / h as f32;
                }
                out[t + i] = 0.12 * env * v;
            }
            t += len;
            if syllable % 3 == 2 && t < n {
                // A fricative ("s", "f").
                let len = RATE * 70 / 1000;
                for i in 0..len.min(n - t) {
                    out[t + i] = 0.04 * rng.next();
                }
                t += len;
            }
            // A pause between syllables; longer between words.
            t += RATE * if syllable % 4 == 3 { 220 } else { 60 } / 1000;
            syllable += 1;
        }
        out
    }

    /// Pink noise (Paul Kellet's filter).
    fn pink(n: usize, seed: u64) -> Vec<f32> {
        let mut rng = Lcg(seed);
        let (mut b0, mut b1, mut b2) = (0.0f32, 0.0f32, 0.0f32);
        (0..n)
            .map(|_| {
                let w = rng.next();
                b0 = 0.99765 * b0 + w * 0.0990460;
                b1 = 0.96300 * b1 + w * 0.2965164;
                b2 = 0.57000 * b2 + w * 1.0526913;
                b0 + b1 + b2 + w * 0.1848
            })
            .collect()
    }

    /// Traffic: a low rumble (brown noise) swelling as cars pass, plus a
    /// little broadband hiss.
    fn traffic(n: usize, seed: u64) -> Vec<f32> {
        let mut rng = Lcg(seed);
        let mut brown = 0.0f32;
        (0..n)
            .map(|i| {
                brown = (brown + 0.02 * rng.next()) * 0.995;
                let swell = 0.6 + 0.4 * (i as f32 / RATE as f32 * 0.7).sin().abs();
                swell * brown * 4.0 + 0.05 * rng.next()
            })
            .collect()
    }

    fn power(x: &[f32]) -> f32 {
        x.iter().map(|s| s * s).sum::<f32>() / x.len() as f32
    }

    /// Speech power over the samples that carry speech.
    fn speech_power(x: &[f32]) -> f32 {
        let active: Vec<f32> = x.iter().copied().filter(|s| s.abs() > 1e-6).collect();
        power(&active)
    }

    /// `speech` with `noise` scaled to `snr_db` below it.
    fn mix(speech: &[f32], noise: &[f32], snr_db: f32) -> Vec<f32> {
        let scale = (speech_power(speech) / power(noise) / 10f32.powf(snr_db / 10.0)).sqrt();
        speech
            .iter()
            .zip(noise)
            .map(|(s, n)| s + n * scale)
            .collect()
    }

    #[test]
    fn snr_estimates_track_the_mix() {
        let clean = speech(4.0);
        for (name, noise) in [
            ("pink", pink(clean.len(), 3)),
            ("traffic", traffic(clean.len(), 5)),
        ] {
            for snr in [0.0f32, 5.0, 10.0, 20.0] {
                let est = estimate_snr(&mix(&clean, &noise, snr)).unwrap();
                assert!(
                    (est - snr).abs() <= 4.0,
                    "{name} at {snr} dB was estimated at {est:.1} dB"
                );
            }
        }
        // A quiet room: far above the line.
        assert!(estimate_snr(&clean).unwrap() > 40.0);
        // Too short, or digital silence: unknown.
        assert_eq!(estimate_snr(&clean[..RATE / 10]), None);
        assert_eq!(estimate_snr(&vec![0.0; RATE]), None);
    }

    #[test]
    fn auto_sends_both_only_below_eight_db() {
        assert_eq!(AUTO_THRESHOLD_DB, 8.0);
        let clean = speech(4.0);
        for (name, noise) in [
            ("pink", pink(clean.len(), 11)),
            ("traffic", traffic(clean.len(), 5)),
        ] {
            for (snr, expect) in [(0.0, Plan::Both), (20.0, Plan::Raw)] {
                let p = prepare(mix(&clean, &noise, snr), NoiseFilter::Auto, false, None);
                assert_eq!(p.report.plan, expect, "{name} at {snr} dB");
            }
        }
        assert_eq!(plan(NoiseFilter::Auto, Some(7.9), false), Plan::Both);
        assert_eq!(plan(NoiseFilter::Auto, Some(8.0), false), Plan::Raw);
        assert_eq!(plan(NoiseFilter::Auto, Some(12.0), false), Plan::Raw);
        assert_eq!(plan(NoiseFilter::Auto, None, false), Plan::Raw);
        assert_eq!(plan(NoiseFilter::Always, Some(40.0), false), Plan::Clean);
        assert_eq!(plan(NoiseFilter::Off, Some(-5.0), false), Plan::Raw);

        // Both: the raw recording goes exactly as recorded, the filtered one beside it.
        let noisy = mix(&clean, &pink(clean.len(), 11), 0.0);
        let p = prepare(noisy.clone(), NoiseFilter::Auto, false, None);
        assert_eq!(p.audio, noisy);
        assert_eq!(p.clean.as_ref().map(Vec::len), Some(noisy.len()));
        // Always: only the filtered one.
        let p = prepare(noisy.clone(), NoiseFilter::Always, false, None);
        assert!(p.clean.is_none());
        assert_ne!(p.audio, noisy);
        // Off, and quiet rooms: untouched.
        let p = prepare(noisy.clone(), NoiseFilter::Off, false, None);
        assert_eq!((p.audio, p.clean.is_none()), (noisy, true));
        let p = prepare(clean.clone(), NoiseFilter::Auto, false, None);
        assert_eq!(p.audio, clean);
    }

    #[test]
    fn on_this_mac_auto_never_filters() {
        let clean = speech(4.0);
        let noisy = mix(&clean, &pink(clean.len(), 3), 0.0);
        let p = prepare(noisy.clone(), NoiseFilter::Auto, true, None);
        assert_eq!(p.report.plan, Plan::Raw);
        assert_eq!(p.audio, noisy);
        assert!(p.clean.is_none());
        let p = prepare(noisy, NoiseFilter::Always, true, None);
        assert_eq!(p.report.plan, Plan::Clean);
    }

    #[test]
    fn denoising_keeps_length_lowers_noise_and_never_clips() {
        let clean = speech(3.0);
        let noise = traffic(clean.len(), 9);
        let noisy = mix(&clean, &noise, 5.0);
        let out = denoise(&noisy);
        assert_eq!(out.len(), noisy.len(), "same length at the same rate");
        // The first half second is noise alone: much quieter after.
        let head = RATE / 2;
        let before = 10.0 * power(&noisy[..head]).log10();
        let after = 10.0 * power(&out[RATE / 10..head]).max(1e-12).log10();
        assert!(after < before - 6.0, "noise {before:.1} dB → {after:.1} dB");
        let p = prepare(noisy, NoiseFilter::Always, false, None);
        assert_eq!(p.audio.len(), clean.len());
        assert!(p.audio.iter().all(|s| s.abs() <= PEAK_LIMIT + 1e-4));
        assert!(p.report.gain_db <= MAX_GAIN_DB + 1e-3);
    }

    #[test]
    fn the_resampler_round_trips() {
        // 16k → 48k → 16k is near-identity away from the filter's edges.
        let x: Vec<f32> = (0..RATE * 2)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                0.3 * (2.0 * std::f32::consts::PI * 220.0 * t).sin()
                    + 0.2 * (2.0 * std::f32::consts::PI * 1_700.0 * t).sin()
                    + 0.1 * (2.0 * std::f32::consts::PI * 5_100.0 * t).sin()
            })
            .collect();
        let up = resample(&x, RATE, DENOISE_RATE);
        assert_eq!(up.len(), x.len() * 3);
        let back = resample(&up, DENOISE_RATE, RATE);
        assert_eq!(back.len(), x.len());
        let edge = 256;
        let err = x[edge..x.len() - edge]
            .iter()
            .zip(&back[edge..x.len() - edge])
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(err < 0.01, "round trip is off by up to {err}");
        // Including the first 56 ms rubato 5.0's process_all gets wrong.
        let start_err = x[edge..1_000]
            .iter()
            .zip(&back[edge..1_000])
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(start_err < 0.01, "the start is off by up to {start_err}");
    }

    #[test]
    fn quiet_speech_is_brought_up_but_never_clipped() {
        let mut quiet: Vec<f32> = speech(2.0).iter().map(|s| s * 0.02).collect();
        let gain = level(&mut quiet);
        assert!(gain > 6.0 && gain <= MAX_GAIN_DB + 1e-3, "gain {gain}");
        let mut loud: Vec<f32> = speech(2.0).iter().map(|s| s * 5.0).collect();
        level(&mut loud);
        assert!(loud.iter().all(|s| s.abs() <= PEAK_LIMIT + 1e-4));
        let mut silent = vec![0.0f32; RATE];
        assert_eq!(level(&mut silent), 0.0);
    }

    #[test]
    fn trimming_keeps_the_recorders_own_margins() {
        // 32 ms frames: noise, speech in frames 30..50, noise.
        let frame = 512;
        let mut scores = vec![0.05f32; 90];
        for s in &mut scores[30..50] {
            *s = 0.9;
        }
        let len = 90 * frame;
        let Speech::In(r) = speech_bounds(&scores, frame, len) else {
            panic!("speech expected");
        };
        assert_eq!(r.start, 30 * frame - 450 * 16);
        assert_eq!(r.end, 50 * frame + 450 * 16);
        // Speech to the very end: nothing past it to cut.
        for s in &mut scores[80..] {
            *s = 0.9;
        }
        assert!(matches!(speech_bounds(&scores, frame, len), Speech::In(r) if r.end == len));
        assert_eq!(speech_bounds(&[0.1; 10], frame, 10 * frame), Speech::None);
    }

    #[test]
    fn no_trimming_without_a_scorer_and_no_gain_on_noise_alone() {
        // The recorder's VAD ran: no scorer is given, nothing is trimmed.
        let noisy = mix(&speech(3.0), &pink(48_000, 2), 0.0);
        let p = prepare(noisy.clone(), NoiseFilter::Always, false, None);
        assert_eq!(p.report.trimmed, (0, 0));
        assert_eq!(p.audio.len(), noisy.len());

        // It didn't: the raw audio is scored, and the filtered audio is cut
        // to the speech with 450 ms either side.
        let frame = 512;
        let mut scored_len = 0;
        let mut detector = |x: &[f32]| -> Option<(Vec<f32>, usize)> {
            scored_len = x.len();
            let frames = x.len().div_ceil(frame);
            Some((
                (0..frames)
                    .map(|i| if (40..60).contains(&i) { 0.9 } else { 0.0 })
                    .collect(),
                frame,
            ))
        };
        let p = prepare(
            noisy.clone(),
            NoiseFilter::Always,
            false,
            Some(&mut detector),
        );
        assert_eq!(scored_len, noisy.len());
        assert_eq!(p.report.trimmed.0, 40 * frame - 450 * 16);
        assert_eq!(
            p.audio.len() + p.report.trimmed.0 + p.report.trimmed.1,
            noisy.len()
        );

        // Noise and nothing else: filtered, but never turned up.
        let noise_only = pink(48_000, 8).iter().map(|s| s * 0.01).collect::<Vec<_>>();
        let mut deaf = |x: &[f32]| -> Option<(Vec<f32>, usize)> {
            Some((vec![0.0; x.len().div_ceil(frame)], frame))
        };
        let p = prepare(noise_only, NoiseFilter::Always, false, Some(&mut deaf));
        assert_eq!(p.report.gain_db, 0.0);
        assert_eq!(p.report.trimmed, (0, 0));
    }

    #[test]
    fn filtering_is_fast_enough() {
        // Well under real time even in a debug build (the noise crates are
        // optimised in dev builds too; see Cargo.toml).
        let clean = speech(10.0);
        let noisy = mix(&clean, &pink(clean.len(), 4), 0.0);
        let started = Instant::now();
        let p = prepare(noisy, NoiseFilter::Auto, false, None);
        let took = started.elapsed().as_secs_f32();
        assert_eq!(p.report.plan, Plan::Both);
        eprintln!("noise filter: {:.1} ms per second of audio", took * 100.0);
        assert!(took < 10.0 * 0.15, "took {took:.2}s for 10 s of audio");
    }
}
