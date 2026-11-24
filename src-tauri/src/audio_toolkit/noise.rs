//! Cleaning a recording made somewhere noisy (traffic, a street, a café)
//! before it is transcribed, and leaving a clean one exactly as it is.
//!
//! 1. **Measure.** The noise floor is the energy of the quiet 20 ms frames
//!    (the pre-roll before speech and the gaps between words), the speech
//!    level that of the loudest. Their ratio is the SNR.
//! 2. **Decide.** Auto filters only below [`AUTO_THRESHOLD_DB`]. Denoising
//!    clean speech costs Whisper accuracy (RNNoise also softens quiet
//!    consonants and breathy word ends), so a clean recording is never
//!    touched.
//! 3. **Denoise** with RNNoise (`nnnoiseless`, a pure-Rust port, BSD-3) at
//!    48 kHz: 16 kHz → 48 kHz → RNNoise in 480-sample frames → 16 kHz, with
//!    the resampler the recorder already uses (rubato).
//! 4. **Level** speech gently toward -20 dBFS RMS (never more than +18 dB,
//!    never past -1 dBFS peak), so quiet speech over traffic isn't lost.
//! 5. **Trim** what the voice detector hears no speech in at either end, so
//!    Whisper doesn't invent words in a noise tail.
//!
//! Why 15 dB: the synthetic tests below mix speech-like audio with pink
//! noise and traffic rumble at 0, 5, 10 and 20 dB. The estimator reads
//! them as about 2/6/10/20 dB (pink) and 4/6/11/20 dB (traffic), and a
//! quiet room above 40 dB. So a 15 dB line sits midway between the 10 dB
//! mixes (where Whisper starts dropping and inventing words in street
//! noise) and the 20 dB ones (where it is already accurate and denoising
//! could only cost soft consonants), with about 4 dB to spare either way.
//!
//! Cost: about 9 ms of CPU per second of audio in a release build (both
//! resamples included), and about 330 KB of binary (RNNoise's weights and
//! code).

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::audio_toolkit::constants::WHISPER_SAMPLE_RATE;

/// Auto filters a recording measured below this SNR.
pub const AUTO_THRESHOLD_DB: f32 = 15.0;
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
/// own Silero threshold, so trimming never cuts what recording kept as
/// speech.
const TRIM_SPEECH_PROB: f32 = 0.3;
/// Kept around the speech when trimming, so first and last syllables
/// stay whole.
const TRIM_PAD_BEFORE_MS: usize = 200;
const TRIM_PAD_AFTER_MS: usize = 300;

/// Settings → Sound → Noise filter.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default, Type)]
#[serde(rename_all = "snake_case")]
pub enum NoiseFilter {
    /// Only when the recording is noisy.
    #[default]
    Auto,
    Always,
    Off,
}

/// What was done to one recording.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct CleanReport {
    /// The estimated speech-to-noise ratio, when there was enough audio.
    pub snr_db: Option<f32>,
    /// It was denoised (and levelled and trimmed).
    pub filtered: bool,
    /// The level step's gain.
    pub gain_db: f32,
    /// Samples trimmed from the start and the end.
    pub trimmed: (usize, usize),
}

/// Whether to filter a recording with this estimate.
pub fn should_filter(mode: NoiseFilter, snr_db: Option<f32>) -> bool {
    match mode {
        NoiseFilter::Off => false,
        NoiseFilter::Always => true,
        // Unknown (a very short clip): leave it alone.
        NoiseFilter::Auto => snr_db.is_some_and(|snr| snr < AUTO_THRESHOLD_DB),
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

/// The loudest frames are speech peaks, louder than speech on average by
/// about this much (measured on the synthetic speech in the tests).
const PEAK_TO_MEAN_DB: f32 = 3.0;

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

fn resample(samples: &[f32], from: usize, to: usize) -> Vec<f32> {
    if samples.is_empty() || from == to {
        return samples.to_vec();
    }
    let run = || -> Option<Vec<f32>> {
        let mut resampler = Fft::<f32>::new(from, to, 1024, 1, FixedSync::Input).ok()?;
        let input = InterleavedSlice::new(samples, 1, samples.len()).ok()?;
        let out = resampler.process_all(&input, samples.len(), None).ok()?;
        Some(out.take_data())
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

/// The part of a recording to keep: from a little before the first frame
/// that sounds like speech to a little after the last one. `None` when no
/// frame does (keep it all: the server decides what's silence).
pub fn speech_bounds(
    scores: &[f32],
    frame_samples: usize,
    len: usize,
) -> Option<std::ops::Range<usize>> {
    let first = scores.iter().position(|p| *p >= TRIM_SPEECH_PROB)?;
    let last = scores.iter().rposition(|p| *p >= TRIM_SPEECH_PROB)?;
    let per_ms = WHISPER_SAMPLE_RATE as usize / 1000;
    let start = (first * frame_samples).saturating_sub(TRIM_PAD_BEFORE_MS * per_ms);
    let end = ((last + 1) * frame_samples + TRIM_PAD_AFTER_MS * per_ms).min(len);
    (start < end).then_some(start..end)
}

/// Speech probabilities for whole frames of `samples` (the last one padded
/// with silence), from a voice detector.
pub type Scorer<'a> = &'a mut dyn FnMut(&[f32]) -> Option<(Vec<f32>, usize)>;

/// Cleans a 16 kHz recording if `mode` says to (see the module docs).
/// `score` gives speech probabilities for trimming, when a detector is at
/// hand.
pub fn clean(
    samples: Vec<f32>,
    mode: NoiseFilter,
    score: Option<Scorer<'_>>,
) -> (Vec<f32>, CleanReport) {
    let snr_db = estimate_snr(&samples);
    let mut report = CleanReport {
        snr_db,
        ..Default::default()
    };
    if !should_filter(mode, snr_db) {
        return (samples, report);
    }
    let mut out = denoise(&samples);
    report.filtered = true;
    report.gain_db = level(&mut out);
    if let Some(score) = score {
        if let Some((scores, frame)) = score(&out) {
            if let Some(range) = speech_bounds(&scores, frame, out.len()) {
                report.trimmed = (range.start, out.len() - range.end);
                out = out[range].to_vec();
            }
        }
    }
    (out, report)
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
    fn auto_filters_below_the_line_only() {
        let clean = speech(4.0);
        let noise = pink(clean.len(), 11);
        for (snr, expect) in [(0.0, true), (5.0, true), (10.0, true), (20.0, false)] {
            let (_, report) = clean_no_trim(mix(&clean, &noise, snr), NoiseFilter::Auto);
            assert_eq!(report.filtered, expect, "{snr} dB");
        }
        let (out, report) = clean_no_trim(clean.clone(), NoiseFilter::Auto);
        assert!(!report.filtered);
        assert_eq!(out, clean, "clean audio is left exactly as it was");
        let (_, report) = clean_no_trim(clean.clone(), NoiseFilter::Always);
        assert!(report.filtered);
        let noisy = mix(&clean, &noise, 0.0);
        let (out, report) = clean_no_trim(noisy.clone(), NoiseFilter::Off);
        assert!(!report.filtered);
        assert_eq!(out, noisy);
        assert!(should_filter(NoiseFilter::Always, None));
        assert!(!should_filter(NoiseFilter::Auto, None));
    }

    fn clean_no_trim(x: Vec<f32>, mode: NoiseFilter) -> (Vec<f32>, CleanReport) {
        clean(x, mode, None)
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
        let (levelled, report) = clean_no_trim(noisy, NoiseFilter::Always);
        assert_eq!(levelled.len(), clean.len());
        assert!(levelled.iter().all(|s| s.abs() <= PEAK_LIMIT + 1e-4));
        assert!(report.gain_db <= MAX_GAIN_DB + 1e-3);
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
    fn trimming_keeps_the_speech_with_room_around_it() {
        // 32 ms frames: noise, speech in frames 20..40, noise.
        let frame = 512;
        let mut scores = vec![0.05f32; 70];
        for s in &mut scores[20..40] {
            *s = 0.9;
        }
        let len = 70 * frame;
        let r = speech_bounds(&scores, frame, len).unwrap();
        assert_eq!(r.start, 20 * frame - 200 * 16);
        assert_eq!(r.end, 40 * frame + 300 * 16);
        // Speech to the very end: nothing past it to cut.
        for s in &mut scores[60..] {
            *s = 0.9;
        }
        assert_eq!(speech_bounds(&scores, frame, len).unwrap().end, len);
        // No speech at all: keep everything.
        assert_eq!(speech_bounds(&[0.1; 10], frame, 10 * frame), None);

        // Through `clean`, with a detector that hears speech in the middle.
        let noisy = mix(&speech(3.0), &pink(48_000, 2), 0.0);
        let mut detector = |x: &[f32]| -> Option<(Vec<f32>, usize)> {
            let frames = x.len().div_ceil(frame);
            Some((
                (0..frames)
                    .map(|i| if (30..60).contains(&i) { 0.9 } else { 0.0 })
                    .collect(),
                frame,
            ))
        };
        let (out, report) = clean(noisy.clone(), NoiseFilter::Auto, Some(&mut detector));
        assert!(report.filtered);
        assert_eq!(out.len() + report.trimmed.0 + report.trimmed.1, noisy.len());
        assert!(report.trimmed.0 > 0 && report.trimmed.1 > 0);
    }

    #[test]
    fn filtering_is_fast_enough() {
        // Well under real time even in a debug build (the noise crates are
        // optimised in dev builds too; see Cargo.toml).
        let clean = speech(10.0);
        let noisy = mix(&clean, &pink(clean.len(), 4), 5.0);
        let started = Instant::now();
        let (_, report) = clean_no_trim(noisy, NoiseFilter::Auto);
        let took = started.elapsed().as_secs_f32();
        assert!(report.filtered);
        eprintln!("noise filter: {:.1} ms per second of audio", took * 100.0);
        assert!(took < 10.0 * 0.15, "took {took:.2}s for 10 s of audio");
    }
}
