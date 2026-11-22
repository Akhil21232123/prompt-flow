import SwiftUI

/// The big tappable orb: breathes when idle, swells with your voice.
struct Orb: View {
    var phase: FlowPhase
    var mode: Mode
    var level: Double
    var size: CGFloat = 176
    var action: () -> Void
    var onHoldStart: () -> Void = {}
    var onHoldEnd: () -> Void = {}

    @State private var breathe = false

    var body: some View {
        let listening = phase == .listening
        ZStack {
            if listening {
                TimelineView(.animation) { ctx in
                    let t = ctx.date.timeIntervalSinceReferenceDate
                    ZStack {
                        ForEach(0..<3, id: \.self) { i in
                            let p = (t / 1.4 + Double(i) / 3).truncatingRemainder(dividingBy: 1)
                            Circle()
                                .fill(Brand.pink.opacity((1 - p) * 0.35 * (0.4 + level)))
                                .frame(width: size * (1 + p * 0.45), height: size * (1 + p * 0.45))
                        }
                    }
                }
            }
            Circle()
                .fill(Brand.gradient(mode))
                .frame(width: size, height: size)
                .shadow(color: Brand.violet.opacity(0.45), radius: listening ? 30 : 18)
                .overlay {
                    if phase == .working {
                        ProgressView().tint(.white).scaleEffect(1.6)
                    } else if phase == .done {
                        Image(systemName: "checkmark").font(.system(size: 44, weight: .bold)).foregroundStyle(.white)
                    } else {
                        WaveBars(level: level, active: listening).scaleEffect(1.6)
                    }
                }
                .scaleEffect(listening ? 1 + level * 0.15 : (breathe ? 1.035 : 0.97))
                .animation(.spring(response: 0.35, dampingFraction: 0.6), value: level)
        }
        .frame(width: size * 1.5, height: size * 1.5)
        .contentShape(Circle())
        .tapHold(
            onTap: {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                action()
            },
            onHoldStart: {
                UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
                onHoldStart()
            },
            onHoldEnd: onHoldEnd
        )
        .onAppear {
            withAnimation(.easeInOut(duration: 2.2).repeatForever(autoreverses: true)) { breathe = true }
        }
        .accessibilityLabel(listening ? "Stop dictating" : "Start dictating")
        .accessibilityAddTraits(.isButton)
    }
}

struct ModeSwitch: View {
    @Binding var mode: Mode
    @Namespace private var ns

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Mode.allCases) { m in
                Text(m.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(m == mode ? .white : Brand.muted)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 9)
                    .background {
                        if m == mode {
                            Capsule().fill(Brand.gradient(m)).matchedGeometryEffect(id: "pill", in: ns)
                        }
                    }
                    .contentShape(Capsule())
                    .onTapGesture {
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { mode = m }
                        UISelectionFeedbackGenerator().selectionChanged()
                    }
            }
        }
        .padding(4)
        .background(Capsule().fill(Brand.surfaceHigh))
    }
}

struct CardBox<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 8) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Brand.surface))
    }
}

struct GradientButton: View {
    var title: String
    var mode: Mode = .dictate
    var enabled = true
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.headline)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Brand.gradient(mode)))
                .opacity(enabled ? 1 : 0.4)
        }
        .disabled(!enabled)
        .buttonStyle(.plain)
    }
}
