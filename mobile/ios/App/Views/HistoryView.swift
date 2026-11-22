import SwiftUI

struct HistoryView: View {
    @State private var items = SharedStore.shared.history
    @State private var open: UUID?

    var body: some View {
        NavigationStack {
            List {
                if items.isEmpty {
                    Text("Your dictations show up here, with what you said next to what PromptFlow wrote.")
                        .foregroundStyle(Brand.muted)
                        .listRowBackground(Color.clear)
                }
                ForEach(items) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(item.mode.label) · \(item.at.formatted(.relative(presentation: .named)))")
                            .font(.caption)
                            .foregroundStyle(Brand.muted)
                        Text(item.text).lineLimit(open == item.id ? nil : 3)
                        if open == item.id {
                            Text("You said").font(.caption.weight(.semibold)).foregroundStyle(Brand.violet).padding(.top, 4)
                            Text(item.raw).font(.subheadline).foregroundStyle(Brand.muted)
                            if !item.label.isEmpty { Text(item.label).font(.caption).foregroundStyle(Brand.muted) }
                            Button("Copy") { UIPasteboard.general.string = item.text }.font(.subheadline.weight(.semibold))
                        }
                    }
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                    .onTapGesture { withAnimation(.snappy) { open = open == item.id ? nil : item.id } }
                    .listRowBackground(Brand.surface)
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("History")
            .toolbar {
                if !items.isEmpty {
                    Button("Clear") {
                        SharedStore.shared.history = []
                        items = []
                    }
                }
            }
            .onAppear { items = SharedStore.shared.history }
        }
    }
}
