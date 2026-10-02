import SwiftUI

/// 账号设定（原生）：改邮箱/手机、两步验证；Passkey/更多绑定走网页（原生需 Associated Domains）。
struct AccountSettingsView: View {
    @EnvironmentObject var state: AppState
    @State private var twofaEnabled = false
    @State private var recoveryLeft = 0
    @State private var showDisable = false
    @State private var disableCode = ""
    @State private var err: String?

    var body: some View {
        List {
            Section("登录方式绑定") {
                NavigationLink { ContactChangeView(kind: .email) } label: { Label("修改邮箱", systemImage: "envelope") }
                NavigationLink { ContactChangeView(kind: .phone) } label: { Label("修改手机号", systemImage: "phone") }
            }

            Section("两步验证 (2FA)") {
                HStack {
                    Label("状态", systemImage: twofaEnabled ? "lock.shield.fill" : "lock.shield")
                        .foregroundColor(twofaEnabled ? .green : .primary)
                    Spacer()
                    Text(twofaEnabled ? "已开启" : "未开启").font(.caption).foregroundColor(.secondary)
                }
                if twofaEnabled {
                    Text("剩余恢复码：\(recoveryLeft)").font(.caption).foregroundColor(.secondary)
                    Button(role: .destructive) { showDisable = true } label: { Text("关闭两步验证") }
                } else {
                    NavigationLink { TwoFASetupView(onDone: { Task { await loadTwofa() } }) } label: {
                        Label("开启两步验证", systemImage: "plus.shield")
                    }
                }
            }

            Section("其它") {
                Button { openAuthedWeb(base: state.baseURL, token: state.token, path: "/dashboard.html") } label: { Label("Passkey / 更多设置（浏览器打开）", systemImage: "key") }
                Text("Passkey 绑定、绑定第三方账号等在浏览器里完成（Passkey 需真 Safari）。").font(.caption2).foregroundColor(.secondary)
            }

            if let err = err { Text(err).foregroundColor(.red).font(.footnote) }
        }
        .navigationTitle("账号设定")
        .task { await loadTwofa() }
        .alert("关闭两步验证", isPresented: $showDisable) {
            TextField("动态验证码", text: $disableCode).keyboardType(.numberPad)
            Button("确认关闭", role: .destructive) { doDisable() }
            Button("取消", role: .cancel) { disableCode = "" }
        } message: { Text("请输入当前 2FA 动态验证码以确认关闭") }
    }

    private func loadTwofa() async {
        if let s = try? await state.api().twofaStatus(token: state.token) {
            await MainActor.run { twofaEnabled = s.enabled; recoveryLeft = s.recoveryLeft }
        }
    }
    private func doDisable() {
        let code = disableCode; disableCode = ""; err = nil
        Task {
            do { try await state.api().twofaDisable(code: code, token: state.token); await loadTwofa() }
            catch { await MainActor.run { err = error.localizedDescription } }
        }
    }
}

/// 修改邮箱 / 手机号（验证新地址所有权）
struct ContactChangeView: View {
    enum Kind { case email, phone
        var t: String { self == .email ? "email" : "phone" }
        var name: String { self == .email ? "邮箱" : "手机号" }
    }
    let kind: Kind
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var value = ""
    @State private var code = ""
    @State private var sent = false
    @State private var busy = false
    @State private var msg: String?

    var body: some View {
        Form {
            Section("新\(kind.name)") {
                TextField("新的\(kind.name)", text: $value)
                    .autocorrectionDisabled(true).textInputAutocapitalization(.never)
                    .keyboardType(kind == .email ? .emailAddress : .phonePad)
                HStack {
                    TextField("验证码", text: $code).keyboardType(.numberPad)
                    Button(sent ? "重发" : "获取验证码") { send() }.disabled(busy || value.isEmpty)
                }
            }
            Section {
                Button("确认修改") { verify() }.disabled(busy || value.isEmpty || code.isEmpty)
            }
            if let msg = msg { Text(msg).font(.footnote).foregroundColor(.secondary) }
        }
        .navigationTitle("修改\(kind.name)")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func send() {
        busy = true; msg = nil
        Task {
            do { try await state.api().contactSendCode(type: kind.t, value: value, token: state.token)
                await MainActor.run { sent = true; busy = false; msg = "验证码已发送到新\(kind.name)" }
            } catch { await MainActor.run { busy = false; msg = error.localizedDescription } }
        }
    }
    private func verify() {
        busy = true; msg = nil
        Task {
            do { try await state.api().contactVerify(type: kind.t, value: value, code: code, token: state.token)
                await MainActor.run { busy = false; dismiss() }
            } catch { await MainActor.run { busy = false; msg = error.localizedDescription } }
        }
    }
}

/// 开启两步验证：出密钥/otpauth → 录入验证器 → 校验一次动态码 → 展示恢复码
struct TwoFASetupView: View {
    var onDone: () -> Void
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var secret = ""
    @State private var otpauth = ""
    @State private var code = ""
    @State private var busy = false
    @State private var recovery: [String] = []
    @State private var err: String?

    var body: some View {
        Form {
            if recovery.isEmpty {
                Section("1. 添加到验证器 App") {
                    if secret.isEmpty {
                        Button("生成密钥") { setup() }.disabled(busy)
                    } else {
                        Text("密钥").font(.caption).foregroundColor(.secondary)
                        Text(secret).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        if let u = URL(string: otpauth) {
                            Link("在验证器中打开", destination: u)
                        }
                        Text("在 Google Authenticator / Authy 等里手动录入密钥，或点上面的链接一键添加。")
                            .font(.caption2).foregroundColor(.secondary)
                    }
                }
                if !secret.isEmpty {
                    Section("2. 输入动态码确认") {
                        TextField("6 位动态验证码", text: $code).keyboardType(.numberPad)
                        Button("开启") { enable() }.disabled(busy || code.count < 6)
                    }
                }
            } else {
                Section("已开启！请保存恢复码（仅显示一次）") {
                    ForEach(recovery, id: \.self) { c in
                        Text(c).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    }
                    Button("完成") { onDone(); dismiss() }
                }
            }
            if let err = err { Text(err).foregroundColor(.red).font(.footnote) }
        }
        .navigationTitle("开启两步验证")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func setup() {
        busy = true; err = nil
        Task {
            do { let s = try await state.api().twofaSetup(token: state.token)
                await MainActor.run { secret = s.secret; otpauth = s.otpauth; busy = false }
            } catch { await MainActor.run { busy = false; err = error.localizedDescription } }
        }
    }
    private func enable() {
        busy = true; err = nil
        Task {
            do { let codes = try await state.api().twofaEnable(secret: secret, code: code, token: state.token)
                await MainActor.run { recovery = codes; busy = false }
            } catch { await MainActor.run { busy = false; err = error.localizedDescription } }
        }
    }
}
