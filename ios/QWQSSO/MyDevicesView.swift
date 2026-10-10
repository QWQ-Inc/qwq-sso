import SwiftUI
import MapKit
import CoreLocation

/// 我的设备（归属到本人的设备，v3.5.92）：只读列表 + 自助锁定/定位；定位结果带坐标时用 Apple 地图显示。
struct MyDevicesView: View {
    @EnvironmentObject var state: AppState
    @State private var devices: [[String: Any]] = []
    @State private var loading = false
    @State private var busyId: String?
    @State private var toast: String?
    @State private var lockSheetId: String?
    @State private var lockMessage = ""

    private let kindLabel: [String: String] = [
        "apple": "🍎 Apple", "google": "🤖 Google/Android", "microsoft": "🪟 Microsoft",
        "access_controller": "🚪 门禁机", "card_reader": "💳 读卡器",
    ]
    private let enrollLabel: [String: String] = [
        "unenrolled": "未纳管", "pending": "待纳管", "enrolled": "已纳管", "retired": "已退役",
    ]
    private let statusLabel: [String: String] = ["active": "正常", "disabled": "已停用", "lost": "已挂失"]

    var body: some View {
        List {
            if devices.isEmpty && !loading {
                Text("名下还没有设备").foregroundColor(.secondary)
            }
            ForEach(devices.indices, id: \.self) { i in
                deviceCard(devices[i])
            }
        }
        .navigationTitle("我的设备")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .overlay(alignment: .bottom) {
            if let t = toast {
                Text(t).font(.caption).padding(8).background(.ultraThinMaterial)
                    .cornerRadius(8).padding(.bottom, 10)
                    .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { toast = nil } }
            }
        }
        .alert("锁屏留言（可空）", isPresented: Binding(get: { lockSheetId != nil }, set: { if !$0 { lockSheetId = nil } })) {
            TextField("显示在锁屏上的留言", text: $lockMessage)
            Button("锁定", role: .destructive) { if let id = lockSheetId { send(id, "lock", message: lockMessage) }; lockMessage = ""; lockSheetId = nil }
            Button("取消", role: .cancel) { lockMessage = ""; lockSheetId = nil }
        }
    }

    @ViewBuilder
    private func deviceCard(_ d: [String: Any]) -> some View {
        let id = (d["id"] as? String) ?? ""
        let name = (d["name"] as? String) ?? "设备"
        let status = (d["status"] as? String) ?? "active"
        let locked = (d["lock_state"] as? String) == "locked"
        let canManage = (d["can_self_manage"] as? Bool) ?? false
        let coord = locateCoord(d)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(name).font(.headline)
                Spacer()
                Text(statusLabel[status] ?? status).font(.caption)
                    .foregroundColor(status == "active" ? .green : .red)
                if locked { Text("🔒").font(.caption) }
            }
            Group {
                Text("类型：\(kindLabel[(d["kind"] as? String) ?? ""] ?? (d["kind"] as? String ?? "—"))　纳管：\(enrollLabel[(d["enroll_status"] as? String) ?? ""] ?? "未纳管")")
                if let m = d["model"] as? String, !m.isEmpty { Text("机型：\(m)") }
                if let s = d["serial"] as? String, !s.isEmpty { Text("序列号：\(s)") }
                if let org = d["subject_name"] as? String, !org.isEmpty { Text("所属组织：\(org)") }
                Text("最近在线：\((d["last_seen"] as? String) ?? "从未")")
            }.font(.caption).foregroundColor(.secondary)

            if let loc = d["last_locate"] as? [String: Any], let r = loc["result"] as? String {
                locateSummary(r, coord: coord, at: loc["at"] as? String)
            }

            if canManage {
                HStack(spacing: 10) {
                    Button { lockSheetId = id } label: { Label("锁定", systemImage: "lock.fill") }
                        .buttonStyle(.bordered).controlSize(.small)
                    Button { send(id, "locate") } label: { Label("定位", systemImage: "location.fill") }
                        .buttonStyle(.bordered).controlSize(.small)
                    if busyId == id { ProgressView().controlSize(.small) }
                }
                .padding(.top, 2)
                Text("丢失时可远程锁定/定位；擦除等需联系管理员").font(.caption2).foregroundColor(.secondary)
            } else if (d["enroll_status"] as? String ?? "unenrolled") == "unenrolled" {
                Text("未纳管，暂不能远程操作").font(.caption2).foregroundColor(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    // 定位结果摘要：有坐标 → 显示地图入口；否则显示主机名/IP 文本
    @ViewBuilder
    private func locateSummary(_ result: String, coord: CLLocationCoordinate2D?, at: String?) -> some View {
        if let c = coord {
            NavigationLink {
                DeviceMapView(coordinate: c, title: cityOf(result), subtitle: at)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "mappin.and.ellipse").foregroundColor(.red)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("📍 最近定位：\(cityOf(result))").font(.caption)
                        if let a = at { Text(a).font(.caption2).foregroundColor(.secondary) }
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption2).foregroundColor(.secondary)
                }
            }.padding(.top, 2)
        } else {
            Text("📍 最近定位：\(hostLine(result))").font(.caption).foregroundColor(.accentColor).padding(.top, 2)
        }
    }

    // ── 解析 locate 结果 JSON ──
    private func locateJSON(_ s: String) -> [String: Any]? {
        guard let data = s.data(using: .utf8),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return j
    }
    private func locateCoord(_ d: [String: Any]) -> CLLocationCoordinate2D? {
        guard let loc = d["last_locate"] as? [String: Any], let r = loc["result"] as? String,
              let j = locateJSON(r),
              let lat = (j["lat"] as? Double) ?? (j["lat"] as? NSNumber)?.doubleValue,
              let lng = (j["lng"] as? Double) ?? (j["lng"] as? NSNumber)?.doubleValue else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
    private func cityOf(_ result: String) -> String {
        if let j = locateJSON(result) {
            let city = (j["city"] as? String) ?? ""
            let region = (j["region"] as? String) ?? ""
            let s = [region, city].filter { !$0.isEmpty }.joined(separator: " · ")
            if !s.isEmpty { return s + "（IP 粗定位）" }
            if let host = j["host"] as? String { return host }
        }
        return "位置"
    }
    private func hostLine(_ result: String) -> String {
        if let j = locateJSON(result) {
            let host = (j["host"] as? String) ?? ""
            let ips = (j["ips"] as? [String])?.joined(separator: "/") ?? ""
            return [host, ips].filter { !$0.isEmpty }.joined(separator: " · ")
        }
        return result
    }

    private func send(_ id: String, _ type: String, message: String? = nil) {
        busyId = id
        Task {
            do {
                let r = try await state.api().deviceSelfCommand(id, type: type, message: message, token: state.token)
                let reason = (r["reason"] as? String) ?? ""
                let msg = type == "locate" ? "已请求定位，设备回报后在此显示" : reasonText(reason)
                await MainActor.run { toast = msg; busyId = nil }
                try? await Task.sleep(nanoseconds: 1_300_000_000)
                await load()
            } catch {
                await MainActor.run { toast = "下发失败"; busyId = nil }
            }
        }
    }
    private func reasonText(_ r: String) -> String {
        switch r {
        case "await_agent": return "已下发，设备上线后执行"
        case "issued", "apns_woke_awaiting_pull": return "已下发到设备"
        case "transport_not_configured": return "已排队（该设备通道待管理员配置）"
        case "unsupported_command": return "该设备不支持此命令"
        default: return "已下发"
        }
    }
    private func load() async {
        guard !state.token.isEmpty else { return }
        loading = true
        if let list = try? await state.api().userDevices(token: state.token) {
            await MainActor.run { devices = list; loading = false }
        } else { await MainActor.run { loading = false } }
    }
}

/// Apple 地图：显示单台设备的（近似）位置。
struct DeviceMapView: View {
    let coordinate: CLLocationCoordinate2D
    let title: String
    let subtitle: String?
    @State private var region: MKCoordinateRegion

    init(coordinate: CLLocationCoordinate2D, title: String, subtitle: String?) {
        self.coordinate = coordinate
        self.title = title
        self.subtitle = subtitle
        _region = State(initialValue: MKCoordinateRegion(center: coordinate, span: MKCoordinateSpan(latitudeDelta: 0.2, longitudeDelta: 0.2)))
    }

    var body: some View {
        VStack(spacing: 0) {
            Map(coordinateRegion: $region, annotationItems: [DevicePin(coordinate: coordinate)]) { pin in
                MapMarker(coordinate: pin.coordinate, tint: .red)
            }
            .ignoresSafeArea(edges: .bottom)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline).bold()
                if let s = subtitle { Text("回报时间：\(s)").font(.caption).foregroundColor(.secondary) }
                Text("注：电脑定位为公网 IP 粗定位（城市级），非精确 GPS。").font(.caption2).foregroundColor(.secondary)
                Button {
                    let item = MKMapItem(placemark: MKPlacemark(coordinate: coordinate))
                    item.name = title
                    item.openInMaps(launchOptions: nil)
                } label: { Label("在地图 App 中打开", systemImage: "arrow.up.right.square") }
                    .font(.caption).padding(.top, 2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .navigationTitle("设备位置")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct DevicePin: Identifiable {
    let id = UUID()
    let coordinate: CLLocationCoordinate2D
}
