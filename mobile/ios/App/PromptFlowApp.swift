import AppIntents
import SwiftUI

@main
struct PromptFlowApp: App {
    @StateObject private var engine = FlowEngine.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(engine)
                .preferredColorScheme(.dark)
                .tint(Brand.violet)
                .onOpenURL { engine.handle(url: $0) }
        }
    }
}

/// "Start PromptFlow" for Shortcuts, the Action button and Control Center.
struct StartFlowSessionIntent: AppIntent {
    static let title: LocalizedStringResource = "Start PromptFlow"
    static let description = IntentDescription("Turns on a Flow Session so the PromptFlow keyboard can dictate.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        FlowEngine.shared.startSession()
        return .result()
    }
}

struct PromptFlowShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartFlowSessionIntent(),
            phrases: ["Start \(.applicationName)", "Start a Flow Session in \(.applicationName)"],
            shortTitle: "Start PromptFlow",
            systemImageName: "waveform"
        )
    }
}
