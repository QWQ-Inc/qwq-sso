import SwiftUI

struct LoginView: View {
    @EnvironmentObject var state: AppState

    enum Mode: String, CaseIterable { case password = "密码", code = "验证码" }
    @State private var mode: Mode = .password
    @State private var account = ""
    @State private var password = ""
    @State private var email = ""
    @State private var emailCode = ""
    @State private var codeSent = false
    @State private var loading = false
    @State private var error: String?

    // 二段验证
    @State private var twofaToken: String?
    @State private var twofaCode = ""

    // 网页兜底 / 第三方
    @State private var webPath: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    Text(state.domain).font(.footnote).foregroundColor(.secondary)

                    Picker("", selection: $mode) {
                        ForEach(Mode.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)

                    if mode == .password { passwordForm } else { codeForm }

                    if let error = error {
                        Text(error).font(.footnote).foregroundColor(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    if !state.methods.isEmpty {
                        Divider().padding(.vertical, 4)
                        Text("第三方登录").font(.caption).foregroundColor(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        ForEach(state.methods) { m in
                            Button { webPath = m.authPath } label: {
                                Text(m.displayName).frame(maxWidth: .infinity).padding(.vertical, 11)
                                    .background(Color(.secondarySystemBackground)).cornerRadius(10)
                            }
                        }
                    }

                    HStack {
                        NavigationLink { ScannerView(onResult: handleScan) } label: {
                            Label("扫码登录", systemImage: "qrcode.viewfinder")
                        }
                        Spacer()
                        Button("网页登录") { webPath = "/login.html" }
                    }
                    .font(.footnote)
                    .padding(.top, 4)
                }
                .padding(24)
            }
            .navigationTitle("登录")
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
            .sheet(isPresented: Binding(get: { twofaToken != nil }, set: { if !$0 { twofaToken = nil } })) {
                twofaSheet
            }
        }
    }

    private var passwordForm: some View {
        VStack(spacing: 12) {
            field("账号（邮箱/手机/UID/用户名）", text: $account, secure: false, keyboard: .default)
            field("密码", text: $password, secure: true, keyboard: .default)
            primaryButton(title: "登录", action: doPasswordLogin)
        }
    }

    private var codeForm: some View {
        VStack(spacing: 12) {
            field("邮箱", text: $email, secure: false, keyboard: .emailAddress)
            HStack {
                field("验证码", text: $emailCode, secure: false, keyboard: .numberPad)
                Button(codeSent ? "已发送" : "获取验证码", action: doSendCode)
                    .disabled(loading || email.isEmpty)
                    .padding(.horizontal, 10)
            }
            primaryButton(title: "登录 / 注册", action: doCodeLogin)
        }
    }

    private var twofaSheet: some View {
        VStack(spacing: 16) {
            Text("二段验证").font(.headline)
            Text("请输入动态验证码或恢复码").font(.footnote).foregroundColor(.secondary)
            TextField("动态码 / 恢复码", text: $twofaCode)
                .keyboardType(.numberPad)
                .padding(12).background(Color(.secondarySystemBackground)).cornerRadius(10)
            primaryButton(title: "验证", action: doTwofa)
            Button("取消") { twofaToken = nil }
        }
        .padding(24)
        .presentationDetents([.medium])
    }

    // ── 表单元件 ──
    private func field(_ placeholder: String, text: Binding<String>, secure: Bool, keyboard: UIKeyboardType) -> some View {
        Group {
            if secure { SecureField(placeholder, text: text) }
            else {
                TextField(placeholder, text: text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .keyboardType(keyboard)
            }
        }
        .padding(12).background(Color(.secondarySystemBackground)).cornerRadius(10)
    }

    private func primaryButton(title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                if loading { ProgressView().tint(.white) }
                Text(title)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 12)
            .background(Color.accentColor).foregroundColor(.white).cornerRadius(10)
        }
        .disabled(loading)
    }

    // ── 动作 ──
    private func doPasswordLogin() {
        error = nil; loading = true
        Task {
            do {
                let r = try await state.api().passwordLogin(account: account, password: password)
                await finish(token: r.token, twofa: r.twofa)
            } catch { await fail(error) }
        }
    }

    private func doSendCode() {
        error = nil; loading = true
        Task {
            do {
                try await state.api().sendEmailCode(email: email)
                await MainActor.run { codeSent = true; loading = false }
            } catch { await fail(error) }
        }
    }

    private func doCodeLogin() {
        error = nil; loading = true
        Task {
            do {
                let r = try await state.api().emailCodeLogin(email: email, code: emailCode)
                await finish(token: r.token, twofa: r.twofa)
            } catch { await fail(error) }
        }
    }

    private func doTwofa() {
        guard let tk = twofaToken else { return }
        error = nil; loading = true
        Task {
            do {
                let token = try await state.api().twofaLogin(twofaToken: tk, code: twofaCode)
                await MainActor.run { twofaToken = nil }
                await finish(token: token, twofa: nil)
            } catch { await fail(error) }
        }
    }

    private func handleScan(_ value: String) {
        if let url = URL(string: value), url.scheme == "qwqsso" {
            state.handleDeepLink(url)
        } else if value.hasPrefix("http") {
            webPath = "/login.html"   // 扫到网页登录二维码：交给网页兜底
        }
    }

    @MainActor private func finish(token: String?, twofa: String?) async {
        loading = false
        if let twofa = twofa { twofaToken = twofa; return }
        guard let token = token, !token.isEmpty else { error = "登录失败"; return }
        state.token = token
    }

    @MainActor private func fail(_ e: Error) {
        loading = false
        error = e.localizedDescription
    }
}

/// sheet(item:) 需要 Identifiable 包装
struct WebTarget: Identifiable {
    let path: String
    var id: String { path }
}
