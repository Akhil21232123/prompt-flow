import SwiftUI

struct SettingsView: View {
    @State private var settings: [String: Any] = [:]
    @State private var signedIn = SharedStore.shared.session != nil
    @State private var serverURL = SharedStore.shared.serverURL
    @State private var anonKey = SharedStore.shared.anonKey
    @State private var sessionMinutes = SharedStore.shared.sessionMinutes

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    if signedIn {
                        Text(SharedStore.shared.session?.email ?? "")
                        Button("Sign out", role: .destructive) {
                            API.shared.signOut()
                            signedIn = false
                        }
                    } else {
                        AccountForm { signedIn = true }
                    }
                }

                Section {
                    ForEach([("email", "Email"), ("work_chat", "Work messages"), ("personal_chat", "Personal messages"), ("docs", "Documents"), ("other", "Other")], id: \.0) { key, label in
                        Picker(label, selection: styleBinding(key)) {
                            Text("Formal").tag("formal")
                            Text("Casual").tag("casual")
                            Text("Very casual").tag("very_casual")
                        }
                    }
                } header: {
                    Text("Style")
                } footer: {
                    Text("How formal your writing is in each kind of app.")
                }

                Section {
                    Picker("Quality", selection: engineerBinding("quality", "balanced")) {
                        Text("Fast").tag("fast")
                        Text("Balanced").tag("balanced")
                        Text("Max").tag("max")
                    }
                    Toggle("Auto in AI apps", isOn: engineerBool("auto_in_ai_apps", true))
                } header: {
                    Text("Prompt Engineer")
                } footer: {
                    Text("Balanced writes the prompt, then a second pass critiques and improves it. Anything you didn't say is blocked before it reaches you.")
                }

                Section("Language") {
                    Picker("Speech", selection: topBinding("language", "en")) {
                        Text("English").tag("en")
                        Text("Hindi").tag("hi")
                        Text("Auto-detect").tag("auto")
                    }
                }

                Section {
                    Picker("Flow Session length", selection: $sessionMinutes) {
                        Text("5 minutes").tag(5)
                        Text("15 minutes").tag(15)
                        Text("1 hour").tag(60)
                        Text("Until I turn it off").tag(100_000)
                    }
                    .onChange(of: sessionMinutes) { _, v in SharedStore.shared.sessionMinutes = v }
                    Toggle("Keep history in the cloud", isOn: topBool("store_history", true))
                } header: {
                    Text("Session and privacy")
                } footer: {
                    Text("While a session is on, the keyboard can start dictating without opening the app. iOS shows the orange mic dot the whole time.")
                }

                Section("Server") {
                    TextField("Server URL", text: $serverURL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Public (anon) key", text: $anonKey).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Save") {
                        SharedStore.shared.serverURL = serverURL
                        SharedStore.shared.anonKey = anonKey
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("Settings")
            .task(id: signedIn) {
                if signedIn, let s = try? await API.shared.settings() { settings = s }
            }
        }
    }

    // MARK: Bindings into the synced settings document

    private func save() {
        let snapshot = settings
        Task { try? await API.shared.saveSettings(snapshot) }
    }

    private func topBinding(_ key: String, _ fallback: String) -> Binding<String> {
        Binding(get: { settings[key] as? String ?? fallback }, set: { settings[key] = $0; save() })
    }

    private func topBool(_ key: String, _ fallback: Bool) -> Binding<Bool> {
        Binding(get: { settings[key] as? Bool ?? fallback }, set: { settings[key] = $0; save() })
    }

    private func styleBinding(_ key: String) -> Binding<String> {
        let fallback = (key == "email" || key == "docs") ? "formal" : "casual"
        return Binding(
            get: { (settings["styles"] as? [String: Any])?[key] as? String ?? fallback },
            set: { v in
                var styles = settings["styles"] as? [String: Any] ?? [:]
                styles[key] = v
                settings["styles"] = styles
                save()
            }
        )
    }

    private func engineerBinding(_ key: String, _ fallback: String) -> Binding<String> {
        Binding(
            get: { (settings["engineer"] as? [String: Any])?[key] as? String ?? fallback },
            set: { v in
                var e = settings["engineer"] as? [String: Any] ?? [:]
                e[key] = v
                settings["engineer"] = e
                save()
            }
        )
    }

    private func engineerBool(_ key: String, _ fallback: Bool) -> Binding<Bool> {
        Binding(
            get: { (settings["engineer"] as? [String: Any])?[key] as? Bool ?? fallback },
            set: { v in
                var e = settings["engineer"] as? [String: Any] ?? [:]
                e[key] = v
                settings["engineer"] = e
                save()
            }
        )
    }
}
