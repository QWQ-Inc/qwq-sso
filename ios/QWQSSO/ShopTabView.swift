import SwiftUI

/// 积分商城（原生）：在售商品 + 兑换 + 我的兑换券。
struct ShopTabView: View {
    @EnvironmentObject var state: AppState
    @State private var goods: [[String: Any]] = []
    @State private var coupons: [[String: Any]] = []
    @State private var loading = false
    @State private var alertMsg: String?
    @State private var exchangingId: String?
    @State private var reveal: BlindReward?

    var body: some View {
        NavigationStack {
            List {
                Section("在售商品") {
                    if goods.isEmpty { Text("暂无在售商品").foregroundColor(.secondary) }
                    ForEach(goods.indices, id: \.self) { i in
                        let g = goods[i]
                        let id = (g["id"] as? String) ?? ""
                        let name = (g["name"] as? String) ?? "商品"
                        let cost = (g["cost"] as? Int) ?? 0
                        let desc = (g["description"] as? String) ?? ""
                        let stock = (g["stock"] as? Int) ?? -1
                        let isBlind = ((g["is_blind_box"] as? Int) ?? 0) == 1 || (g["is_blind_box"] as? Bool) == true
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text((isBlind ? "🎁 " : "") + name).font(.subheadline).bold()
                                if !desc.isEmpty { Text(desc).font(.caption).foregroundColor(.secondary) }
                                Text("\(cost) 积分" + (stock >= 0 ? " · 库存 \(stock)" : "")).font(.caption2).foregroundColor(.secondary)
                            }
                            Spacer()
                            Button {
                                doExchange(id: id, name: name, isBlind: isBlind)
                            } label: {
                                if exchangingId == id { ProgressView() } else { Text("兑换") }
                            }
                            .buttonStyle(.borderedProminent).controlSize(.small)
                            .disabled(exchangingId != nil)
                        }
                    }
                }

                Section("我的兑换券") {
                    if coupons.isEmpty { Text("还没有兑换券").foregroundColor(.secondary) }
                    ForEach(coupons.indices, id: \.self) { i in
                        let c = coupons[i]
                        VStack(alignment: .leading, spacing: 3) {
                            Text((c["goods_name"] as? String) ?? (c["name"] as? String) ?? "兑换券").font(.subheadline)
                            Text((c["code"] as? String) ?? "").font(.caption).foregroundColor(.secondary).textSelection(.enabled)
                            if let st = c["status"] as? String { Text(couponStatus(st)).font(.caption2).foregroundColor(.secondary) }
                        }
                    }
                }
            }
            .navigationTitle("积分商城")
            .refreshable { await load() }
            .task { await load() }
            .alert("兑换结果", isPresented: Binding(get: { alertMsg != nil }, set: { if !$0 { alertMsg = nil } })) {
                Button("好") { alertMsg = nil }
            } message: { Text(alertMsg ?? "") }
            .sheet(item: $reveal) { r in BlindBoxRevealView(reward: r) }
        }
    }

    private func couponStatus(_ s: String) -> String {
        switch s { case "unused": return "未使用"; case "used": return "已使用"; case "pending": return "待开启"; default: return s }
    }

    private func doExchange(id: String, name: String, isBlind: Bool) {
        guard !id.isEmpty else { return }
        exchangingId = id
        Task {
            do {
                let r = try await state.api().exchange(goodsId: id, token: state.token)
                await MainActor.run {
                    exchangingId = nil
                    if isBlind || (r["type"] as? String) == "blind_box" {
                        reveal = ShopTabView.blindReward(from: r)
                    } else {
                        let remain = (r["remain"] as? Int).map { "，剩余 \($0) 积分" } ?? ""
                        alertMsg = "「\(name)」兑换成功\(remain)"
                    }
                }
                await load()
            } catch {
                await MainActor.run { exchangingId = nil; alertMsg = error.localizedDescription }
            }
        }
    }

    /// 从兑换返回里解析盲盒奖励文案
    static func blindReward(from r: [String: Any]) -> BlindReward {
        let opened = (r["opened"] as? Bool) ?? true
        if !opened {
            return BlindReward(title: "获得待开启盲盒券", detail: "去「我的兑换券」里开启查看奖励")
        }
        let rw = (r["reward"] as? [String: Any]) ?? [:]
        let label = (rw["label"] as? String) ?? (rw["name"] as? String) ?? "神秘奖励"
        let type = (rw["type"] as? String) ?? ""
        var detail = ""
        if type == "points", let amt = rw["amount"] as? Int { detail = "+\(amt) 积分" }
        else if type == "nothing" { detail = "谢谢参与" }
        else if type == "deduct_points", let amt = rw["amount"] as? Int { detail = "-\(amt) 积分" }
        return BlindReward(title: label, detail: detail)
    }

    private func load() async {
        guard !state.token.isEmpty else { return }
        async let g = try? state.api().shopGoods(token: state.token)
        async let c = try? state.api().coupons(token: state.token)
        let (gg, cc) = await (g, c)
        await MainActor.run {
            goods = gg ?? []
            coupons = cc ?? []
        }
    }
}
