import SwiftUI
import UIKit

// 人员管理（v3.5.81）：按组织 + 第三方同步源的部门树查看/管理成员。
// 系统管理员看所有组织、组织管理员只看自己管理的组织（后端 /user/app-center 下发 members.orgs）。
// 操作复用网页同一套接口（停用/启用、重置密码、联系方式增删改），能不能操作仍以后端校验为准。

private func s(_ d: [String: Any], _ k: String) -> String {
    if let v = d[k] as? String { return v }
    if let n = d[k] as? Int { return String(n) }
    return ""
}
private func memUid(_ m: [String: Any]) -> String {
    let code = s(m, "uid_code")
    if !code.isEmpty { return code }
    let seq = (m["uid_seq"] as? Int) ?? 0
    return "#" + String(format: "%05d", seq)
}

// MARK: - 部门树排序（父子缩进）

private struct DeptNode { let id: String; let name: String; let depth: Int; let count: Int }

private func orderedDepts(_ data: [[String: Any]]) -> [DeptNode] {
    // 按 parent_id 组织成树，DFS 输出带缩进层级
    var byParent: [String: [[String: Any]]] = [:]
    for d in data {
        let p = s(d, "parent_id")
        byParent[p, default: []].append(d)
    }
    // 根：parent_id 为空，或其父不在集合里
    let ids = Set(data.map { s($0, "id") })
    var out: [DeptNode] = []
    func walk(_ node: [String: Any], _ depth: Int) {
        out.append(DeptNode(id: s(node, "id"), name: s(node, "name").isEmpty ? "(未命名部门)" : s(node, "name"),
                            depth: depth, count: (node["member_count"] as? Int) ?? 0))
        for c in byParent[s(node, "id")] ?? [] { walk(c, depth + 1) }
    }
    for d in data where s(d, "parent_id").isEmpty || !ids.contains(s(d, "parent_id")) { walk(d, 0) }
    // 兜底：漏掉的（环/异常）平铺补上
    let seen = Set(out.map { $0.id })
    for d in data where !seen.contains(s(d, "id")) {
        out.append(DeptNode(id: s(d, "id"), name: s(d, "name"), depth: 0, count: (d["member_count"] as? Int) ?? 0))
    }
    return out
}

// MARK: - 人员管理入口（选组织 → 成员）

struct OrgMembersManageView: View {
    @EnvironmentObject var state: AppState
    let orgs: [[String: Any]]
    let canWrite: Bool

    @State private var orgId: String = ""

    var body: some View {
        Group {
            if orgs.isEmpty {
                Text("没有可管理的组织").foregroundColor(.secondary)
            } else {
                OrgMemberListView(orgId: orgId.isEmpty ? s(orgs[0], "id") : orgId, orgs: orgs, canWrite: canWrite,
                                  onPickOrg: { orgId = $0 })
                    .id(orgId.isEmpty ? s(orgs[0], "id") : orgId)   // 换组织重建，重新加载
            }
        }
        .navigationTitle("人员管理")
    }
}

private struct OrgMemberListView: View {
    @EnvironmentObject var state: AppState
    let orgId: String
    let orgs: [[String: Any]]
    let canWrite: Bool
    let onPickOrg: (String) -> Void

    @State private var members: [[String: Any]] = []
    @State private var depts: [DeptNode] = []
    @State private var filter = "all"   // all / unassigned / pending / suspended / <deptId>
    @State private var q = ""
    @State private var loading = false
    @State private var detail: [String: Any]?
    @State private var msg: String?

    private var orgName: String { s(orgs.first { s($0, "id") == orgId } ?? [:], "name") }

    private var filtered: [[String: Any]] {
        let kw = q.trimmingCharacters(in: .whitespaces).lowercased()
        return members.filter { m in
            let matchKw = kw.isEmpty || s(m, "name").lowercased().contains(kw)
                || memUid(m).lowercased().contains(kw) || s(m, "email").lowercased().contains(kw)
            if !matchKw { return false }
            switch filter {
            case "all": return true
            case "unassigned": return s(m, "dept_id").isEmpty && (m["pending"] as? Int ?? 0) == 0
            case "pending": return (m["pending"] as? Int ?? 0) == 1
            case "suspended": return (m["pending"] as? Int ?? 0) == 2
            default: return s(m, "dept_id") == filter
            }
        }
    }

    var body: some View {
        List {
            Section {
                if orgs.count > 1 {
                    Picker("组织", selection: Binding(get: { orgId }, set: { onPickOrg($0) })) {
                        ForEach(orgs.indices, id: \.self) { i in Text(s(orgs[i], "name")).tag(s(orgs[i], "id")) }
                    }
                }
                Picker("部门", selection: $filter) {
                    Text("全部成员").tag("all")
                    Text("未分配部门").tag("unassigned")
                    Text("待分配").tag("pending")
                    Text("已挂起").tag("suspended")
                    ForEach(depts.indices, id: \.self) { i in
                        Text(String(repeating: "   ", count: depts[i].depth) + depts[i].name
                             + (depts[i].count > 0 ? " (\(depts[i].count))" : "")).tag(depts[i].id)
                    }
                }
            }

            Section(filtered.isEmpty ? "" : "共 \(filtered.count) 人") {
                if filtered.isEmpty && !loading { Text("没有成员").foregroundColor(.secondary) }
                ForEach(filtered.indices, id: \.self) { i in
                    let m = filtered[i]
                    memberRow(m)
                }
            }
        }
        .searchable(text: $q, prompt: "姓名 / UID / 邮箱")
        .refreshable { await load() }
        .task { await load() }
        .sheet(isPresented: Binding(get: { detail != nil }, set: { if !$0 { detail = nil } })) {
            if let m = detail {
                OrgMemberDetailSheet(member: m, orgName: orgName, canWrite: canWrite) { Task { await load() } }
            }
        }
        .alert("提示", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) {
            Button("好") { msg = nil }
        } message: { Text(msg ?? "") }
    }

    @ViewBuilder private func memberRow(_ m: [String: Any]) -> some View {
        let active = s(m, "status") != "disabled"
        let isAdmin = s(m, "role") == "admin"
        let pend = m["pending"] as? Int ?? 0
        Button { detail = m } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(s(m, "name")).font(.subheadline).bold().foregroundColor(.primary)
                    Text(memUid(m)).font(.caption).foregroundColor(.secondary)
                    if isAdmin { Text("管理员").font(.caption2).foregroundColor(.orange) }
                    Spacer()
                    Text(active ? "正常" : "已停用").font(.caption).foregroundColor(active ? .green : .red)
                }
                HStack(spacing: 6) {
                    if !s(m, "dept_name").isEmpty {
                        Text("🏢 " + s(m, "dept_name")).font(.caption2).foregroundColor(.secondary)
                    }
                    if pend == 1 { Text("待分配").font(.caption2).foregroundColor(.orange) }
                    if pend == 2 { Text("已挂起").font(.caption2).foregroundColor(.red) }
                    if !s(m, "org_uid").isEmpty { Text("工号 " + s(m, "org_uid")).font(.caption2).foregroundColor(.secondary) }
                }
                if !s(m, "email").isEmpty { Text(s(m, "email")).font(.caption2).foregroundColor(.secondary) }
            }
        }
        .swipeActions(edge: .trailing) {
            if canWrite && !isAdmin {
                if active {
                    Button(role: .destructive) { setStatus(m, enable: false) } label: { Text("停用") }
                } else {
                    Button { setStatus(m, enable: true) } label: { Text("启用") }.tint(.green)
                }
            }
        }
    }

    private func load() async {
        await MainActor.run { loading = true }
        do {
            async let mj = state.api().request("GET", "/api/admin/orgs/\(orgId)/members", token: state.token)
            async let dj = state.api().request("GET", "/api/admin/orgs/\(orgId)/departments", token: state.token)
            let (m, d) = try await (mj, dj)
            await MainActor.run {
                members = (m["members"] as? [[String: Any]]) ?? []
                depts = orderedDepts((d["data"] as? [[String: Any]]) ?? [])
                loading = false
            }
        } catch {
            await MainActor.run { loading = false; msg = error.localizedDescription }
        }
    }

    private func setStatus(_ m: [String: Any], enable: Bool) {
        Task {
            do {
                _ = try await state.api().request("POST", "/api/admin/users/\(s(m, "user_id"))/\(enable ? "enable" : "disable")", body: [:], token: state.token)
                await load()
            } catch { await MainActor.run { msg = error.localizedDescription } }
        }
    }
}

// MARK: - 成员详情（联系方式 + 重置密码 + 停用/启用）

private struct OrgMemberDetailSheet: View {
    let member: [String: Any]
    let orgName: String
    let canWrite: Bool
    let onChanged: () -> Void

    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var phones: [[String: Any]] = []
    @State private var emails: [[String: Any]] = []
    @State private var active = true
    @State private var loading = false
    @State private var editing: (cid: String, kind: String, value: String)?
    @State private var adding: String?            // "phone" / "email"
    @State private var showReset = false
    @State private var pw = ""
    @State private var msg: String?

    private var uid: String { s(member, "user_id") }
    private var isAdmin: Bool { s(member, "role") == "admin" }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Text(s(member, "name")).font(.headline)
                        Text(memUid(member)).font(.caption).foregroundColor(.secondary)
                        Spacer()
                        Text(active ? "正常" : "已停用").font(.caption).foregroundColor(active ? .green : .red)
                    }
                    if !orgName.isEmpty { Text(orgName + (s(member, "dept_name").isEmpty ? "" : " · " + s(member, "dept_name"))).font(.caption).foregroundColor(.secondary) }
                }

                Section("手机号") {
                    ForEach(phones.indices, id: \.self) { i in contactRow(phones[i], "phone") }
                    if phones.isEmpty { Text("无").foregroundColor(.secondary) }
                    if canWrite { Button { adding = "phone" } label: { Label("添加手机号", systemImage: "plus") } }
                }
                Section("邮箱 / 企业邮箱") {
                    ForEach(emails.indices, id: \.self) { i in contactRow(emails[i], "email") }
                    if emails.isEmpty { Text("无").foregroundColor(.secondary) }
                    if canWrite { Button { adding = "email" } label: { Label("添加邮箱", systemImage: "plus") } }
                }

                if canWrite && !isAdmin {
                    Section("操作") {
                        Button { showReset = true } label: { Label("重置登录密码", systemImage: "key") }
                        if active {
                            Button(role: .destructive) { setStatus(false) } label: { Label("停用该成员", systemImage: "nosign") }
                        } else {
                            Button { setStatus(true) } label: { Label("启用该成员", systemImage: "checkmark.circle") }
                        }
                    }
                }
            }
            .navigationTitle("成员")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button("完成") { dismiss() } } }
            .task { active = s(member, "status") != "disabled"; await loadContacts() }
            .sheet(isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
                if let e = editing {
                    ContactEditSheet(title: e.kind == "phone" ? "修改手机号" : "修改邮箱", initial: e.value, keyboard: e.kind == "phone" ? .phonePad : .emailAddress) { v in
                        saveEdit(cid: e.cid, value: v)
                    }
                }
            }
            .sheet(isPresented: Binding(get: { adding != nil }, set: { if !$0 { adding = nil } })) {
                if let k = adding {
                    ContactEditSheet(title: k == "phone" ? "添加手机号" : "添加邮箱", initial: "", keyboard: k == "phone" ? .phonePad : .emailAddress) { v in
                        addContact(kind: k, value: v)
                    }
                }
            }
            .alert("重置登录密码", isPresented: $showReset) {
                SecureField("新密码（至少 6 位）", text: $pw)
                Button("取消", role: .cancel) { pw = "" }
                Button("重置") { resetPw() }
            } message: { Text("为 \(s(member, "name")) 设置新的登录密码") }
            .alert("提示", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) {
                Button("好") { msg = nil }
            } message: { Text(msg ?? "") }
        }
    }

    @ViewBuilder private func contactRow(_ c: [String: Any], _ kind: String) -> some View {
        let primary = (c["is_primary"] as? Bool) ?? false
        let src = s(c, "source")
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(s(c, "value"))
                HStack(spacing: 5) {
                    if primary { Text("主要").font(.caption2).foregroundColor(.accentColor) }
                    if src == "wecom" { Text("企业微信").font(.caption2).foregroundColor(.secondary) }
                    else if src == "wecom_biz" { Text("企业邮箱").font(.caption2).foregroundColor(.secondary) }
                }
            }
            Spacer()
            if canWrite {
                Button { editing = (s(c, "id"), kind, s(c, "value")) } label: { Image(systemName: "pencil") }
                    .buttonStyle(.borderless)
            }
        }
        .swipeActions(edge: .trailing) {
            if canWrite { Button(role: .destructive) { delContact(s(c, "id")) } label: { Text("删除") } }
        }
    }

    private func loadContacts() async {
        await MainActor.run { loading = true }
        do {
            let j = try await state.api().request("GET", "/api/admin/users/\(uid)/contacts", token: state.token)
            let data = (j["data"] as? [String: Any]) ?? [:]
            await MainActor.run {
                phones = (data["phones"] as? [[String: Any]]) ?? []
                emails = (data["emails"] as? [[String: Any]]) ?? []
                loading = false
            }
        } catch { await MainActor.run { loading = false; msg = error.localizedDescription } }
    }
    private func addContact(kind: String, value: String) {
        Task {
            do { _ = try await state.api().request("POST", "/api/admin/users/\(uid)/contacts", body: ["kind": kind, "value": value], token: state.token)
                await MainActor.run { adding = nil }; await loadContacts(); onChanged() }
            catch { await MainActor.run { msg = error.localizedDescription } }
        }
    }
    private func saveEdit(cid: String, value: String) {
        Task {
            do { let j = try await state.api().request("PATCH", "/api/admin/users/\(uid)/contacts/\(cid)", body: ["value": value], token: state.token)
                await MainActor.run { editing = nil; if (j["occupied"] as? Bool) == true { msg = "已修改，但该值已被别的账号用作登录主字段，未镜像到登录主字段。" } }
                await loadContacts(); onChanged() }
            catch { await MainActor.run { msg = error.localizedDescription } }
        }
    }
    private func delContact(_ cid: String) {
        Task {
            do { _ = try await state.api().request("DELETE", "/api/admin/users/\(uid)/contacts/\(cid)", token: state.token); await loadContacts(); onChanged() }
            catch { await MainActor.run { msg = error.localizedDescription } }
        }
    }
    private func resetPw() {
        let p = pw; pw = ""
        guard p.count >= 6 else { msg = "密码至少 6 位"; return }
        Task {
            do { _ = try await state.api().request("POST", "/api/admin/users/\(uid)/reset-password", body: ["password": p], token: state.token)
                await MainActor.run { msg = "密码已重置" } }
            catch { await MainActor.run { msg = error.localizedDescription } }
        }
    }
    private func setStatus(_ enable: Bool) {
        Task {
            do { _ = try await state.api().request("POST", "/api/admin/users/\(uid)/\(enable ? "enable" : "disable")", body: [:], token: state.token)
                await MainActor.run { active = enable }; onChanged() }
            catch { await MainActor.run { msg = error.localizedDescription } }
        }
    }
}

/// 联系方式输入（添加/修改共用）
private struct ContactEditSheet: View {
    let title: String
    let initial: String
    let keyboard: UIKeyboardType
    let onSave: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var value = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField("请输入", text: $value)
                    .keyboardType(keyboard)
                    .autocapitalization(.none)
                    .disableAutocorrection(true)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("保存") { onSave(value.trimmingCharacters(in: .whitespaces)) }
                        .disabled(value.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { value = initial }
        }
    }
}
