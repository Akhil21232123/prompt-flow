import SwiftUI

/// One gesture for the mic: a tap, or a hold (press past `Gestures.holdAfter`).
/// Double-tap is handled by the caller (a second tap soon after the first),
/// so recording starts on the very first touch with no waiting.
struct TapHold: ViewModifier {
    var onTap: () -> Void
    var onHoldStart: () -> Void
    var onHoldEnd: () -> Void

    @State private var pressed = false
    @State private var holding = false
    @State private var holdTimer: DispatchWorkItem?

    func body(content: Content) -> some View {
        content
            .scaleEffect(pressed ? 0.96 : 1)
            .animation(.spring(response: 0.2, dampingFraction: 0.7), value: pressed)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !pressed else { return }
                        pressed = true
                        let work = DispatchWorkItem {
                            holding = true
                            onHoldStart()
                        }
                        holdTimer = work
                        DispatchQueue.main.asyncAfter(deadline: .now() + Gestures.holdAfter, execute: work)
                    }
                    .onEnded { _ in
                        pressed = false
                        holdTimer?.cancel()
                        holdTimer = nil
                        if holding {
                            holding = false
                            onHoldEnd()
                        } else {
                            onTap()
                        }
                    }
            )
    }
}

extension View {
    func tapHold(onTap: @escaping () -> Void, onHoldStart: @escaping () -> Void, onHoldEnd: @escaping () -> Void) -> some View {
        modifier(TapHold(onTap: onTap, onHoldStart: onHoldStart, onHoldEnd: onHoldEnd))
    }
}

/// Horizontal chips for picking the double-tap style.
struct StylePicker: View {
    @Binding var selection: StylePreset
    var compact = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(StylePreset.allCases) { p in
                    Text(p.label)
                        .font((compact ? Font.footnote : .subheadline).weight(.semibold))
                        .foregroundStyle(p == selection ? .white : Brand.muted)
                        .padding(.horizontal, compact ? 12 : 14)
                        .padding(.vertical, compact ? 6 : 8)
                        .background(Capsule().fill(p == selection ? AnyShapeStyle(Brand.gradient(.dictate)) : AnyShapeStyle(Brand.surfaceHigh)))
                        .contentShape(Capsule())
                        .onTapGesture {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { selection = p }
                            UISelectionFeedbackGenerator().selectionChanged()
                        }
                        .accessibilityAddTraits(p == selection ? [.isButton, .isSelected] : .isButton)
                }
            }
            .padding(.horizontal, 2)
        }
    }
}
