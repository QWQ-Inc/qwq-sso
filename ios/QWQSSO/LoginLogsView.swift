import SwiftUI

/// 登录日志（原生）：展示近 N 天的登录记录。
struct LoginLogsView: View {
    @EnvironmentObject var state: AppState
    @State private var logs: [[String: Any]] = []
    @State private var windowDays = 30
    @State private var loading = false

    var body: some View {
        List {
            if logs.isEmpty && !loading {
                Text("暂无登录记录").foregroundColor(.secondary)
            }
            ForEach(logs.indices, id: \.self) { i in
                let l = logs[i]
                let ok = (l["status"] as? String) == "success"
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text((l["method"] as? String) ?? "登录").font(.subheadline)
                        Spacer()
                        Text(ok ? "成功" : "失败").font(.caption)
                            .foregroundColor(ok ? .green : .red)
                    }
                    Text(fmt(l["created_at"] as? String)).font(.caption).foregroundColor(.secondary)
                    HStack(spacing: 8) {
                        if let ip = l["ip"] as? String, !ip.isEmpty { Text(ip).font(.caption2).foregroundColor(.secondary) }
                        if let app = l["app_name"] as? String, !app.isEmpty { Text(app).font(.caption2).foregroundColor(.secondary) }
                    }
                    if !ok, let reason = l["fail_reason"] as? String, !reason.isEmpty {
                        Text(reason).font(.caption2).foregroundColor(.red)
                    }
                }
            }
        }
        .navigationTitle("登录日志")
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .bottom) {
            if !logs.isEmpty { Text("近 \(windowDays) 天，共 \(logs.count) 条").font(.caption2).foregroundColor(.secondary).padding(6) }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private func fmt(_ s: String?) -> String {
        guard let s = s else { return "" }
        return s.replacingOccurrences(of: "T", with: " ").replacingOccurrences(of: "Z", with: "")
    }

    private func load() async {
        guard !state.token.isEmpty else { return }
        loading = true
        if let r = try? await state.api().loginLogs(token: state.token) {
            await MainActor.run { logs = r.logs; windowDays = r.windowDays; loading = false }
        } else { await MainActor.run { loading = false } }
    }
}
