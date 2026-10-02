import SwiftUI

/// 备忘录（原生）：列表 + 新建/编辑（标题/正文/标签）+ 删除 + 转交 + 附件查看。
struct MemoTabView: View {
    @EnvironmentObject var state: AppState
    @State private var memos: [[String: Any]] = []
    @State private var loading = false
    @State private var editing: MemoRef?
    @State private var creatingNew = false

    var body: some View {
        NavigationStack {
            List {
                if memos.isEmpty && !loading {
                    Text("还没有备忘录，点右上角「+」新建").foregroundColor(.secondary)
                }
                ForEach(memos.indices, id: \.self) { i in
                    let m = memos[i]
                    let id = (m["id"] as? String) ?? ""
                    Button { editing = MemoRef(id: id) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(titleOf(m)).font(.subheadline).bold().foregroundColor(.primary)
                            let body = (m["body"] as? String) ?? ""
                            if !body.isEmpty {
                                Text(body).font(.caption).foregroundColor(.secondary).lineLimit(2)
                            }
                            HStack(spacing: 6) {
                                ForEach(tagsOf(m), id: \.self) { t in
                                    Text(t).font(.caption2).padding(.horizontal, 6).padding(.vertical, 1)
                                        .background(Color.accentColor.opacity(0.12)).cornerRadius(4)
                                }
                                let n = attCount(m)
                                if n > 0 { Text("📎 \(n)").font(.caption2).foregroundColor(.secondary) }
                            }
                        }
                    }
                }
                .onDelete { idx in
                    idx.map { (memos[$0]["id"] as? String) ?? "" }.filter { !$0.isEmpty }.forEach(delete)
                }
            }
            .navigationTitle("备忘录")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { creatingNew = true } label: { Image(systemName: "plus") }
                }
            }
            .refreshable { await load() }
            .task { await load() }
            .sheet(item: $editing, onDismiss: { Task { await load() } }) { ref in
                MemoEditView(memoId: ref.id)
            }
            .sheet(isPresented: $creatingNew, onDismiss: { Task { await load() } }) {
                MemoEditView(memoId: nil)
            }
        }
    }

    private func titleOf(_ m: [String: Any]) -> String {
        let t = (m["title"] as? String) ?? ""
        return t.isEmpty ? "(无标题)" : t
    }
    private func tagsOf(_ m: [String: Any]) -> [String] {
        if let a = m["tags"] as? [String] { return a }
        return []
    }
    private func attCount(_ m: [String: Any]) -> Int {
        if let n = m["attachments"] as? Int { return n }
        if let a = m["attachments"] as? [Any] { return a.count }
        return 0
    }

    private func delete(_ id: String) {
        Task { try? await state.api().memoDelete(id: id, token: state.token); await load() }
    }

    private func load() async {
        guard !state.token.isEmpty else { return }
        loading = true
        let list = (try? await state.api().memoList(token: state.token)) ?? []
        await MainActor.run { memos = list; loading = false }
    }
}

struct MemoRef: Identifiable { let id: String }
