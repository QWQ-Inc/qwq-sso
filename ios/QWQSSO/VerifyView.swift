import SwiftUI
import UIKit

/// 身份核验（核验员，v3.5.32；对齐网页 v3.5.12）：扫对方的门禁动态码（qr1），看脱敏身份卡。
/// 只读：服务端用 consume:false 校验，不影响对方再拿这个码开门。
struct IdentityVerifyView: View {
    @EnvironmentObject var state: AppState
    @State private var scanning = false
    @State private var pasted = ""
    @State private var busy = false
    @State private var card: [String: Any]?
    @State private var err: String?

    var body: some View {
        List {
            Section {
                Button { scanning = true } label: { Label("扫码核验", systemImage: "qrcode.viewfinder") }
                HStack {
                    TextField("或粘贴 qr1 码", text: $pasted)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .font(.system(.footnote, design: .monospaced))
                    Button("核验") { check(pasted) }.disabled(pasted.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            } footer: {
                Text("请对方在 App「门禁」或网页出示开门码，你扫码即可看到脱敏身份信息；不会消耗对方的码。")
            }

            if busy { Section { HStack { Spacer(); ProgressView(); Spacer() } } }

            if let e = err {
                Section { Label(e, systemImage: "xmark.octagon.fill").foregroundColor(.red) }
            }

            if let c = card {
                Section("核验结果") {
                    HStack(spacing: 14) {
                        Image(systemName: "checkmark.seal.fill").font(.largeTitle).foregroundColor(.green)
                        VStack(alignment: .leading, spacing: 4) {
                            Text((c["name_masked"] as? String) ?? "?").font(.title2).bold()
                            Text((c["uid"] as? String) ?? "").font(.caption).foregroundColor(.secondary)
                        }
                    }.padding(.vertical, 4)
                    if let s = c["subject"] as? String, !s.isEmpty { row("所在组织", s) }
                    if let g = c["group"] as? String, !g.isEmpty { row("分组", g) }
                    let fields = (c["fields"] as? [[String: Any]]) ?? []
                    ForEach(fields.indices, id: \.self) { i in
                        row((fields[i]["label"] as? String) ?? "", (fields[i]["value"] as? String) ?? "")
                    }
                }
            }
        }
        .navigationTitle("身份核验")
        .sheet(isPresented: $scanning) {
            ScannerView { value in check(value) }
        }
    }

    @ViewBuilder private func row(_ k: String, _ v: String) -> some View {
        HStack { Text(k).foregroundColor(.secondary); Spacer(); Text(v).multilineTextAlignment(.trailing) }
    }

    private func check(_ raw: String) {
        let code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else { return }
        busy = true; err = nil; card = nil
        Task {
            do {
                let j = try await state.api().request("POST", "/api/verify/scan", body: ["code": code], token: state.token)
                await MainActor.run {
                    busy = false
                    if (j["ok"] as? Bool) == true, let c = j["card"] as? [String: Any] {
                        card = c
                        UINotificationFeedbackGenerator().notificationOccurred(.success)
                    } else {
                        err = (j["reason_text"] as? String) ?? (j["error"] as? String) ?? "核验未通过"
                        UINotificationFeedbackGenerator().notificationOccurred(.error)
                    }
                }
            } catch {
                await MainActor.run { busy = false; err = error.localizedDescription }
            }
        }
    }
}
