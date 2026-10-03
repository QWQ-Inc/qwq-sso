import SwiftUI
import UIKit

// 应用中心里的「管理工具」（v3.5.30）：用户管理 / 设备管理 / 门禁（门、通行记录、访客码）。
// 跟网页管理端是同一套接口，只是入口不同；能不能操作仍以后端各接口的权限校验为准。

// MARK: - 小工具

private func str(_ d: [String: Any], _ k: String) -> String {
    if let s = d[k] as? String { return s }
    if let n = d[k] as? Int { return String(n) }
    return ""
}
private func uidText(_ u: [String: Any]) -> String {
    let code = str(u, "uid_code")
    if !code.isEmpty { return code }
    let seq = (u["uid_seq"] as? Int) ?? 0
    return "#" + String(format: "%05d", seq)
}

/// 应用中心磁贴（SF Symbol + 底色）
struct ToolTile: View {
    let title: String
    let symbol: String
    let color: Color
    var body: some View {
        VStack(spacing: 6) {
            ZStack {
                RoundedRectangle(cornerRadius: 13, style: .continuous).fill(color)
                Image(systemName: symbol).font(.system(size: 24, weight: .semibold)).foregroundColor(.white)
            }
            .frame(width: 56, height: 56)
            Text(title).font(.caption2).lineLimit(1).foregroundColor(.primary)
        }
    }
}

// MARK: - 用户管理

struct AdminUsersView: View {
    @EnvironmentObject var state: AppState
    let canWrite: Bool
    @State private var list: [[String: Any]] = []
    @State private var q = ""
    @State private var loading = false
    @State private var msg: String?

    var body: some View {
        List {
            if list.isEmpty && !loading { Text("没有找到用户").foregroundColor(.secondary) }
            ForEach(list.indices, id: \.self) { i in
                let u = list[i]
                let active = str(u, "status") != "disabled"
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(str(u, "name")).font(.subheadline).bold()
                        Text(uidText(u)).font(.caption).foregroundColor(.secondary)
                        if str(u, "role") == "admin" { Text("管理员").font(.caption2).foregroundColor(.orange) }
                        Spacer()
                        Text(active ? "正常" : "已停用").font(.caption).foregroundColor(active ? .green : .red)
                    }
                    let contact = [str(u, "email"), str(u, "phone")].filter { !$0.isEmpty }.joined(separator: " · ")
                    if !contact.isEmpty { Text(contact).font(.caption).foregroundColor(.secondary) }
                }
                .swipeActions(edge: .trailing) {
                    if canWrite {
                        if active {
                            Button(role: .destructive) { setStatus(str(u, "id"), enable: false) } label: { Text("停用") }
                        } else {
                            Button { setStatus(str(u, "id"), enable: true) } label: { Text("启用") }.tint(.green)
                        }
                    }
                }
            }
        }
        .navigationTitle("用户管理")
        .searchable(text: $q, prompt: "UID / 姓名 / 邮箱 / 手机")
        .onSubmit(of: .search) { Task { await load() } }
        .refreshable { await load() }
        .task { await load() }
        .alert("提示", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) {
            Button("好") { msg = nil }
        } message: { Text(msg ?? "") }
    }

    private func load() async {
        await MainActor.run { loading = true }
        let query = q.trimmingCharacters(in: .whitespaces)
        let path = "/api/admin/users" + (query.isEmpty ? "" : "?q=" + (query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""))
        do {
            let j = try await state.api().request("GET", path, token: state.token)
            await MainActor.run { list = (j["users"] as? [[String: Any]]) ?? []; loading = false }
        } catch {
            await MainActor.run { loading = false; msg = error.localizedDescription }
        }
    }
    private func setStatus(_ id: String, enable: Bool) {
        Task {
            do { _ = try await state.api().request("POST", "/api/admin/users/\(id)/\(enable ? "enable" : "disable")", body: [:], token: state.token); await load() }
            catch { await MainActor.run { msg = error.localizedDescription } }
        }
    }
}

// MARK: - 设备管理

private let deviceKinds: [(String, String)] = [("apple", "Apple 设备"), ("google", "Google 设备"), ("microsoft", "Microsoft 设备"), ("access_controller", "门禁机"), ("card_reader", "读卡器")]
private let deviceStatus: [(String, String)] = [("active", "正常"), ("disabled", "停用"), ("lost", "丢失")]
private func kindLabel(_ k: String) -> String { deviceKinds.first { $0.0 == k }?.1 ?? k }
private func statusLabel(_ k: String) -> String { deviceStatus.first { $0.0 == k }?.1 ?? k }

struct DevicesManageView: View {
    @EnvironmentObject var state: AppState
    @State private var devices: [[String: Any]] = []
    @State private var orgs: [[String: Any]] = []
    @State private var canAll = false
    @State private var kind = ""
    @State private var q = ""
    @State private var editing: [String: Any]?
    @State private var creating = false
    @State private var msg: String?

    private var filtered: [[String: Any]] {
        let s = q.trimmingCharacters(in: .whitespaces).lowercased()
        return devices.filter { d in
            (kind.isEmpty || str(d, "kind") == kind) &&
            (s.isEmpty || str(d, "name").lowercased().contains(s) || str(d, "serial").lowercased().contains(s))
        }
    }

    var body: some View {
        List {
            Section {
                Picker("类型", selection: $kind) {
                    Text("全部类型").tag("")
                    ForEach(deviceKinds.indices, id: \.self) { i in Text(deviceKinds[i].1).tag(deviceKinds[i].0) }
                }
            }
            if filtered.isEmpty { Text("没有设备").foregroundColor(.secondary) }
            ForEach(filtered.indices, id: \.self) { i in
                let d = filtered[i]
                Button { editing = d } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(str(d, "name").isEmpty ? "(未命名)" : str(d, "name")).font(.subheadline).bold().foregroundColor(.primary)
                            Text(kindLabel(str(d, "kind"))).font(.caption2).foregroundColor(.secondary)
                            Spacer()
                            let st = str(d, "status")
                            Text(statusLabel(st)).font(.caption).foregroundColor(st == "active" ? .green : (st == "lost" ? .red : .secondary))
                        }
                        let meta = [str(d, "serial").isEmpty ? "" : "SN " + str(d, "serial"), str(d, "subject_name"), str(d, "door_name").isEmpty ? "" : "门 " + str(d, "door_name")].filter { !$0.isEmpty }.joined(separator: " · ")
                        if !meta.isEmpty { Text(meta).font(.caption).foregroundColor(.secondary) }
                        if !str(d, "last_seen").isEmpty { Text("心跳 " + str(d, "last_seen")).font(.caption2).foregroundColor(.secondary) }
                    }
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) { remove(str(d, "id")) } label: { Text("删除") }
                }
            }
        }
        .navigationTitle("设备管理")
        .searchable(text: $q, prompt: "名称 / 序列号")
        .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button { creating = true } label: { Image(systemName: "plus") } } }
        .refreshable { await load() }
        .task { await load() }
        .sheet(isPresented: Binding(get: { editing != nil || creating }, set: { if !$0 { editing = nil; creating = false } })) {
            DeviceEditView(device: editing, orgs: orgs, allowNoOrg: canAll) { body, id in
                save(body, id: id)
            }
        }
        .alert("提示", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) {
            Button("好") { msg = nil }
        } message: { Text(msg ?? "") }
    }

    private func load() async {
        do {
            let j = try await state.api().request("GET", "/api/admin/devices", token: state.token)
            await MainActor.run {
                devices = (j["devices"] as? [[String: Any]]) ?? []
                orgs = (j["orgs"] as? [[String: Any]]) ?? []
                canAll = (j["can_all"] as? Bool) ?? false
            }
        } catch { await MainActor.run { msg = error.localizedDescription } }
    }
    private func save(_ body: [String: Any], id: String?) {
        Task {
            do {
                if let id = id { _ = try await state.api().request("PATCH", "/api/admin/devices/\(id)", body: body, token: state.token) }
                else { _ = try await state.api().request("POST", "/api/admin/devices", body: body, token: state.token) }
                await MainActor.run { editing = nil; creating = false }
                await load()
            } catch { await MainActor.run { msg = error.localizedDescription } }
        }
    }
    private func remove(_ id: String) {
        Task {
            do { _ = try await state.api().request("DELETE", "/api/admin/devices/\(id)", token: state.token); await load() }
            catch { await MainActor.run { msg = error.localizedDescription } }
        }
    }
}

private struct DeviceEditView: View {
    let device: [String: Any]?
    let orgs: [[String: Any]]
    let allowNoOrg: Bool
    let onSave: ([String: Any], String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var kind = "apple"
    @State private var serial = ""
    @State private var status = "active"
    @State private var subject = ""
    @State private var tags = ""
    @State private var note = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField("名称", text: $name)
                Picker("类型", selection: $kind) { ForEach(deviceKinds.indices, id: \.self) { i in Text(deviceKinds[i].1).tag(deviceKinds[i].0) } }
                TextField("序列号 / 标识", text: $serial)
                Picker("状态", selection: $status) { ForEach(deviceStatus.indices, id: \.self) { i in Text(deviceStatus[i].1).tag(deviceStatus[i].0) } }
                Picker("所属组织", selection: $subject) {
                    if allowNoOrg { Text("（不归属组织）").tag("") }
                    ForEach(orgs.indices, id: \.self) { i in Text(str(orgs[i], "name")).tag(str(orgs[i], "id")) }
                }
                TextField("标签（逗号分隔）", text: $tags)
                TextField("备注", text: $note)
            }
            .navigationTitle(device == nil ? "登记设备" : "编辑设备")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("保存") {
                        onSave(["name": name, "kind": kind, "serial": serial, "status": status, "subject_id": subject, "tags": tags, "note": note],
                               device.map { str($0, "id") })
                    }
                }
            }
            .onAppear {
                if let d = device {
                    name = str(d, "name"); kind = str(d, "kind").isEmpty ? "apple" : str(d, "kind"); serial = str(d, "serial")
                    status = str(d, "status").isEmpty ? "active" : str(d, "status"); subject = str(d, "subject_id"); tags = str(d, "tags"); note = str(d, "note")
                } else if !allowNoOrg, let first = orgs.first {
                    subject = str(first, "id")   // 组织管理员登记必须归属自己管理的组织
                }
            }
        }
    }
}

// MARK: - 门禁（门 / 通行记录 / 访客码）

struct AccessManageView: View {
    @EnvironmentObject var state: AppState
    let isAdmin: Bool
    let canPass: Bool
    let passDoors: [[String: Any]]
    @State private var tab = 0
    @State private var doors: [[String: Any]] = []
    @State private var logs: [[String: Any]] = []
    @State private var passes: [[String: Any]] = []
    @State private var issuing = false
    @State private var qrPass: [String: Any]?
    @State private var msg: String?

    var body: some View {
        List {
            Picker("", selection: $tab) {
                if canPass { Text("访客码").tag(0) }
                if isAdmin { Text("门").tag(1); Text("通行记录").tag(2) }
            }
            .pickerStyle(.segmented)
            .listRowBackground(Color.clear)

            if tab == 0 && canPass { passSection }
            if tab == 1 && isAdmin { doorSection }
            if tab == 2 && isAdmin { logSection }
        }
        .navigationTitle("门禁")
        .toolbar {
            if tab == 0 && canPass {
                ToolbarItem(placement: .navigationBarTrailing) { Button { issuing = true } label: { Image(systemName: "plus") } }
            }
        }
        .refreshable { await load() }
        .task { if !canPass { tab = 1 }; await load() }
        .onChange(of: tab) { _ in Task { await load() } }
        .sheet(isPresented: $issuing) {
            PassIssueView(doors: passDoors) { body in issue(body) }
        }
        .sheet(isPresented: Binding(get: { qrPass != nil }, set: { if !$0 { qrPass = nil } })) {
            if let p = qrPass { PassQRView(pass: p, base: state.baseURL) }
        }
        .alert("提示", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) {
            Button("好") { msg = nil }
        } message: { Text(msg ?? "") }
    }

    @ViewBuilder private var passSection: some View {
        if passes.isEmpty { Text("还没有签发过访客码，点右上角 + 签发").foregroundColor(.secondary) }
        ForEach(passes.indices, id: \.self) { i in
            let p = passes[i]
            let active = str(p, "status") == "active"
            Button { qrPass = p } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(str(p, "visitor_name")).font(.subheadline).bold().foregroundColor(.primary)
                        Spacer()
                        Text(active ? "有效" : "已撤销").font(.caption).foregroundColor(active ? .green : .secondary)
                    }
                    let doorNames = ((p["door_names"] as? [String]) ?? []).joined(separator: "、")
                    Text("门：" + (doorNames.isEmpty ? "—" : doorNames)).font(.caption).foregroundColor(.secondary)
                    let win = [str(p, "valid_from"), str(p, "valid_to")].filter { !$0.isEmpty }.joined(separator: " ~ ")
                    Text((win.isEmpty ? "不限时间" : win) + (str(p, "escort_name").isEmpty ? "" : " · 陪同 " + str(p, "escort_name")))
                        .font(.caption2).foregroundColor(.secondary)
                }
            }
            .swipeActions(edge: .trailing) {
                if active { Button(role: .destructive) { revoke(str(p, "id")) } label: { Text("撤销") } }
            }
        }
    }

    @ViewBuilder private var doorSection: some View {
        ForEach(doors.indices, id: \.self) { i in
            let d = doors[i]
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(str(d, "name")).font(.subheadline).bold()
                    if str(d, "code_mode") == "sub_only" { Text("仅子码").font(.caption2).foregroundColor(.orange) }
                    if (d["escort_required"] as? Int) == 1 { Text("需陪同").font(.caption2).foregroundColor(.orange) }
                    Spacer()
                    Text(str(d, "status") == "enabled" ? "启用" : "停用").font(.caption).foregroundColor(str(d, "status") == "enabled" ? .green : .secondary)
                }
                let meta = [str(d, "location"), str(d, "subject_name"), "规则 \(str(d, "rule_count"))"].filter { !$0.isEmpty }.joined(separator: " · ")
                Text(meta).font(.caption).foregroundColor(.secondary)
            }
        }
        Text("门的授权规则、子码与禁入时段请在网页管理端「门禁管理」里配置。").font(.caption2).foregroundColor(.secondary)
    }

    @ViewBuilder private var logSection: some View {
        ForEach(logs.indices, id: \.self) { i in
            let l = logs[i]
            let ok = str(l, "result") == "allow"
            HStack(alignment: .top) {
                Image(systemName: ok ? "checkmark.circle.fill" : "xmark.octagon.fill").foregroundColor(ok ? .green : .red)
                VStack(alignment: .leading, spacing: 2) {
                    Text((str(l, "user_name").isEmpty ? "未知" : str(l, "user_name")) + " · " + str(l, "door_name")).font(.subheadline)
                    Text(str(l, "created_at") + " · " + str(l, "method") + (ok ? "" : " · " + str(l, "reason"))).font(.caption2).foregroundColor(.secondary)
                }
            }
        }
    }

    private func load() async {
        do {
            if tab == 0 && canPass {
                let j = try await state.api().request("GET", "/api/access/passes", token: state.token)
                await MainActor.run { passes = (j["passes"] as? [[String: Any]]) ?? [] }
            } else if tab == 1 && isAdmin {
                let j = try await state.api().request("GET", "/api/admin/access/doors", token: state.token)
                await MainActor.run { doors = (j["doors"] as? [[String: Any]]) ?? [] }
            } else if tab == 2 && isAdmin {
                let j = try await state.api().request("GET", "/api/admin/access/logs?limit=100", token: state.token)
                await MainActor.run { logs = (j["data"] as? [[String: Any]]) ?? [] }
            }
        } catch { await MainActor.run { msg = error.localizedDescription } }
    }
    private func issue(_ body: [String: Any]) {
        Task {
            do {
                let j = try await state.api().request("POST", "/api/access/passes", body: body, token: state.token)
                await MainActor.run {
                    issuing = false
                    qrPass = ["code": str(j, "code"), "visitor_name": (body["visitor_name"] as? String) ?? ""]
                }
                await load()
            } catch { await MainActor.run { msg = error.localizedDescription } }
        }
    }
    private func revoke(_ id: String) {
        Task {
            do { _ = try await state.api().request("DELETE", "/api/access/passes/\(id)", token: state.token); await load() }
            catch { await MainActor.run { msg = error.localizedDescription } }
        }
    }
}

/// 签发访客码
private struct PassIssueView: View {
    let doors: [[String: Any]]
    let onIssue: ([String: Any]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var phone = ""
    @State private var picked: Set<String> = []
    @State private var limitTime = false
    @State private var until = Date().addingTimeInterval(8 * 3600)
    @State private var uses = 0
    @State private var escort = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("访客") {
                    TextField("访客姓名", text: $name)
                    TextField("访客手机（可选）", text: $phone).keyboardType(.phonePad)
                }
                Section("可通行的门") {
                    if doors.isEmpty { Text("没有可选的门").foregroundColor(.secondary) }
                    ForEach(doors.indices, id: \.self) { i in
                        let id = str(doors[i], "id")
                        Button {
                            if picked.contains(id) { picked.remove(id) } else { picked.insert(id) }
                        } label: {
                            HStack {
                                Text(str(doors[i], "name")).foregroundColor(.primary)
                                Spacer()
                                if picked.contains(id) { Image(systemName: "checkmark").foregroundColor(.accentColor) }
                            }
                        }
                    }
                }
                Section("限制") {
                    Toggle("设置失效时间", isOn: $limitTime)
                    if limitTime { DatePicker("失效时间", selection: $until, in: Date()...) }
                    Stepper("使用次数：\(uses == 0 ? "不限" : String(uses))", value: $uses, in: 0...100)
                    TextField("陪同人（可选：邮箱 / 手机 / UID）", text: $escort)
                }
            }
            .navigationTitle("签发访客码")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("签发") {
                        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd'T'HH:mm"
                        var body: [String: Any] = ["visitor_name": name, "visitor_phone": phone, "door_ids": Array(picked), "max_uses": uses, "escort": escort]
                        if limitTime { body["valid_to"] = f.string(from: until) }
                        onIssue(body)
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || picked.isEmpty)
                }
            }
        }
    }
}

/// 访客码二维码 + 分享链接
private struct PassQRView: View {
    let pass: [String: Any]
    let base: String
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        let code = str(pass, "code")
        let link = base + "/pass.html?code=" + (code.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? code)
        NavigationStack {
            VStack(spacing: 16) {
                if let img = AccessView.makeQR(code) {
                    Image(uiImage: img).interpolation(.none).resizable().frame(width: 220, height: 220)
                        .padding(12).background(Color.white).cornerRadius(12)
                }
                Text(str(pass, "visitor_name")).font(.headline)
                Text(code).font(.system(.caption, design: .monospaced)).foregroundColor(.secondary)
                if let u = URL(string: link) {
                    ShareLink(item: u) { Label("分享访客链接", systemImage: "square.and.arrow.up") }
                        .buttonStyle(.borderedProminent)
                }
                Text("访客打开链接即可出示通行码，也能按门出示子码。").font(.caption).foregroundColor(.secondary)
                Spacer()
            }
            .padding()
            .navigationTitle("访客码")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button("完成") { dismiss() } } }
        }
    }
}
