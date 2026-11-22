import SwiftUI

struct HomeView: View {
    @EnvironmentObject var engine: FlowEngine
    @State private var mode: Mode = .dictate
    @State private var pad = ""
    private let store = SharedStore.shared

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                HStack {
                    Text("PromptFlow").font(.title2.bold())
                    Spacer()
                    SessionToggle()
                }
                ModeSwitch(mode: $mode)
                Orb(phase: engine.phase, mode: mode, level: engine.level) {
                    engine.toggleInApp(mode: mode, field: FieldContext(before: pad, selection: mode == .command ? pad : nil)) { result in
                        if mode == .command {
                            pad = result.text
                        } else {
                            pad = [pad, result.text].filter { !$0.isEmpty }.joined(separator: pad.isEmpty ? "" : " ")
                        }
                    }
                }
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
                    Text("Switch to PromptFlow with 🌐, tap the mic, talk, tap again. Pick Prompt to turn a ramble into an engineered prompt, or Edit to rewrite selected text.")
                        .foregroundStyle(Brand.muted)
                        .font(.subheadline)
                }
            }
            .padding(20)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var status: some View {
        let text: String = {
            switch engine.phase {
            case .listening: return "Listening…"
            case .working: return mode == .engineer ? "Engineering your prompt…" : "Polishing…"
            case .done: return engine.lastResult.map { $0.dropped ? "Didn't catch anything" : "\($0.label) · \($0.totalMs) ms" } ?? "Done"
            case .failed: return engine.lastError ?? "Something went wrong"
            default: return mode.hint
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
