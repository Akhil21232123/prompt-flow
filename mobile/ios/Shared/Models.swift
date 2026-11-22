import Foundation

enum Mode: String, Codable, CaseIterable, Identifiable {
    case dictate, engineer, command
    var id: String { rawValue }

    var label: String {
        switch self {
        case .dictate: return "Dictate"
        case .engineer: return "Prompt"
        case .command: return "Edit"
        }
    }

    var hint: String {
        switch self {
        case .dictate: return "Talk naturally. PromptFlow cleans it up."
        case .engineer: return "Ramble your request. Get a prompt built for the best answer."
        case .command: return "Say what to change about the selected text."
        }
    }
}

/// How a double-tap dictation is written. Single tap always engineers a
/// prompt; double-tap writes your words in one of these styles instead.
enum StylePreset: String, Codable, CaseIterable, Identifiable {
    case clean, formal, short, casual, bullets, custom
    var id: String { rawValue }

    var label: String {
        switch self {
        case .clean: return "Clean"
        case .formal: return "Formal"
        case .short: return "Short & punchy"
        case .casual: return "Casual"
        case .bullets: return "Bullets"
        case .custom: return "Custom"
        }
    }

    var hint: String {
        switch self {
        case .clean: return "Your words, tidied: no fillers, fixed grammar."
        case .formal: return "Professional and polished."
        case .short: return "Straight to the point, half the length."
        case .casual: return "Relaxed and friendly."
        case .bullets: return "A tight bulleted list."
        case .custom: return "Your own instruction, set in Settings."
        }
    }
}

/// Which gesture does what, shown in the keyboard and app.
enum Gestures {
    static let doubleTapWindow: TimeInterval = 0.35
    static let holdAfter: TimeInterval = 0.45
}

struct AuthSession: Codable, Equatable {
    var accessToken: String
    var refreshToken: String
    var expiresAt: TimeInterval
    var email: String
    var userId: String

    var isExpired: Bool { Date().timeIntervalSince1970 > expiresAt - 60 }

    /// Parses a Supabase (GoTrue) token response.
    static func from(json: [String: Any], fallbackEmail: String = "") -> AuthSession? {
        guard let access = json["access_token"] as? String,
              let refresh = json["refresh_token"] as? String else { return nil }
        let user = json["user"] as? [String: Any]
        let expiresAt: TimeInterval
        if let at = json["expires_at"] as? Double {
            expiresAt = at
        } else if let at = json["expires_at"] as? Int {
            expiresAt = TimeInterval(at)
        } else {
            let ttl = (json["expires_in"] as? Double) ?? Double(json["expires_in"] as? Int ?? 3600)
            expiresAt = Date().timeIntervalSince1970 + ttl
        }
        let email = (user?["email"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? fallbackEmail
        return AuthSession(accessToken: access, refreshToken: refresh, expiresAt: expiresAt,
                           email: email, userId: user?["id"] as? String ?? "")
    }
}

/// What the keyboard knew about the text field when dictation stopped.
struct FieldContext: Codable, Equatable {
    var before: String?
    var selection: String?
}

struct DictationResult: Codable, Equatable {
    var raw: String
    var text: String
    var mode: Mode
    var label: String
    var guarded: [String]
    var dropped: Bool
    var totalMs: Int

    static func from(json: [String: Any]) -> DictationResult {
        DictationResult(
            raw: json["raw"] as? String ?? "",
            text: json["text"] as? String ?? "",
            mode: Mode(rawValue: json["mode"] as? String ?? "") ?? .dictate,
            label: json["label"] as? String ?? "",
            guarded: json["guarded"] as? [String] ?? [],
            dropped: json["dropped"] as? Bool ?? false,
            totalMs: (json["timing"] as? [String: Any])?["total_ms"] as? Int ?? 0
        )
    }
}

struct HistoryItem: Codable, Identifiable, Equatable {
    var id = UUID()
    var at: Date
    var mode: Mode
    var raw: String
    var text: String
    var label: String
}

struct DictionaryWord: Identifiable, Equatable {
    var id: String
    var word: String
    var source: String
}

struct Snippet: Identifiable, Equatable {
    var id: String
    var trigger: String
    var expansion: String
}

/// The keyboard ↔ app state, as the keyboard draws it.
enum FlowPhase: String, Codable {
    case off, ready, listening, working, done, failed
}

extension String {
    var wordCount: Int { split(whereSeparator: { $0.isWhitespace }).count }
}
