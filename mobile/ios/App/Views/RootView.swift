import SwiftUI

struct RootView: View {
    @EnvironmentObject var engine: FlowEngine
    @State private var onboarded = SharedStore.shared.onboarded

    var body: some View {
        ZStack {
            Brand.ink.ignoresSafeArea()
            if onboarded {
                TabView {
                    HomeView().tabItem { Label("Flow", systemImage: "waveform") }
                    HistoryView().tabItem { Label("History", systemImage: "clock.arrow.circlepath") }
                    WordsView().tabItem { Label("Words", systemImage: "character.book.closed") }
                    SettingsView().tabItem { Label("Settings", systemImage: "slider.horizontal.3") }
                }
                .transition(.opacity)
            } else {
                OnboardingView {
                    SharedStore.shared.onboarded = true
                    withAnimation(.easeInOut) { onboarded = true }
                }
                .transition(.opacity)
            }
        }
        .overlay(alignment: .top) {
            if engine.showReturnHint {
                ReturnHint().transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.85), value: engine.showReturnHint)
    }
}

/// Shown when the keyboard opened the app to start a Flow Session.
private struct ReturnHint: View {
    @EnvironmentObject var engine: FlowEngine

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "arrow.uturn.backward.circle.fill").font(.title2)
            VStack(alignment: .leading, spacing: 2) {
                Text(engine.phase == .listening ? "Listening. Go back and keep talking." : "PromptFlow is on")
                    .font(.headline)
                Text("Tap ◀ at the top left, or swipe right along the bottom edge.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.85))
            }
            Spacer()
            Button { engine.showReturnHint = false } label: { Image(systemName: "xmark").font(.headline) }
        }
        .foregroundStyle(.white)
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Brand.gradient(.dictate)))
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .task {
            try? await Task.sleep(for: .seconds(8))
            engine.showReturnHint = false
        }
    }
}
