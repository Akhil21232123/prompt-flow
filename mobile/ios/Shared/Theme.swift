import SwiftUI

enum Brand {
    static let violet = Color(red: 0.545, green: 0.486, blue: 1.0)
    static let pink = Color(red: 1.0, green: 0.435, blue: 0.71)
    static let blue = Color(red: 0.31, green: 0.545, blue: 1.0)
    static let amber = Color(red: 1.0, green: 0.71, blue: 0.28)
    static let ink = Color(red: 0.043, green: 0.043, blue: 0.07)
    static let surface = Color(red: 0.082, green: 0.082, blue: 0.12)
    static let surfaceHigh = Color(red: 0.118, green: 0.118, blue: 0.17)
    static let muted = Color(red: 0.6, green: 0.6, blue: 0.69)

    static func gradient(_ mode: Mode) -> LinearGradient {
        switch mode {
        case .dictate: return LinearGradient(colors: [violet, pink], startPoint: .topLeading, endPoint: .bottomTrailing)
        case .engineer: return LinearGradient(colors: [violet, blue], startPoint: .topLeading, endPoint: .bottomTrailing)
        case .command: return LinearGradient(colors: [amber, pink], startPoint: .topLeading, endPoint: .bottomTrailing)
        }
    }
}

/// Five rounded bars: still and stepped when idle, dancing with `level`
/// while listening.
struct WaveBars: View {
    var level: Double
    var active: Bool
    var color: Color = .white

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60, paused: !active)) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            HStack(spacing: 4) {
                ForEach(0..<5, id: \.self) { i in
                    let idle = 1 - 0.22 * Double(abs(2 - i))
                    let wave = 0.3 + 0.7 * abs(sin(t * 4 + Double(i) * 0.9)) * (0.35 + level)
                    Capsule()
                        .fill(color)
                        .frame(width: 5, height: max(6, 30 * min(1, active ? wave : idle)))
                }
            }
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: level)
        }
    }
}
