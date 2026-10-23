import SwiftUI

/// 实时确认（v3.5.103）：向服务端取一枚实时下发的滚动确认码，大字显示 + 倒计时，到期自动失效，可刷新。
/// 用户在需要双重验证的地方（本站登录二段 / 第三方应用·门户）读出并输入这个码完成校验。
struct RealtimeConfirmView: View {
    @EnvironmentObject var state: AppState
    @State private var code = ""
    @State private var left = 0
    @State private var busy = false
    @State private var err: String?
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var display: String {
        guard code.count == 6 else { return code.isEmpty ? "······" : code }
        let i = code.index(code.startIndex, offsetBy: 3)
        return code[..<i] + " " + code[i...]
    }

    var body: some View {
        VStack(spacing: 18) {
            Text("在需要双重验证的地方输入下面的确认码。到期会自动更新。")
                .font(.footnote).foregroundColor(.secondary)
                .multilineTextAlignment(.center).padding(.horizontal)

            Text(display)
                .font(.system(size: 44, weight: .heavy, design: .monospaced))
                .kerning(2).opacity(left > 0 ? 1 : 0.35)
                .textSelection(.enabled)

            if let err = err {
                Text(err).font(.footnote).foregroundColor(.red).multilineTextAlignment(.center)
            } else if busy {
                Text("获取中…").font(.caption).foregroundColor(.secondary)
            } else if left > 0 {
                Text("\(left) 秒后过期").font(.caption).foregroundColor(.secondary)
            } else if !code.isEmpty {
                Text("已过期，请刷新").font(.caption).foregroundColor(.orange)
            }

            Button { refresh() } label: {
                Label(code.isEmpty ? "获取确认码" : "刷新", systemImage: "arrow.clockwise")
            }.buttonStyle(.borderedProminent).disabled(busy)

            Spacer()
        }
        .padding(.top, 28)
        .navigationTitle("实时确认")
        .navigationBarTitleDisplayMode(.inline)
        .task { refresh() }
        .onReceive(timer) { _ in if left > 0 { left -= 1 } }
    }

    private func refresh() {
        busy = true; err = nil
        Task {
            do {
                let r = try await state.api().realtimeCode(token: state.token)
                await MainActor.run { code = r.code; left = r.expiresIn; busy = false }
            } catch {
                await MainActor.run { busy = false; err = error.localizedDescription }
            }
        }
    }
}
