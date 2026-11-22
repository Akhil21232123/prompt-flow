import SwiftUI
import UIKit

/// The PromptFlow keyboard. It can't record (iOS forbids microphone access in
/// keyboards), so it drives the app's Flow Session and inserts the text the
/// app sends back.
final class KeyboardViewController: UIInputViewController {
    private lazy var model = KeyboardModel(controller: self)
    private var heightConstraint: NSLayoutConstraint?

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: KeyboardView(model: model))
        host.view.backgroundColor = .clear
        host.view.translatesAutoresizingMaskIntoConstraints = false
        addChild(host)
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
        let h = view.heightAnchor.constraint(equalToConstant: 268)
        h.priority = .defaultHigh
        h.isActive = true
        heightConstraint = h
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        model.refresh()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        model.keyboardHidden()
    }

    override func textDidChange(_ textInput: UITextInput?) {
        super.textDidChange(textInput)
        model.refresh()
    }

    // MARK: Called by the model

    var before: String { textDocumentProxy.documentContextBeforeInput ?? "" }
    var selected: String? { textDocumentProxy.selectedText }

    func insert(_ text: String) {
        let piece = (selected?.isEmpty == false) ? text : TextJoin.joinable(before: before, insert: text)
        textDocumentProxy.insertText(piece)
    }

    func type(_ text: String) { textDocumentProxy.insertText(text) }
    func deleteBackward() { textDocumentProxy.deleteBackward() }
    func nextKeyboard() { advanceToNextInputMode() }
    var showsGlobe: Bool { needsInputModeSwitchKey }
    var fullAccess: Bool { hasFullAccess }

    /// Opens the PromptFlow app to start a Flow Session. Keyboards can't call
    /// UIApplication.open directly, so this finds the app object through the
    /// responder chain (allowed by App Review for launching the containing app).
    func openApp(_ url: URL) {
        var responder: UIResponder? = self
        let selector = sel_registerName("openURL:options:completionHandler:")
        while let r = responder {
            if r.responds(to: selector), let app = r as? UIApplication {
                // id self, SEL _cmd, NSURL *url, NSDictionary *options, completion block (nil)
                typealias Open = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
                let imp = app.method(for: selector)
                let open = unsafeBitCast(imp, to: Open.self)
                open(app, selector, url as NSURL, NSDictionary(), nil)
                return
            }
            responder = r.next
        }
    }
}

@MainActor
final class KeyboardModel: ObservableObject {
    @Published var mode: Mode = SharedStore.shared.requestedMode
    @Published var phase: FlowPhase = .off
    @Published var level: Double = 0
    @Published var message: String?
    @Published var fullAccess = true
    @Published var showsGlobe = true

    private weak var controller: KeyboardViewController?
    private let store = SharedStore.shared
    private var poll: Timer?

    init(controller: KeyboardViewController) {
        self.controller = controller
        Bridge.shared.observe(.changed) { [weak self] in
            Task { @MainActor in self?.appChanged() }
        }
    }

    func refresh() {
        guard let c = controller else { return }
        fullAccess = c.fullAccess
        showsGlobe = c.showsGlobe
        phase = store.sessionIsLive ? store.phase : .off
        if phase == .listening { startPolling() }
        deliverPending()
    }

    func keyboardHidden() {
        if phase == .listening { Bridge.shared.post(.cancel) }
        stopPolling()
    }

    func setMode(_ m: Mode) {
        mode = m
        store.requestedMode = m
    }

    func micTapped() {
        guard let c = controller else { return }
        guard c.fullAccess else {
            message = "Turn on Allow Full Access for PromptFlow in Settings → Keyboards."
            return
        }
        message = nil
        switch phase {
        case .listening:
            store.fieldContext = FieldContext(before: String(c.before.suffix(1500)), selection: c.selected)
            Bridge.shared.post(.stop)
            phase = .working
            stopPolling()
        case .working:
            return
        default:
            store.requestedMode = mode
            store.fieldContext = FieldContext(before: String(c.before.suffix(1500)), selection: c.selected)
            if store.sessionIsLive {
                Bridge.shared.post(.start)
                phase = .listening
                startPolling()
            } else if let url = URL(string: "promptflow://session?mode=\(mode.rawValue)&autostart=1") {
                c.openApp(url)
                message = "Starting PromptFlow… swipe back here to keep talking."
            }
        }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    private func appChanged() {
        phase = store.sessionIsLive || store.phase == .done ? store.phase : .off
        if phase == .failed { message = store.lastError }
        if phase == .listening { startPolling() } else { stopPolling() }
        deliverPending()
    }

    private func deliverPending() {
        guard let pending = store.pendingResult, pending.id != store.lastInsertedId else { return }
        store.lastInsertedId = pending.id
        controller?.insert(pending.text)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    private func startPolling() {
        guard poll == nil else { return }
        poll = Timer.scheduledTimer(withTimeInterval: 1 / 15, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.level = self.store.level
                if !self.store.sessionIsLive, self.phase == .listening {
                    self.phase = .off
                    self.stopPolling()
                }
            }
        }
    }

    private func stopPolling() {
        poll?.invalidate()
        poll = nil
        level = 0
    }

    // Keys
    func space() { controller?.type(" ") }
    func newline() { controller?.type("\n") }
    func delete() { controller?.deleteBackward() }
    func globe() { controller?.nextKeyboard() }
}
