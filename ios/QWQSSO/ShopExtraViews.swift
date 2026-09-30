import SwiftUI

struct CouponRef: Identifiable { let code: String; var id: String { code } }

/// 积分转账：收款 UID + 用户名 + 积分 + 登录密码确认。
struct PointsTransferView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var toUid = ""
    @State private var toName = ""
    @State private var amount = ""
    @State private var password = ""
    @State private var busy = false
    @State private var msg: String?

    var body: some View {
        Form {
            Section("收款方") {
                TextField("对方 UID（如 00042）", text: $toUid).keyboardType(.numbersAndPunctuation)
                TextField("对方 用户名", text: $toName)
            }
            Section("金额与确认") {
                TextField("转账积分", text: $amount).keyboardType(.numberPad)
                SecureField("登录密码", text: $password)
            }
            Section {
                Button(busy ? "提交中…" : "确认转账") { submit() }
                    .disabled(busy || toUid.isEmpty || toName.isEmpty || amount.isEmpty || password.isEmpty)
            }
            if let msg = msg { Text(msg).font(.footnote).foregroundColor(.secondary) }
        }
        .navigationTitle("积分转账").navigationBarTitleDisplayMode(.inline)
    }

    private func submit() {
        guard let amt = Int(amount), amt > 0 else { msg = "积分需为正整数"; return }
        busy = true; msg = nil
        Task {
            do {
                let r = try await state.api().pointsTransfer(toUid: toUid.trimmingCharacters(in: .whitespaces), toName: toName.trimmingCharacters(in: .whitespaces), amount: amt, password: password, token: state.token)
                let remain = (r["remain"] as? Int).map { "，剩余 \($0)" } ?? ""
                await MainActor.run { busy = false; msg = "转账成功\(remain)"; toUid = ""; toName = ""; amount = ""; password = "" }
            } catch { await MainActor.run { busy = false; msg = error.localizedDescription } }
        }
    }
}

/// 转让兑换券：收件 UID + 用户名 + 密码。
struct CouponTransferView: View {
    let code: String
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var toUid = ""
    @State private var toName = ""
    @State private var password = ""
    @State private var busy = false
    @State private var msg: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("收件人") {
                    TextField("对方 UID", text: $toUid).keyboardType(.numbersAndPunctuation)
                    TextField("对方 用户名", text: $toName)
                }
                Section("确认") { SecureField("登录密码", text: $password) }
                Section {
                    Button(busy ? "提交中…" : "确认转让") { submit() }
                        .disabled(busy || toUid.isEmpty || toName.isEmpty || password.isEmpty)
                }
                if let msg = msg { Text(msg).font(.footnote).foregroundColor(.red) }
            }
            .navigationTitle("转让兑换券").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button("取消") { dismiss() } } }
        }
    }

    private func submit() {
        busy = true; msg = nil
        Task {
            do {
                try await state.api().couponTransfer(code: code, toUid: toUid.trimmingCharacters(in: .whitespaces), toName: toName.trimmingCharacters(in: .whitespaces), password: password, token: state.token)
                await MainActor.run { busy = false; dismiss() }
            } catch { await MainActor.run { busy = false; msg = error.localizedDescription } }
        }
    }
}

/// 兑换记录
struct ShopRecordsView: View {
    @EnvironmentObject var state: AppState
    @State private var records: [[String: Any]] = []
    var body: some View {
        List {
            if records.isEmpty { Text("暂无兑换记录").foregroundColor(.secondary) }
            ForEach(records.indices, id: \.self) { i in
                let r = records[i]
                VStack(alignment: .leading, spacing: 3) {
                    Text((r["goods_name"] as? String) ?? "商品").font(.subheadline)
                    HStack {
                        if let c = r["cost"] as? Int { Text("-\(c) 积分").font(.caption).foregroundColor(.secondary) }
                        Spacer()
                        Text(fmt(r["created_at"] as? String)).font(.caption2).foregroundColor(.secondary)
                    }
                }
            }
        }
        .navigationTitle("兑换记录").navigationBarTitleDisplayMode(.inline)
        .task { records = (try? await state.api().shopRecords(token: state.token)) ?? [] }
    }
    private func fmt(_ s: String?) -> String { (s ?? "").replacingOccurrences(of: "T", with: " ").replacingOccurrences(of: "Z", with: "") }
}

/// 积分明细
struct PointsLogView: View {
    @EnvironmentObject var state: AppState
    @State private var logs: [[String: Any]] = []
    var body: some View {
        List {
            if logs.isEmpty { Text("暂无积分记录").foregroundColor(.secondary) }
            ForEach(logs.indices, id: \.self) { i in
                let l = logs[i]
                let delta = (l["delta"] as? Int) ?? (l["change"] as? Int) ?? 0
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text((l["reason"] as? String) ?? (l["note"] as? String) ?? "积分变动").font(.subheadline)
                        Text(fmt(l["created_at"] as? String)).font(.caption2).foregroundColor(.secondary)
                    }
                    Spacer()
                    Text(delta >= 0 ? "+\(delta)" : "\(delta)")
                        .font(.subheadline).bold()
                        .foregroundColor(delta >= 0 ? .green : .red)
                }
            }
        }
        .navigationTitle("积分明细").navigationBarTitleDisplayMode(.inline)
        .task { logs = (try? await state.api().pointsLog(token: state.token)) ?? [] }
    }
    private func fmt(_ s: String?) -> String { (s ?? "").replacingOccurrences(of: "T", with: " ").replacingOccurrences(of: "Z", with: "") }
}
