import Foundation

struct APIError: LocalizedError {
    var message: String
    var status: Int = 0
    var code: String = ""
    var errorDescription: String? { message }
    var needsSignIn: Bool { status == 401 || code == "auth" || code == "config" }
}

/// Talks to the PromptFlow backend (Supabase): email-code sign-in, the
/// dictate/rewrite/learn functions, and the user's own rows.
final class API {
    static let shared = API()

    private let store: SharedStore
    private let urlSession: URLSession

    init(store: SharedStore = .shared, urlSession: URLSession = .shared) {
        self.store = store
        self.urlSession = urlSession
    }

    // MARK: Auth

    func sendCode(email: String) async throws {
        // The email carries a link back to promptflow://auth (and a code when
        // the project's template includes one).
        _ = try await request("POST", "/auth/v1/otp?redirect_to=promptflow%3A%2F%2Fauth",
                              json: ["email": email.trimmed, "create_user": true], auth: false)
    }

    /// Finishes sign-in from the emailed link: promptflow://auth#access_token=…&refresh_token=…
    @discardableResult
    func completeLink(_ url: URL) async throws -> AuthSession {
        let params = API.linkParams(url)
        if let message = params["error_description"] {
            throw APIError(message: message, code: "auth")
        }
        guard let refresh = params["refresh_token"] else {
            throw APIError(message: "That sign-in link is incomplete. Ask for a new one.", code: "auth")
        }
        // Trade the link's refresh token for a full session (it includes the user).
        let data = try await request("POST", "/auth/v1/token?grant_type=refresh_token",
                                     json: ["refresh_token": refresh], auth: false)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let session = AuthSession.from(json: obj) else {
            throw APIError(message: "Unexpected sign-in response")
        }
        store.session = session
        NotificationCenter.default.post(name: .promptflowSignedIn, object: nil)
        return session
    }

    /// Key/value pairs from a link's fragment and query, form-decoded.
    static func linkParams(_ url: URL) -> [String: String] {
        var out: [String: String] = [:]
        for part in [url.query, url.fragment].compactMap({ $0 }) {
            for pair in part.split(separator: "&") {
                let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
                guard kv.count == 2 else { continue }
                let value = kv[1].replacingOccurrences(of: "+", with: " ")
                out[kv[0]] = value.removingPercentEncoding ?? value
            }
        }
        return out
    }

    @discardableResult
    func verifyCode(email: String, code: String) async throws -> AuthSession {
        let data = try await request("POST", "/auth/v1/verify",
                                     json: ["type": "email", "email": email.trimmed, "token": code.trimmed], auth: false)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let session = AuthSession.from(json: obj, fallbackEmail: email.trimmed) else {
            throw APIError(message: "Unexpected sign-in response")
        }
        store.session = session
        NotificationCenter.default.post(name: .promptflowSignedIn, object: nil)
        return session
    }

    func signOut() { store.session = nil }

    private func validSession() async throws -> AuthSession {
        guard let s = store.session else { throw APIError(message: "Sign in to PromptFlow first", status: 401, code: "auth") }
        guard s.isExpired else { return s }
        let data = try await request("POST", "/auth/v1/token?grant_type=refresh_token",
                                     json: ["refresh_token": s.refreshToken], auth: false)
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let fresh = AuthSession.from(json: obj, fallbackEmail: s.email) else {
            store.session = nil
            throw APIError(message: "Your session expired. Sign in again.", status: 401, code: "auth")
        }
        store.session = fresh
        return fresh
    }

    // MARK: Dictation

    func dictate(wav: Data, mode: Mode, field: FieldContext?, appName: String?, durationSec: Double) async throws -> DictationResult {
        var meta: [String: Any] = ["mode": mode.rawValue, "duration_sec": durationSec, "device": "ios"]
        var app: [String: Any] = [:]
        if let appName { app["name"] = appName }
        if let before = field?.before, !before.isEmpty { app["surrounding_text"] = String(before.suffix(1500)) }
        if !app.isEmpty { meta["app"] = app }
        if mode == .command, let sel = field?.selection, !sel.isEmpty { meta["selection"] = sel }

        let boundary = "PF\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        var body = Data()
        func line(_ s: String) { body.append(Data((s + "\r\n").utf8)) }
        line("--\(boundary)")
        line("Content-Disposition: form-data; name=\"meta\"")
        line("Content-Type: application/json")
        line("")
        line(String(data: try JSONSerialization.data(withJSONObject: meta), encoding: .utf8) ?? "{}")
        line("--\(boundary)")
        line("Content-Disposition: form-data; name=\"audio\"; filename=\"audio.wav\"")
        line("Content-Type: audio/wav")
        line("")
        body.append(wav)
        line("")
        line("--\(boundary)--")

        let data = try await request("POST", "/functions/v1/dictate", body: body,
                                     contentType: "multipart/form-data; boundary=\(boundary)")
        let obj = (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        return DictationResult.from(json: obj)
    }

    func learn(original: String, edited: String) async throws -> [String] {
        let data = try await request("POST", "/functions/v1/learn", json: ["original": original, "edited": edited])
        let obj = (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        return obj["learned"] as? [String] ?? []
    }

    // MARK: Dictionary, snippets, settings

    func dictionary() async throws -> [DictionaryWord] {
        let rows = try await rows("/rest/v1/dictionary_words?select=id,word,source&order=created_at.desc")
        return rows.compactMap { r in
            guard let id = r["id"] as? String, let w = r["word"] as? String else { return nil }
            return DictionaryWord(id: id, word: w, source: r["source"] as? String ?? "")
        }
    }

    func addWord(_ word: String) async throws {
        let s = try await validSession()
        _ = try await request("POST", "/rest/v1/dictionary_words", json: [["user_id": s.userId, "word": word.trimmed]],
                              prefer: "resolution=ignore-duplicates,return=minimal")
    }

    func deleteWord(id: String) async throws {
        _ = try await request("DELETE", "/rest/v1/dictionary_words?id=eq.\(id.urlEncoded)")
    }

    func snippets() async throws -> [Snippet] {
        let rows = try await rows("/rest/v1/snippets?select=id,trigger,expansion&order=created_at.desc")
        return rows.compactMap { r in
            guard let id = r["id"] as? String, let t = r["trigger"] as? String, let e = r["expansion"] as? String else { return nil }
            return Snippet(id: id, trigger: t, expansion: e)
        }
    }

    func saveSnippet(trigger: String, expansion: String) async throws {
        let s = try await validSession()
        _ = try await request("POST", "/rest/v1/snippets",
                              json: [["user_id": s.userId, "trigger": trigger.trimmed, "expansion": expansion]],
                              prefer: "return=minimal")
    }

    func deleteSnippet(id: String) async throws {
        _ = try await request("DELETE", "/rest/v1/snippets?id=eq.\(id.urlEncoded)")
    }

    func settings() async throws -> [String: Any] {
        let rows = try await rows("/rest/v1/user_settings?select=settings&limit=1")
        return rows.first?["settings"] as? [String: Any] ?? [:]
    }

    func saveSettings(_ settings: [String: Any]) async throws {
        let s = try await validSession()
        _ = try await request("POST", "/rest/v1/user_settings?on_conflict=user_id",
                              json: ["user_id": s.userId, "settings": settings],
                              prefer: "resolution=merge-duplicates,return=minimal")
    }

    // MARK: Plumbing

    private func rows(_ path: String) async throws -> [[String: Any]] {
        let data = try await request("GET", path)
        return (try JSONSerialization.jsonObject(with: data) as? [[String: Any]]) ?? []
    }

    private func request(_ method: String, _ path: String, json: Any? = nil, body: Data? = nil,
                         contentType: String? = nil, auth: Bool = true, prefer: String? = nil) async throws -> Data {
        guard store.isServerConfigured, let url = URL(string: store.serverURL + path) else {
            throw APIError(message: "Add the PromptFlow server in Settings", code: "config")
        }
        var req = URLRequest(url: url, timeoutInterval: 60)
        req.httpMethod = method
        req.setValue(store.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("promptflow-ios/0.1", forHTTPHeaderField: "x-client-info")
        // Signed-out calls send only the apikey: new-style publishable keys
        // (sb_publishable_…) aren't JWTs and are refused as a Bearer token.
        if auth {
            req.setValue("Bearer \(try await validSession().accessToken)", forHTTPHeaderField: "Authorization")
        } else if store.anonKey.hasPrefix("eyJ") {
            req.setValue("Bearer \(store.anonKey)", forHTTPHeaderField: "Authorization")
        }
        if let prefer { req.setValue(prefer, forHTTPHeaderField: "Prefer") }
        if let json {
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if let body {
            req.httpBody = body
            req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await urlSession.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let message = (obj?["error"] as? String) ?? (obj?["msg"] as? String)
                ?? (obj?["error_description"] as? String) ?? "Server error (\(status))"
            throw APIError(message: message, status: status, code: obj?["code"] as? String ?? "")
        }
        return data
    }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
    var urlEncoded: String { addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? self }
}

extension Notification.Name {
    static let promptflowSignedIn = Notification.Name("promptflowSignedIn")
    /// object: the error message (String)
    static let promptflowSignInFailed = Notification.Name("promptflowSignInFailed")
}
