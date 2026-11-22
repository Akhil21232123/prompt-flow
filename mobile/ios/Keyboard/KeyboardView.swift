import SwiftUI

struct KeyboardView: View {
    @ObservedObject var model: KeyboardModel

    var body: some View {
        VStack(spacing: 10) {
            StylePicker(selection: $model.style, compact: true)
            mic
            Text(statusText)
                .font(.footnote)
                .foregroundStyle(Brand.muted)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(height: 32)
                .contentTransition(.opacity)
                .animation(.easeInOut(duration: 0.2), value: statusText)
            keys
        }
        .padding(.horizontal, 10)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Brand.ink.opacity(0.94))
    }

    private var mic: some View {
        let listening = model.phase == .listening
        return ZStack {
            Capsule()
                .fill(Brand.gradient(model.mode))
                .shadow(color: Brand.violet.opacity(listening ? 0.6 : 0.3), radius: listening ? 18 : 8)
            Group {
                switch model.phase {
                case .working:
                    HStack(spacing: 10) {
                        ProgressView().tint(.white)
                        Text(workingLabel).font(.subheadline.weight(.semibold))
                    }
                case .done:
                    Image(systemName: "checkmark").font(.title2.bold())
                case .listening:
                    HStack(spacing: 12) {
                        WaveBars(level: model.level, active: true)
                        Text(modeLabel).font(.subheadline.weight(.semibold))
                    }
                default:
                    VStack(spacing: 3) {
                        HStack(spacing: 8) {
                            Image(systemName: "mic.fill").font(.title3)
                            Text(model.phase == .off ? "Tap to start PromptFlow" : "Tap: Prompt").font(.headline)
                        }
                        if model.phase != .off {
                            Text("Double-tap: \(model.style.label) · Hold: Edit")
                                .font(.caption.weight(.medium))
                                .opacity(0.85)
                        }
                    }
                }
            }
            .foregroundStyle(.white)
        }
        .frame(height: 76)
        .scaleEffect(listening ? 1 + model.level * 0.05 : 1)
        .animation(.spring(response: 0.3, dampingFraction: 0.6), value: model.level)
        .animation(.easeInOut(duration: 0.2), value: model.mode)
        .contentShape(Capsule())
        .tapHold(onTap: { model.micTapped() }, onHoldStart: { model.holdStarted() }, onHoldEnd: { model.holdEnded() })
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(listening ? "Stop dictating" : "Dictate. Tap for a prompt, double-tap for \(model.style.label), hold to edit")
        .accessibilityAddTraits(.isButton)
    }

    private var modeLabel: String {
        switch model.mode {
        case .engineer: return "Prompt · double-tap for \(model.style.label)"
        case .dictate: return model.style.label
        case .command: return "Edit · release when done"
        }
    }

    private var workingLabel: String {
        switch model.mode {
        case .engineer: return "Engineering your prompt…"
        case .dictate: return "Writing it \(model.style.label.lowercased())…"
        case .command: return "Editing…"
        }
    }

    private var keys: some View {
        HStack(spacing: 6) {
            if model.showsGlobe {
                KeyButton(systemImage: "globe", width: 46) { model.globe() }
            }
            KeyButton(title: "space") { model.space() }
            RepeatKey(systemImage: "delete.left", width: 54) { model.delete() }
            KeyButton(systemImage: "return", width: 54) { model.newline() }
        }
        .frame(height: 46)
    }

    private var statusText: String {
        if let m = model.message { return m }
        switch model.phase {
        case .off: return "Starts a Flow Session in the PromptFlow app, then you come back here."
        case .ready: return "Tap and talk: you get a prompt built for the best answer."
        case .listening: return model.mode == .command ? "Say what to change, then let go." : "Listening… tap when you're done."
        case .working: return workingLabel
        case .done: return "Inserted."
        case .failed: return "Something went wrong. Open PromptFlow for details."
        }
    }
}

private struct PressScale: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.spring(response: 0.2, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

private struct KeyButton: View {
    var title: String?
    var systemImage: String?
    var width: CGFloat?
    var action: () -> Void

    init(title: String? = nil, systemImage: String? = nil, width: CGFloat? = nil, action: @escaping () -> Void) {
        self.title = title
        self.systemImage = systemImage
        self.width = width
        self.action = action
    }

    var body: some View {
        Button {
            UIDevice.current.playInputClick()
            action()
        } label: {
            Group {
                if let systemImage { Image(systemName: systemImage) } else { Text(title ?? "") }
            }
            .font(.system(size: 17, weight: .medium))
            .foregroundStyle(.white)
            .frame(maxWidth: width == nil ? .infinity : width, maxHeight: .infinity)
            .frame(width: width)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Brand.surfaceHigh))
        }
        .buttonStyle(PressScale())
    }
}

/// Delete key that repeats while held.
private struct RepeatKey: View {
    var systemImage: String
    var width: CGFloat
    var action: () -> Void
    @State private var timer: Timer?

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 17, weight: .medium))
            .foregroundStyle(.white)
            .frame(width: width)
            .frame(maxHeight: .infinity)
            .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Brand.surfaceHigh))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard timer == nil else { return }
                        action()
                        let t = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { _ in
                            timer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { _ in action() }
                        }
                        timer = t
                    }
                    .onEnded { _ in
                        timer?.invalidate()
                        timer = nil
                    }
            )
            .accessibilityLabel("Delete")
            .accessibilityAddTraits(.isButton)
    }
}
