import SwiftUI

struct WordsView: View {
    @State private var tab = 0
    @State private var words: [DictionaryWord] = []
    @State private var snippets: [Snippet] = []
    @State private var draft = ""
    @State private var trigger = ""
    @State private var expansion = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Picker("", selection: $tab) {
                    Text("Dictionary").tag(0)
                    Text("Snippets").tag(1)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)

                if let error {
                    Text(error).foregroundStyle(.red).font(.footnote).listRowBackground(Color.clear)
                }

                if tab == 0 {
                    Section {
                        HStack {
                            TextField("Add a word or name", text: $draft).textInputAutocapitalization(.never)
                            Button("Add") { add() }.disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    } footer: {
                        Text("PromptFlow always spells these right, and learns new ones when you fix a word it got wrong.")
                    }
                    .listRowBackground(Brand.surface)
                    ForEach(words) { w in
                        VStack(alignment: .leading) {
                            Text(w.word)
                            if w.source == "learned" { Text("Learned from your edits").font(.caption).foregroundStyle(Brand.muted) }
                        }
                        .listRowBackground(Brand.surface)
                    }
                    .onDelete { idx in
                        let ids = idx.map { words[$0].id }
                        words.remove(atOffsets: idx)
                        Task { for id in ids { try? await API.shared.deleteWord(id: id) } }
                    }
                } else {
                    Section {
                        TextField("Trigger, e.g. my calendly link", text: $trigger).textInputAutocapitalization(.never)
                        TextField("Text to insert", text: $expansion, axis: .vertical)
                        Button("Save snippet") { saveSnippet() }
                            .disabled(trigger.isEmpty || expansion.isEmpty)
                    } footer: {
                        Text("Say the trigger, get the text. Links and addresses are never reworded.")
                    }
                    .listRowBackground(Brand.surface)
                    ForEach(snippets) { s in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("“\(s.trigger)”").font(.headline)
                            Text(s.expansion).font(.subheadline).foregroundStyle(Brand.muted).lineLimit(2)
                        }
                        .listRowBackground(Brand.surface)
                    }
                    .onDelete { idx in
                        let ids = idx.map { snippets[$0].id }
                        snippets.remove(atOffsets: idx)
                        Task { for id in ids { try? await API.shared.deleteSnippet(id: id) } }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .navigationTitle("Words")
            .task { await reload() }
            .refreshable { await reload() }
        }
    }

    private func reload() async {
        do {
            words = try await API.shared.dictionary()
            snippets = try await API.shared.snippets()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func add() {
        let w = draft
        draft = ""
        Task {
            do { try await API.shared.addWord(w) } catch { self.error = error.localizedDescription }
            await reload()
        }
    }

    private func saveSnippet() {
        let t = trigger, e = expansion
        trigger = ""
        expansion = ""
        Task {
            do { try await API.shared.saveSnippet(trigger: t, expansion: e) } catch { self.error = error.localizedDescription }
            await reload()
        }
    }
}
