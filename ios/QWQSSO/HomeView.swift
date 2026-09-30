import SwiftUI

struct HomeView: View {
    @EnvironmentObject var state: AppState
    @State private var webPath: String?
    @State private var loading = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                VStack(spacing: 6) {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.system(size: 46)).foregroundColor(.green)
                    Text(state.meName.isEmpty ? "已登录" : "欢迎，\(state.meName)")
                        .font(.title3).bold()
                    if !state.meUid.isEmpty {
                        Text(state.meUid).font(.footnote).foregroundColor(.secondary)
                    }
                    Text(state.domain).font(.caption2).foregroundColor(.secondary)
                }
                .padding(.top, 30)

                VStack(spacing: 12) {
                    NavigationLink { ScannerView(onResult: handleScan) } label: {
                        rowLabel("扫一扫", systemImage: "qrcode.viewfinder")
                    }
                    Button { webPath = "/dashboard.html" } label: {
                        rowLabel("打开网页控制台", systemImage: "safari")
                    }
                }

                Spacer()

                Button(role: .destructive) { state.logout() } label: {
                    Text("退出登录").frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(Color(.secondarySystemBackground)).cornerRadius(10)
                }
            }
            .padding(24)
            .navigationTitle("我的")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("换网域") { state.resetDomain() }
                }
            }
            .sheet(item: Binding(get: { webPath.map { WebTarget(path: $0) } },
                                 set: { webPath = $0?.path })) { target in
                WebFallbackView(url: state.baseURL + target.path)
            }
            .task { await loadMe() }
        }
    }

    private func rowLabel(_ title: String, systemImage: String) -> some View {
        HStack {
            Label(title, systemImage: systemImage)
            Spacer()
            Image(systemName: "chevron.right").foregroundColor(.secondary)
        }
        .padding(14).background(Color(.secondarySystemBackground)).cornerRadius(10)
    }

    private func handleScan(_ value: String) {
        if let url = URL(string: value), url.scheme == "qwqsso" { state.handleDeepLink(url) }
    }

    private func loadMe() async {
        guard !state.token.isEmpty, state.meName.isEmpty else { return }
        do {
            let me = try await state.api().me(token: state.token)
            await MainActor.run { state.meName = me.name; state.meUid = me.uid }
        } catch {
            // 令牌失效 → 退回登录
            await MainActor.run { state.logout() }
        }
    }
}
