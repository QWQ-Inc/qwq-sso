import SwiftUI

/// 登录审批（App 审批式 2FA，v3.5.94）：列出待批准的登录请求，可批准/拒绝。
/// 进页轮询;批准后该请求消失,登录页那端轮询到 approved 即放行。
struct LoginApprovalsView: View {
    @EnvironmentObject var state: AppState
    @State private var items: [[String: Any]] = []
    @State private var busyId: String?
    @State private var toast: String?
    @State private var timer: Timer?

    var body: some View {
        List {
            if items.isEmpty {
                Text("当前没有待批准的登录请求。\n在别处登录你的账号时,这里会出现「批准/拒绝」。")
                    .font(.footnote).foregroundColor(.secondary)
            }
            ForEach(items.indices, id: \.self) { i in row(items[i]) }
        }
        .navigationTitle("登录审批")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load(); startPoll() }
        .onDisappear { timer?.invalidate(); timer = nil }
        .overlay(alignment: .bottom) {
            if let t = toast {
                Text(t).font(.caption).padding(8).background(.ultraThinMaterial).cornerRadius(8).padding(.bottom, 10)
                    .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { toast = nil } }
            }
        }
    }

    @ViewBuilder
    private func row(_ d: [String: Any]) -> some View {
        let id = (d["id"] as? String) ?? ""
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: "person.badge.key").foregroundColor(.orange)
                Text("有一次登录请求").font(.headline)
            }
            Group {
                Text("方式：\((d["method"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "账号登录")")
                if let ip = d["ip"] as? String, !ip.isEmpty { Text("来源 IP：\(ip)") }
                Text("时间：\((d["created_at"] as? String) ?? "")")
            }.font(.caption).foregroundColor(.secondary)
            Text("不是你本人在登录?请点拒绝。").font(.caption2).foregroundColor(.secondary)
            HStack(spacing: 10) {
                Button { decide(id, "approve") } label: { Label("批准", systemImage: "checkmark.circle.fill") }
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(.green)
                Button(role: .destructive) { decide(id, "deny") } label: { Label("拒绝", systemImage: "xmark.circle") }
                    .buttonStyle(.bordered).controlSize(.small)
                if busyId == id { ProgressView().controlSize(.small) }
            }.padding(.top, 2)
        }.padding(.vertical, 4)
    }

    private func startPoll() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in Task { await load() } }
    }
    private func load() async {
        guard !state.token.isEmpty else { return }
        if let list = try? await state.api().pendingApprovals(token: state.token) {
            await MainActor.run { items = list }
        }
    }
    private func decide(_ id: String, _ action: String) {
        busyId = id
        Task {
            do {
                try await state.api().decideApproval(id, action: action, token: state.token)
                await MainActor.run { toast = action == "approve" ? "已批准,回到登录设备即可进入" : "已拒绝该登录"; busyId = nil }
                await load()
            } catch {
                await MainActor.run { toast = "操作失败"; busyId = nil }
            }
        }
    }
}
