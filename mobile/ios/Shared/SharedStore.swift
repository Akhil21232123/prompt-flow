import Foundation

/// State shared between the app and the keyboard through the App Group.
/// The keyboard can't use the microphone (Apple forbids it for every
/// keyboard), so the app records during a Flow Session and the two talk
/// through this store plus Darwin notifications (see `Bridge`).
final class SharedStore {
    static let groupId = "group.com.akhil.promptflow"
    static let shared = SharedStore()

    let defaults: UserDefaults

    init(defaults: UserDefaults? = nil) {
        self.defaults = defaults ?? UserDefaults(suiteName: SharedStore.groupId) ?? .standard
    }

    // MARK: Server and account

    var serverURL: String {
        get { nonEmpty(defaults.string(forKey: "serverURL")) ?? nonEmpty(Self.bundleValue("PromptFlowSupabaseURL")) ?? Self.hostedURL }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "/")), forKey: "serverURL") }
    }

    var anonKey: String {
        get { nonEmpty(defaults.string(forKey: "anonKey")) ?? nonEmpty(Self.bundleValue("PromptFlowSupabaseAnonKey")) ?? Self.hostedKey }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespaces), forKey: "anonKey") }
    }

    var isServerConfigured: Bool { serverURL.hasPrefix("https://") && !anonKey.isEmpty }

    var session: AuthSession? {
        get { decode(AuthSession.self, "session") }
        set { encode(newValue, "session") }
    }

    var onboarded: Bool {
        get { defaults.bool(forKey: "onboarded") }
        set { defaults.set(newValue, forKey: "onboarded") }
    }

    // MARK: Flow Session (app → keyboard)

    /// The app refreshes this every second while a session is live.
    var heartbeat: Date? {
        get { defaults.object(forKey: "heartbeat") as? Date }
        set { defaults.set(newValue, forKey: "heartbeat") }
    }

    var sessionIsLive: Bool {
        guard let beat = heartbeat else { return false }
        return Date().timeIntervalSince(beat) < 3.5
    }

    var phase: FlowPhase {
        get { FlowPhase(rawValue: defaults.string(forKey: "phase") ?? "") ?? .off }
        set { defaults.set(newValue.rawValue, forKey: "phase") }
    }

    var level: Double {
        get { defaults.double(forKey: "level") }
        set { defaults.set(newValue, forKey: "level") }
    }

    var lastError: String? {
        get { defaults.string(forKey: "lastError") }
        set { defaults.set(newValue, forKey: "lastError") }
    }

    /// Minutes a Flow Session stays on without use.
    var sessionMinutes: Int {
        get { let v = defaults.integer(forKey: "sessionMinutes"); return v == 0 ? 15 : v }
        set { defaults.set(newValue, forKey: "sessionMinutes") }
    }

    // MARK: Request and result (keyboard ↔ app)

    var requestedMode: Mode {
        get { Mode(rawValue: defaults.string(forKey: "requestedMode") ?? "") ?? .dictate }
        set { defaults.set(newValue.rawValue, forKey: "requestedMode") }
    }

    /// The style a double-tap writes in.
    var stylePreset: StylePreset {
        get { StylePreset(rawValue: defaults.string(forKey: "stylePreset") ?? "") ?? .clean }
        set { defaults.set(newValue.rawValue, forKey: "stylePreset") }
    }

    /// The instruction behind the Custom style (also synced to the account).
    var customStyle: String {
        get { defaults.string(forKey: "customStyle") ?? "" }
        set { defaults.set(newValue, forKey: "customStyle") }
    }

    var fieldContext: FieldContext? {
        get { decode(FieldContext.self, "fieldContext") }
        set { encode(newValue, "fieldContext") }
    }

    /// The finished text waiting for the keyboard to insert, with an id so it
    /// is inserted exactly once.
    var pendingResult: (id: String, text: String)? {
        get {
            guard let id = defaults.string(forKey: "resultId"),
                  let text = defaults.string(forKey: "resultText") else { return nil }
            return (id, text)
        }
        set {
            defaults.set(newValue?.id, forKey: "resultId")
            defaults.set(newValue?.text, forKey: "resultText")
        }
    }

    var lastInsertedId: String? {
        get { defaults.string(forKey: "lastInsertedId") }
        set { defaults.set(newValue, forKey: "lastInsertedId") }
    }

    // MARK: Local history and stats

    var history: [HistoryItem] {
        get { decode([HistoryItem].self, "history") ?? [] }
        set { encode(Array(newValue.prefix(200)), "history") }
    }

    var wordsDictated: Int {
        get { defaults.integer(forKey: "wordsDictated") }
        set { defaults.set(newValue, forKey: "wordsDictated") }
    }

    // MARK: Helpers

    private func nonEmpty(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        return s
    }

    /// The hosted PromptFlow backend. Public by design: the key only allows
    /// what row-level security permits.
    static let hostedURL = "https://fhslwvrspzdcvokajvno.supabase.co"
    static let hostedKey = "sb_publishable_havZ6UNdxBtt0AtqpBZaaw_Y_lr8Lss"

    private static func bundleValue(_ key: String) -> String {
        (Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? ""
    }

    private func decode<T: Decodable>(_ type: T.Type, _ key: String) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private func encode<T: Encodable>(_ value: T?, _ key: String) {
        if let value, let data = try? JSONEncoder().encode(value) {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}
