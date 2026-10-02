import SwiftUI
import UIKit

/// 应用市场（原生）：可见应用列表 + 授权 / 取消授权 / 打开应用（IdP 发起式）。
struct AppsTabView: View {
    @EnvironmentObject var state: AppState
    @State private var apps: [[String: Any]] = []
    @State private var loading = false
    @State private var busyId: String?
    @State private var msg: String?
    @State private var search = ""
    @State private var cat = ""   // 分类筛选（""=全部）

    private var categories: [String] {
        var seen: [String] = []
        for a in apps {
            let c = ((a["category"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
            if !c.isEmpty && !seen.contains(c) { seen.append(c) }
        }
        return seen
    }
    private var filtered: [[String: Any]] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        return apps.filter { a in
            let name = ((a["name"] as? String) ?? "").lowercased()
            let desc = ((a["description"] as? String) ?? "").lowercased()
            let c = ((a["category"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
            let okQ = q.isEmpty || name.contains(q) || desc.contains(q)
            let okC = cat.isEmpty || c == cat
            return okQ && okC
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if !categories.isEmpty {
                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                chip("全部", "")
                                ForEach(categories, id: \.self) { c in chip(c, c) }
                            }
                        }
                    }
                }
                if filtered.isEmpty && !loading {
                    Text("暂无可用应用").foregroundColor(.secondary)
                }
                ForEach(filtered.indices, id: \.self) { i in row(filtered[i]) }
            }
            .navigationTitle("应用市场")
            .searchable(text: $search, prompt: "搜索应用")
            .refreshable { await load() }
            .task { await load() }
            .alert("提示", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) {
                Button("好") { msg = nil }
            } message: { Text(msg ?? "") }
        }
    }

    @ViewBuilder
    private func chip(_ label: String, _ val: String) -> some View {
        Button { cat = val } label: {
            Text(label).font(.caption)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .background(cat == val ? Color.accentColor : Color(.secondarySystemBackground))
                .foregroundColor(cat == val ? .white : .primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func row(_ a: [String: Any]) -> some View {
        let id = (a["id"] as? String) ?? ""
        let name = (a["name"] as? String) ?? "应用"
        let desc = (a["description"] as? String) ?? ""
        let authed = (a["userAuthed"] as? Bool) ?? ((a["userAuthed"] as? Int) == 1)
        let hasLaunch = !((a["launch_url"] as? String) ?? "").isEmpty
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(.subheadline).bold()
                if !desc.isEmpty { Text(desc).font(.caption).foregroundColor(.secondary).lineLimit(2) }
                HStack(spacing: 6) {
                    if authed { Text("已授权").font(.caption2).foregroundColor(.green) }
                    let c = ((a["category"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
                    if !c.isEmpty { Text(c).font(.caption2).foregroundColor(.secondary).padding(.horizontal, 5).padding(.vertical, 1).background(Color(.tertiarySystemFill)).cornerRadius(4) }
                }
            }
            Spacer()
            if busyId == id {
                ProgressView()
            } else if authed || hasLaunch {
                Button("打开") { openApp(id: id, name: name) }
                    .buttonStyle(.borderedProminent).controlSize(.small)
            } else {
                Button("授权") { authorize(id: id) }
                    .buttonStyle(.bordered).controlSize(.small)
            }
        }
        .swipeActions(edge: .trailing) {
            if authed {
                Button(role: .destructive) { revoke(id: id) } label: { Text("取消授权") }
            }
        }
    }

    private func authorize(id: String) {
        busyId = id
        Task {
            do { try await state.api().appAuthorize(id: id, token: state.token); await load() }
            catch { await MainActor.run { msg = error.localizedDescription } }
            await MainActor.run { busyId = nil }
        }
    }

    private func revoke(id: String) {
        busyId = id
        Task {
            do { try await state.api().appRevoke(id: id, token: state.token); await load() }
            catch { await MainActor.run { msg = error.localizedDescription } }
            await MainActor.run { busyId = nil }
        }
    }

    private func openApp(id: String, name: String) {
        busyId = id
        Task {
            do {
                let urlStr = try await state.api().appLaunch(id: id, token: state.token)
                await MainActor.run {
                    busyId = nil
                    if let u = URL(string: urlStr) { UIApplication.shared.open(u) }
                    else { msg = "无法打开该应用" }
                }
            } catch {
                await MainActor.run { busyId = nil; msg = error.localizedDescription }
            }
        }
    }

    private func load() async {
        guard !state.token.isEmpty else { return }
        loading = true
        let list = (try? await state.api().appsMarket(token: state.token)) ?? []
        await MainActor.run { apps = list; loading = false }
    }
}
