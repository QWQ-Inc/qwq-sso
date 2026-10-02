import SwiftUI

/// 首页（原生）：积分 + 签到。
struct HomeTabView: View {
    @EnvironmentObject var state: AppState
    @State private var points = 0
    @State private var streak = 0
    @State private var checkedInToday = false
    @State private var loading = false
    @State private var msg: String?
    @State private var pending: [[String: Any]] = []
    @State private var openAnn: AnnouncementRef?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    // 门禁：一键出示开门码
                    NavigationLink { AccessView() } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "qrcode").font(.title2)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("门禁 · 出示开门码").font(.subheadline).bold()
                                Text("对准门口扫码机即可开门").font(.caption).opacity(0.9)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").font(.caption)
                        }
                        .padding(14)
                        .frame(maxWidth: .infinity)
                        .background(Color.accentColor).foregroundColor(.white).cornerRadius(12)
                    }

                    // 积分卡
                    VStack(spacing: 6) {
                        Text("我的积分").font(.footnote).foregroundColor(.secondary)
                        Text("\(points)").font(.system(size: 44, weight: .bold))
                        if streak > 0 {
                            Text("已连续签到 \(streak) 天").font(.caption).foregroundColor(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 24)
                    .background(Color(.secondarySystemBackground)).cornerRadius(14)

                    Button(action: doCheckin) {
                        HStack {
                            if loading { ProgressView().tint(.white) }
                            Text(checkedInToday ? "今日已签到" : "签到领积分")
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(checkedInToday ? Color.gray : Color.accentColor)
                        .foregroundColor(.white).cornerRadius(10)
                    }
                    .disabled(loading || checkedInToday)

                    if let msg = msg {
                        Text(msg).font(.footnote).foregroundColor(.secondary)
                    }

                    if !pending.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("公告").font(.footnote).foregroundColor(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            ForEach(pending.indices, id: \.self) { i in
                                let a = pending[i]
                                Button { openAnn = AnnouncementDetailView.from(a) } label: {
                                    HStack {
                                        Image(systemName: level(a) == "urgent" ? "exclamationmark.triangle.fill" : "megaphone")
                                            .foregroundColor(level(a) == "urgent" ? .red : (level(a) == "warn" ? .orange : .accentColor))
                                        Text((a["title"] as? String) ?? "公告").foregroundColor(.primary).lineLimit(1)
                                        Spacer()
                                        Image(systemName: "chevron.right").font(.caption).foregroundColor(.secondary)
                                    }
                                    .padding(12)
                                    .background(Color(.secondarySystemBackground)).cornerRadius(10)
                                }
                            }
                        }
                    }
                }
                .padding(20)
            }
            .navigationTitle("首页")
            .refreshable { await load() }
            .task { await load() }
            .sheet(item: $openAnn) { a in
                AnnouncementDetailView(ann: a, onRead: { Task { await loadAnnouncements() } })
            }
        }
    }

    private func level(_ a: [String: Any]) -> String { (a["level"] as? String) ?? "info" }

    private func doCheckin() {
        loading = true; msg = nil
        Task {
            do {
                let r = try await state.api().checkin(token: state.token)
                await MainActor.run {
                    points = r.total; streak = r.streak; checkedInToday = true
                    msg = "签到成功，+\(r.points) 积分"; loading = false
                }
            } catch {
                await MainActor.run {
                    loading = false
                    msg = error.localizedDescription
                    if error.localizedDescription.contains("已签到") { checkedInToday = true }
                }
            }
        }
    }

    private func load() async {
        guard !state.token.isEmpty else { return }
        do {
            let u = try await state.api().meUser(token: state.token)
            await MainActor.run {
                points = (u["points"] as? Int) ?? 0
                streak = (u["checkin_streak"] as? Int) ?? 0
                checkedInToday = HomeTabView.isSameDay(u["last_checkin"] as? String)
            }
        } catch {}
        await loadAnnouncements()
    }

    private func loadAnnouncements() async {
        let list = (try? await state.api().announcementsPending(token: state.token)) ?? []
        await MainActor.run { pending = list }
    }

    /// last_checkin（ISO）是否是今天（本地日期）
    static func isSameDay(_ iso: String?) -> Bool {
        guard let iso = iso, !iso.isEmpty else { return false }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let d = f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date = d else { return false }
        return Calendar.current.isDateInToday(date)
    }
}
