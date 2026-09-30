import SwiftUI

/// 首屏：填写「所属网域」。填对了才拉取该域的登录主体/方式，进入登录页。
struct DomainEntryView: View {
    @EnvironmentObject var state: AppState
    @State private var input: String = ""
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 22) {
            Spacer()
            VStack(spacing: 8) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 52))
                    .foregroundColor(.accentColor)
                Text("QWQ 统一账号")
                    .font(.title2).bold()
                Text("请输入你所属的网域，加载对应的登录方式")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("所属网域").font(.caption).foregroundColor(.secondary)
                TextField("如 qwqsso.zeabur.app", text: $input)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .keyboardType(.URL)
                    .padding(12)
                    .background(Color(.secondarySystemBackground))
                    .cornerRadius(10)
            }

            if let error = error {
                Text(error).font(.footnote).foregroundColor(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button(action: submit) {
                HStack {
                    if loading { ProgressView().tint(.white) }
                    Text(loading ? "连接中…" : "继续")
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(input.trimmingCharacters(in: .whitespaces).isEmpty ? Color.gray : Color.accentColor)
                .foregroundColor(.white)
                .cornerRadius(10)
            }
            .disabled(loading || input.trimmingCharacters(in: .whitespaces).isEmpty)

            Spacer()
            Text("Powered by QWQ SSO")
                .font(.caption2).foregroundColor(.secondary)
        }
        .padding(24)
    }

    private func submit() {
        error = nil
        loading = true
        let base = AppState.normalizeBase(input)
        Task {
            do {
                let methods = try await APIClient(base: base).loginMethods()
                await MainActor.run {
                    state.domain = input.trimmingCharacters(in: .whitespacesAndNewlines)
                    state.methods = methods
                    loading = false
                }
            } catch {
                await MainActor.run {
                    self.error = "无法连接该网域：\(error.localizedDescription)"
                    loading = false
                }
            }
        }
    }
}
