import SwiftUI

/// 我的（原生）：资料 + 实名状态 + 切换系统 + 扫一扫 + 网页控制台（其余未原生化功能兜底）+ 退出。
struct MeTabView: View {
    @EnvironmentObject var state: AppState
    @State private var webPath: String?
    @State private var showSwitcher = false
    @State private var kycVerified = false
    @State private var kycText = "未实名"

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        ZStack {
                            Circle().fill(Color.accentColor.opacity(0.15)).frame(width: 52, height: 52)
                            Text(String((state.meName.isEmpty ? "?" : state.meName).prefix(1)))
                                .font(.title3).bold().foregroundColor(.accentColor)
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            Text(state.meName.isEmpty ? "未命名" : state.meName).font(.headline)
                            if !state.meUid.isEmpty { Text(state.meUid).font(.caption).foregroundColor(.secondary) }
                            Text(state.domain).font(.caption2).foregroundColor(.secondary)
                        }
                    }.padding(.vertical, 4)
                }

                Section("账号") {
                    HStack {
                        Label("实名认证", systemImage: kycVerified ? "checkmark.seal.fill" : "seal")
                            .foregroundColor(kycVerified ? .green : .primary)
                        Spacer()
                        Text(kycText).font(.caption).foregroundColor(.secondary)
                    }
                    Button { webPath = "/dashboard.html" } label: { Label("账号设定 / 更多（网页）", systemImage: "gearshape") }
                }

                Section("功能") {
                    NavigationLink { ScannerView(onResult: handleScan) } label: { Label("扫一扫", systemImage: "qrcode.viewfinder") }
                    Button { showSwitcher = true } label: { Label("切换系统", systemImage: "arrow.left.arrow.right.circle") }
                    Button { webPath = "/dashboard.html" } label: { Label("打开网页控制台", systemImage: "safari") }
                }

                Section {
                    Button(role: .destructive) { state.logoutCurrent() } label: {
                        Text("退出登录").frame(maxWidth: .infinity)
                    }
                }
            }
            .navigationTitle("我的")
            .task { await load() }
            .sheet(item: Binding(get: { webPath.map { WebTarget(path: $0) } },
                                 set: { webPath = $0?.path })) { target in
                WebFallbackView(url: state.baseURL + target.path, onToken: { t in state.setToken(t) })
            }
            .sheet(isPresented: $showSwitcher) { SystemSwitcherView() }
        }
    }

    private func handleScan(_ value: String) {
        if let url = URL(string: value), url.scheme == "qwqsso" { state.handleDeepLink(url) }
    }

    private func load() async {
        guard !state.token.isEmpty else { return }
        do {
            let u = try await state.api().meUser(token: state.token)
            await MainActor.run {
                if let name = u["name"] as? String { state.setMe(name: name, uid: state.meUid.isEmpty ? uidOf(u) : state.meUid) }
                let verified = ((u["kyc_verified"] as? Int) ?? 0) == 1 || (u["kyc_verified"] as? Bool) == true
                kycVerified = verified
                if verified {
                    let nm = (u["kyc_name"] as? String) ?? ""
                    let tail = (u["kyc_id_tail"] as? String) ?? ""
                    kycText = "已实名 " + [nm, tail].filter { !$0.isEmpty }.joined(separator: " ")
                } else { kycText = "未实名" }
            }
        } catch {
            await MainActor.run { state.logoutCurrent() }   // token 失效
        }
    }

    private func uidOf(_ u: [String: Any]) -> String {
        if let c = u["uid_code"] as? String, !c.isEmpty { return c }
        if let s = u["uid_seq"] as? Int { return String(format: "#%05d", s) }
        return ""
    }
}
