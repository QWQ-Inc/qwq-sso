import SwiftUI
import UIKit

/// 积分商城（原生）：在售商品 + 兑换 + 我的兑换券（使用/转让/丢弃）+ 积分转账/兑换记录/积分明细。
struct ShopTabView: View {
    @EnvironmentObject var state: AppState
    @State private var goods: [[String: Any]] = []
    @State private var coupons: [[String: Any]] = []
    @State private var loading = false
    @State private var alertMsg: String?
    @State private var exchangingId: String?
    @State private var reveal: BlindReward?
    @State private var transferCoupon: CouponRef?

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
                    ForEach(coupons.indices, id: \.self) { i in couponRow(coupons[i]) }
                }

                Section("更多") {
                    NavigationLink { PointsTransferView() } label: { Label("积分转账", systemImage: "arrow.left.arrow.right") }
                    NavigationLink { ShopRecordsView() } label: { Label("兑换记录", systemImage: "clock.arrow.circlepath") }
                    NavigationLink { PointsLogView() } label: { Label("积分明细", systemImage: "list.number") }
                }
            }
            .navigationTitle("积分商城")
            .refreshable { await load() }
            .task { await load() }
            .alert("兑换结果", isPresented: Binding(get: { alertMsg != nil }, set: { if !$0 { alertMsg = nil } })) {
                Button("好") { alertMsg = nil }
            } message: { Text(alertMsg ?? "") }
            .sheet(item: $reveal) { r in BlindBoxRevealView(reward: r) }
            .sheet(item: $transferCoupon, onDismiss: { Task { await load() } }) { c in
                CouponTransferView(code: c.code)
            }
        }
    }

    @ViewBuilder
    private func couponRow(_ c: [String: Any]) -> some View {
        let code = (c["coupon_code"] as? String) ?? (c["code"] as? String) ?? ""
        let status = (c["status"] as? String) ?? ""
        let unused = status == "unused"
        VStack(alignment: .leading, spacing: 3) {
            Text((c["goods_name"] as? String) ?? (c["name"] as? String) ?? "兑换券").font(.subheadline)
            Text(code).font(.caption).foregroundColor(.secondary).textSelection(.enabled)
            Text(couponStatus(status)).font(.caption2).foregroundColor(.secondary)
        }
        .contextMenu {
            if unused && ((c["allow_instant"] as? Int) == 1 || (c["allow_instant"] as? Bool) == true) {
                Button { useCoupon(code) } label: { Label("使用", systemImage: "checkmark.circle") }
            }
            if unused && ((c["allow_transfer"] as? Int) == 1 || (c["allow_transfer"] as? Bool) == true) {
                Button { transferCoupon = CouponRef(code: code) } label: { Label("转让", systemImage: "paperplane") }
            }
            if unused && ((c["allow_discard"] as? Int) == 1 || (c["allow_discard"] as? Bool) == true) {
                Button(role: .destructive) { discardCoupon(code) } label: { Label("丢弃", systemImage: "trash") }
            }
        }
    }

    private func useCoupon(_ code: String) {
        Task {
            do {
                let r = try await state.api().couponUse(code: code, token: state.token)
                await MainActor.run { alertMsg = (r["message"] as? String) ?? "已核销" }
                if let u = r["redirect_url"] as? String, let url = URL(string: u) {
                    await MainActor.run { UIApplication.shared.open(url) }
                }
                await load()
            } catch { await MainActor.run { alertMsg = error.localizedDescription } }
        }
    }
    private func discardCoupon(_ code: String) {
        Task {
            do { try await state.api().couponDiscard(code: code, token: state.token); await load() }
            catch { await MainActor.run { alertMsg = error.localizedDescription } }
        }
    }

    private func couponStatus(_ s: String) -> String {
        switch s {
        case "unused": return "未使用"; case "used": return "已使用"; case "pending": return "待开启"
        case "transferred": return "已转送"; case "discarded": return "已丢弃"; default: return s
        }
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
