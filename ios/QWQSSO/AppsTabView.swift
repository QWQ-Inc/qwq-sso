import SwiftUI
import UIKit

/// 应用市场（原生）：可见应用列表 + 授权 / 取消授权 / 打开应用（IdP 发起式）。
struct AppsTabView: View {
    @EnvironmentObject var state: AppState
    @State private var apps: [[String: Any]] = []
    @State private var loading = false
    @State private var busyId: String?
    @State private var msg: String?

    var body: some View {
        NavigationStack {
            List {
                if apps.isEmpty && !loading {
                    Text("暂无可用应用").foregroundColor(.secondary)
                }
                ForEach(apps.indices, id: \.self) { i in row(apps[i]) }
            }
            .navigationTitle("应用市场")
            .refreshable { await load() }
            .task { await load() }
            .alert("提示", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) {
                Button("好") { msg = nil }
            } message: { Text(msg ?? "") }
        }
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
                if authed { Text("已授权").font(.caption2).foregroundColor(.green) }
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
