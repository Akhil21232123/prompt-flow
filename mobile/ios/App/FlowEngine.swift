import AVFoundation
import Foundation
import UIKit

/// Records during a Flow Session and turns speech into text.
///
/// iOS keyboards can't use the microphone, so the app keeps an audio engine
/// running (background audio) while a session is on. The keyboard says
/// "start"/"stop" over `Bridge`; the app captures, sends the audio to the
/// backend, and hands the text back through `SharedStore`.
@MainActor
final class FlowEngine: ObservableObject {
    static let shared = FlowEngine()

    @Published private(set) var sessionOn = false
    @Published private(set) var phase: FlowPhase = .off
    @Published private(set) var level: Double = 0
    @Published private(set) var lastResult: DictationResult?
    @Published private(set) var lastError: String?
    /// The keyboard opened the app to start a session: show "swipe back".
    @Published var showReturnHint = false

    private let store = SharedStore.shared
    private let engine = AVAudioEngine()
    nonisolated(unsafe) private var converter: AVAudioConverter?
    nonisolated(unsafe) private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(Wav.sampleRate), channels: 1, interleaved: false)!
    private let lock = NSLock()
    nonisolated(unsafe) private var samples: [Float] = []
    nonisolated(unsafe) private var capturing = false
    nonisolated(unsafe) private var latestLevel: Double = 0
    private var mode: Mode = .dictate
    private var heartbeatTimer: Timer?
    private var lastActivity = Date()
    /// Set when dictating inside the app itself rather than for the keyboard.
    private var inAppDelivery: ((DictationResult) -> Void)?
    private var inAppField: FieldContext?

    private init() {
        Bridge.shared.observe(.start) { [weak self] in
            Task { @MainActor in self?.beginCapture(mode: SharedStore.shared.requestedMode) }
        }
        Bridge.shared.observe(.stop) { [weak self] in
            Task { @MainActor in self?.finishCapture() }
        }
        Bridge.shared.observe(.cancel) { [weak self] in
            Task { @MainActor in self?.cancelCapture() }
        }
    }

    // MARK: Session

    func requestMicrophone() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    var micAllowed: Bool { AVAudioApplication.shared.recordPermission == .granted }

    func startSession() {
        guard !sessionOn else { return }
        do {
            let audio = AVAudioSession.sharedInstance()
            try audio.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .allowBluetooth, .defaultToSpeaker])
            try audio.setActive(true)
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            converter = AVAudioConverter(from: format, to: target)
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
                self?.handle(buffer)
            }
            engine.prepare()
            try engine.start()
        } catch {
            fail("Couldn't start the microphone: \(error.localizedDescription)")
            return
        }
        sessionOn = true
        lastActivity = Date()
        setPhase(.ready)
        heartbeatTimer?.invalidate()
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    func endSession() {
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        capturing = false
        sessionOn = false
        store.heartbeat = nil
        setPhase(.off)
    }

    private var tickCount = 0
    private func tick() {
        tickCount += 1
        level = latestLevel
        if phase == .listening { store.level = latestLevel }
        if tickCount % 10 == 0 { store.heartbeat = Date() }
        let idle = Date().timeIntervalSince(lastActivity)
        if phase == .ready, idle > Double(store.sessionMinutes * 60) { endSession() }
    }

    // MARK: Capture

    nonisolated private func handle(_ buffer: AVAudioPCMBuffer) {
        // Level for the waveform, from the raw input.
        if let ch = buffer.floatChannelData?[0] {
            var sum: Float = 0
            let n = Int(buffer.frameLength)
            for i in 0..<n { sum += ch[i] * ch[i] }
            latestLevel = Double(min(1, sqrt(sum / Float(max(n, 1))) * 6))
        }
        guard capturing else { return }
        let converted = convert(buffer)
        lock.lock()
        samples.append(contentsOf: converted)
        lock.unlock()
    }

    nonisolated private func convert(_ buffer: AVAudioPCMBuffer) -> [Float] {
        guard let converter else { return [] }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return [] }
        var fed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if fed {
                status.pointee = .noDataNow
                return nil
            }
            fed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let ch = out.floatChannelData?[0] else { return [] }
        return Array(UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))
    }

    func beginCapture(mode: Mode) {
        if !sessionOn { startSession() }
        guard sessionOn else { return }
        lock.lock()
        samples.removeAll(keepingCapacity: true)
        lock.unlock()
        self.mode = mode
        capturing = true
        lastActivity = Date()
        lastError = nil
        store.lastError = nil
        setPhase(.listening)
    }

    func cancelCapture() {
        capturing = false
        inAppDelivery = nil
        setPhase(sessionOn ? .ready : .off)
    }

    func finishCapture() {
        guard capturing else { return }
        capturing = false
        lastActivity = Date()
        lock.lock()
        let pcm = samples
        samples.removeAll()
        lock.unlock()
        let seconds = Double(pcm.count) / Double(Wav.sampleRate)
        let delivery = inAppDelivery
        inAppDelivery = nil
        guard seconds >= 0.35 else {
            setPhase(.ready)
            return
        }
        setPhase(.working)
        let wav = Wav.encode(pcm: Wav.pcm16(pcm))
        let field = delivery != nil ? inAppField : store.fieldContext
        let mode = self.mode
        Task {
            do {
                let result = try await API.shared.dictate(wav: wav, mode: mode, field: field, appName: nil, durationSec: seconds)
                lastResult = result
                if !result.text.isEmpty {
                    if let delivery {
                        delivery(result)
                    } else {
                        store.pendingResult = (UUID().uuidString, result.text)
                    }
                    var history = store.history
                    history.insert(HistoryItem(at: Date(), mode: result.mode, raw: result.raw, text: result.text, label: result.label), at: 0)
                    store.history = history
                    store.wordsDictated += result.raw.wordCount
                }
                setPhase(.done)
                try? await Task.sleep(for: .milliseconds(1200))
                if phase == .done { setPhase(sessionOn ? .ready : .off) }
            } catch let e as APIError {
                fail(e.message)
            } catch {
                fail("Couldn't reach PromptFlow. Check your connection.")
            }
        }
    }

    /// Dictation inside the app (the Home orb), delivered to a closure.
    func toggleInApp(mode: Mode, field: FieldContext?, deliver: @escaping (DictationResult) -> Void) {
        if phase == .listening {
            inAppField = field
            finishCapture()
        } else {
            inAppDelivery = deliver
            inAppField = field
            beginCapture(mode: mode)
        }
    }

    // MARK: State

    private func setPhase(_ p: FlowPhase) {
        phase = p
        store.phase = p
        if p != .listening { store.level = 0 }
        Bridge.shared.post(.changed)
    }

    private func fail(_ message: String) {
        lastError = message
        store.lastError = message
        setPhase(.failed)
        Task {
            try? await Task.sleep(for: .seconds(3))
            if phase == .failed { setPhase(sessionOn ? .ready : .off) }
        }
    }

    // MARK: Deep links from the keyboard

    /// promptflow://session?mode=engineer&autostart=1
    func handle(url: URL) {
        guard url.scheme == "promptflow", url.host == "session" else { return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let mode = Mode(rawValue: items.first { $0.name == "mode" }?.value ?? "") ?? .dictate
        startSession()
        if items.contains(where: { $0.name == "autostart" && $0.value == "1" }) {
            store.requestedMode = mode
            beginCapture(mode: mode)
        }
        showReturnHint = true
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }
}
