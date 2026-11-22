import Foundation

/// Cross-process signals between the keyboard and the app. Darwin
/// notifications carry no payload; the data travels in `SharedStore`.
enum Signal: String, CaseIterable {
    case start = "com.akhil.promptflow.start"     // keyboard → app: begin capturing
    case stop = "com.akhil.promptflow.stop"       // keyboard → app: stop and process
    case cancel = "com.akhil.promptflow.cancel"   // keyboard → app: discard
    case changed = "com.akhil.promptflow.changed" // app → keyboard: phase/result changed
}

final class Bridge {
    static let shared = Bridge()

    private var handlers: [Signal: () -> Void] = [:]

    func post(_ signal: Signal) {
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterPostNotification(center, CFNotificationName(signal.rawValue as CFString), nil, nil, true)
    }

    /// Calls `handler` on the main queue whenever `signal` is posted by
    /// either process.
    func observe(_ signal: Signal, _ handler: @escaping () -> Void) {
        let first = handlers[signal] == nil
        handlers[signal] = handler
        guard first else { return }
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(center, observer, { _, observer, name, _, _ in
            guard let observer, let raw = name?.rawValue as String?, let signal = Signal(rawValue: raw) else { return }
            let bridge = Unmanaged<Bridge>.fromOpaque(observer).takeUnretainedValue()
            DispatchQueue.main.async { bridge.handlers[signal]?() }
        }, signal.rawValue as CFString, nil, .deliverImmediately)
    }
}
