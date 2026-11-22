import SwiftUI

struct HomeView: View {
    @EnvironmentObject var engine: FlowEngine
    @State private var style: StylePreset = SharedStore.shared.stylePreset
    @State private var pad = ""
    @State private var holding = false
    private let store = SharedStore.shared

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                HStack {
                    Text("PromptFlow").font(.title2.bold())
                    Spacer()
                    SessionToggle()
                }
                VStack(spacing: 6) {
                    StylePicker(selection: $style)
                        .onChange(of: style) { _, v in store.stylePreset = v }
                    Text("Double-tap style: \(style.hint)")
                        .font(.footnote)
                        .foregroundStyle(Brand.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Orb(phase: engine.phase, mode: engine.phase == .listening || engine.phase == .working ? engine.currentMode : .engineer, level: engine.level,
                    action: tapped, onHoldStart: holdStarted, onHoldEnd: holdEnded)
                status
                ZStack(alignment: .topLeading) {
                    if pad.isEmpty {
                        Text("Try it here: tap the orb and talk.")
                            .foregroundStyle(Brand.muted)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 20)
                    }
                    TextEditor(text: $pad)
                        .scrollContentBackground(.hidden)
                        .padding(12)
                        .frame(minHeight: 150)
                }
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Brand.surface))
                if !pad.isEmpty {
                    HStack {
                        Button("Copy") { UIPasteboard.general.string = pad }
                        Spacer()
                        Button("Clear") { pad = "" }
                    }
                    .font(.subheadline.weight(.semibold))
                }
                CardBox {
                    HStack {
                        stat("\(store.wordsDictated.formatted())", "words dictated")
                        Spacer()
                        // Typing ~40 wpm vs speaking ~150 wpm.
                        let minutes = Int(Double(store.wordsDictated) / 40 - Double(store.wordsDictated) / 150)
                        stat("\(minutes) min", "saved vs typing")
                    }
                }
                CardBox {
                    Text("Using the keyboard").font(.headline)
                    Text("Switch to PromptFlow with 🌐 in any app.\n• Tap the mic, talk, tap again: you get an engineered prompt.\n• Double-tap: your words in the style you picked (Formal, Short & punchy…).\n• Hold: say how to change the selected text, then let go.")
                        .foregroundStyle(Brand.muted)
                        .font(.subheadline)
                }
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func deliver(_ result: DictationResult) {
        if result.mode == .command {
            pad = result.text
        } else {
            pad = [pad, result.text].filter { !$0.isEmpty }.joined(separator: pad.isEmpty ? "" : " ")
        }
    }

    private func tapped() {
        if engine.phase == .listening {
            if engine.currentMode == .engineer, let t = engine.captureStartedAt,
               Date().timeIntervalSince(t) < Gestures.doubleTapWindow {
                engine.retarget(.dictate)
                UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
                return
            }
            engine.toggleInApp(mode: engine.currentMode, field: FieldContext(before: pad, selection: nil), deliver: deliver)
        } else if engine.phase != .working {
            engine.toggleInApp(mode: .engineer, field: FieldContext(before: pad, selection: nil), deliver: deliver)
        }
    }

    private func holdStarted() {
        guard engine.phase != .listening, engine.phase != .working else { return }
        holding = true
        engine.toggleInApp(mode: .command, field: FieldContext(before: pad, selection: pad.isEmpty ? nil : pad), deliver: deliver)
    }

    private func holdEnded() {
        guard holding else { return }
        holding = false
        if engine.phase == .listening {
            engine.toggleInApp(mode: .command, field: FieldContext(before: pad, selection: pad.isEmpty ? nil : pad), deliver: deliver)
        }
    }

    private var status: some View {
        let text: String = {
            switch engine.phase {
            case .listening: return "Listening…"
            case .working:
                switch engine.currentMode {
                case .engineer: return "Engineering your prompt…"
                case .dictate: return "Writing it \(style.label.lowercased())…"
                case .command: return "Editing…"
                }
            case .listening where engine.currentMode == .command: return "Say what to change, then let go."
            case .listening where engine.currentMode == .engineer: return "Listening for a prompt… double-tap for \(style.label)"
            case .done: return engine.lastResult.map { $0.dropped ? "Didn't catch anything" : "\($0.label) · \($0.totalMs) ms" } ?? "Done"
            case .failed: return engine.lastError ?? "Something went wrong"
            default: return "Tap: Prompt · Double-tap: \(style.label) · Hold: Edit what's below"
            }
        }()
        return Text(text)
            .font(.subheadline)
            .foregroundStyle(Brand.muted)
            .multilineTextAlignment(.center)
            .contentTransition(.opacity)
            .animation(.easeInOut, value: text)
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading) {
            Text(value).font(.title2.bold())
            Text(label).font(.subheadline).foregroundStyle(Brand.muted)
        }
    }
}

/// On/off for the Flow Session the keyboard relies on.
struct SessionToggle: View {
    @EnvironmentObject var engine: FlowEngine

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            if engine.sessionOn { engine.endSession() } else { engine.startSession() }
        } label: {
            HStack(spacing: 6) {
                Circle().fill(engine.sessionOn ? Color.green : Brand.muted).frame(width: 8, height: 8)
                Text(engine.sessionOn ? "Session on" : "Session off").font(.footnote.weight(.semibold))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Capsule().fill(Brand.surfaceHigh))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
    }
}
