import SwiftUI
import UIKit

/// 应用中心（原生，v3.5.28 改为桌面式网格）：图标（图片或 emoji）+ 个人文件夹 + 搜索 / 分类。
/// 点应用 → 打开 / 授权 / 取消授权 / 移到文件夹；长按同样有菜单。文件夹只是个人整理，不影响可见性与授权。
struct AppsTabView: View {
    @EnvironmentObject var state: AppState
    @State private var apps: [[String: Any]] = []
    @State private var folders: [[String: Any]] = []
    @State private var loading = false
    @State private var busyId: String?
    @State private var msg: String?
    @State private var search = ""
    @State private var cat = ""   // 分类筛选（""=全部）
    @State private var openFolderId: String?
    @State private var actionApp: [String: Any]?
    @State private var movingApp: [String: Any]?
    @State private var newFolderFor: String??   // nil=未弹；.some(nil)=新建空文件夹；.some(id)=新建并放入该应用
    @State private var newFolderName = ""
    @State private var tools: [String: Any] = [:]          // 管理工具权限（v3.5.30，/api/user/app-center）
    @State private var passDoors: [[String: Any]] = []

    private let cols = [GridItem(.adaptive(minimum: 72), spacing: 14)]

    // ── 派生数据 ──
    private func sid(_ a: [String: Any]) -> String { (a["id"] as? String) ?? "" }
    private func folderAppIds(_ f: [String: Any]) -> [String] { (f["app_ids"] as? [String]) ?? [] }
    private var categories: [String] {
        var seen: [String] = []
        for a in apps {
            let c = ((a["category"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
            if !c.isEmpty && !seen.contains(c) { seen.append(c) }
        }
        return seen
    }
    private var filtering: Bool { !search.trimmingCharacters(in: .whitespaces).isEmpty || !cat.isEmpty }
    private var filtered: [[String: Any]] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        return apps.filter { a in
            let name = ((a["name"] as? String) ?? "").lowercased()
            let desc = ((a["description"] as? String) ?? "").lowercased()
            let c = ((a["category"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
            return (q.isEmpty || name.contains(q) || desc.contains(q)) && (cat.isEmpty || c == cat)
        }
    }
    /// 文件夹里的应用 id（只算我能看到的应用）
    private var foldered: Set<String> {
        let visible = Set(apps.map { sid($0) })
        return Set(folders.flatMap { folderAppIds($0) }).intersection(visible)
    }
    private var looseApps: [[String: Any]] { apps.filter { !foldered.contains(sid($0)) } }
    private func appsIn(_ f: [String: Any]) -> [[String: Any]] {
        let ids = folderAppIds(f)
        return apps.filter { ids.contains(sid($0)) }
    }
    private func folderOf(_ appId: String) -> [String: Any]? { folders.first { folderAppIds($0).contains(appId) } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if !categories.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                chip("全部", "")
                                ForEach(categories, id: \.self) { c in chip(c, c) }
                            }.padding(.horizontal)
                        }
                    }
                    if !filtering && hasTools {
                        Text("管理工具").font(.footnote).foregroundColor(.secondary).padding(.horizontal)
                        LazyVGrid(columns: cols, spacing: 18) { toolTiles }.padding(.horizontal)
                        Text("应用").font(.footnote).foregroundColor(.secondary).padding(.horizontal)
                    }
                    if apps.isEmpty && !loading {
                        Text("暂无可用应用").foregroundColor(.secondary).padding()
                    }
                    LazyVGrid(columns: cols, spacing: 18) {
                        if filtering {
                            ForEach(filtered.indices, id: \.self) { i in appTile(filtered[i]) }
                        } else {
                            ForEach(folders.indices, id: \.self) { i in folderTile(folders[i]) }
                            ForEach(looseApps.indices, id: \.self) { i in appTile(looseApps[i]) }
                        }
                    }
                    .padding(.horizontal)
                }
                .padding(.vertical, 8)
            }
            .navigationTitle("应用中心")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { newFolderName = ""; newFolderFor = .some(nil) } label: { Image(systemName: "folder.badge.plus") }
                }
            }
            .searchable(text: $search, prompt: "搜索应用")
            .refreshable { await load() }
            .task { await load() }
            .sheet(isPresented: Binding(get: { openFolderId != nil }, set: { if !$0 { openFolderId = nil } })) {
                if let fid = openFolderId, let f = folders.first(where: { sid($0) == fid }) { folderSheet(f) }
            }
            .confirmationDialog((actionApp?["name"] as? String) ?? "应用",
                                isPresented: Binding(get: { actionApp != nil }, set: { if !$0 { actionApp = nil } }),
                                titleVisibility: .visible) {
                if let a = actionApp { appActions(a) }
            }
            .confirmationDialog("移到文件夹", isPresented: Binding(get: { movingApp != nil }, set: { if !$0 { movingApp = nil } }), titleVisibility: .visible) {
                if let a = movingApp { moveActions(a) }
            }
            .alert("新建文件夹", isPresented: Binding(get: { newFolderFor != nil }, set: { if !$0 { newFolderFor = nil } })) {
                TextField("文件夹名称", text: $newFolderName)
                Button("取消", role: .cancel) { newFolderFor = nil }
                Button("创建") {
                    let target = newFolderFor ?? nil
                    newFolderFor = nil
                    createFolder(name: newFolderName, appId: target)
                }
            }
            .alert("提示", isPresented: Binding(get: { msg != nil }, set: { if !$0 { msg = nil } })) {
                Button("好") { msg = nil }
            } message: { Text(msg ?? "") }
        }
    }

    // ── 管理工具磁贴（同一套管理接口，只是手机上的入口）──
    private var hasTools: Bool { tools["users"] is [String: Any] || tools["devices"] is [String: Any] || tools["access"] is [String: Any] }
    @ViewBuilder private var toolTiles: some View {
        if let acc = tools["access"] as? [String: Any] {
            NavigationLink { AccessManageView(isAdmin: (acc["admin"] as? Bool) ?? false, canPass: (acc["passes"] as? Bool) ?? false, passDoors: passDoors) }
                label: { ToolTile(title: "门禁", symbol: "door.left.hand.closed", color: .blue) }
                .buttonStyle(.plain)
        }
        if tools["devices"] is [String: Any] {
            NavigationLink { DevicesManageView() } label: { ToolTile(title: "设备管理", symbol: "laptopcomputer.and.iphone", color: .teal) }
                .buttonStyle(.plain)
        }
        if let us = tools["users"] as? [String: Any] {
            NavigationLink { AdminUsersView(canWrite: (us["write"] as? Bool) ?? false) } label: { ToolTile(title: "用户管理", symbol: "person.2.fill", color: .indigo) }
                .buttonStyle(.plain)
        }
    }

    // ── 子视图 ──
    @ViewBuilder
    private func chip(_ label: String, _ val: String) -> some View {
        Button { cat = val } label: {
            Text(label).font(.caption)
                .padding(.horizontal, 12).padding(.vertical, 5)
                .background(cat == val ? Color.accentColor : Color(.secondarySystemBackground))
                .foregroundColor(cat == val ? .white : .primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func appTile(_ a: [String: Any]) -> some View {
        let id = sid(a)
        let authed = isAuthed(a)
        Button { actionApp = a } label: {
            VStack(spacing: 6) {
                ZStack(alignment: .topTrailing) {
                    AppIconView(app: a, base: state.baseURL, size: 56)
                    if busyId == id { ProgressView().padding(4) }
                    else if authed { Circle().fill(Color.green).frame(width: 10, height: 10).offset(x: 3, y: -3) }
                }
                Text((a["name"] as? String) ?? "应用").font(.caption2).lineLimit(1).foregroundColor(.primary)
            }
        }
        .buttonStyle(.plain)
        .contextMenu { appActions(a) }
    }

    @ViewBuilder
    private func folderTile(_ f: [String: Any]) -> some View {
        let inner = appsIn(f)
        Button { openFolderId = sid(f) } label: {
            VStack(spacing: 6) {
                ZStack {
                    RoundedRectangle(cornerRadius: 13, style: .continuous).fill(Color(.tertiarySystemFill))
                    LazyVGrid(columns: [GridItem(.fixed(20), spacing: 4), GridItem(.fixed(20), spacing: 4)], spacing: 4) {
                        ForEach(Array(inner.prefix(4).enumerated()), id: \.offset) { _, a in
                            AppIconView(app: a, base: state.baseURL, size: 20)
                        }
                    }
                }
                .frame(width: 56, height: 56)
                Text((f["name"] as? String) ?? "文件夹").font(.caption2).lineLimit(1).foregroundColor(.primary)
            }
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(role: .destructive) { deleteFolder(sid(f)) } label: { Label("删除文件夹", systemImage: "trash") }
        }
    }

    @ViewBuilder
    private func folderSheet(_ f: [String: Any]) -> some View {
        FolderSheet(folder: f, apps: appsIn(f), base: state.baseURL,
                    onTap: { a in openFolderId = nil; DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { actionApp = a } },
                    onRename: { name in renameFolder(sid(f), name) },
                    onDelete: { openFolderId = nil; deleteFolder(sid(f)) })
    }

    @ViewBuilder
    private func appActions(_ a: [String: Any]) -> some View {
        let id = sid(a)
        let name = (a["name"] as? String) ?? "应用"
        let authed = isAuthed(a)
        let hasLaunch = !((a["launch_url"] as? String) ?? "").isEmpty
        if authed || hasLaunch {
            Button { openApp(id: id, name: name) } label: { Label("打开", systemImage: "arrow.up.right.square") }
        }
        if !authed {
            Button { authorize(id: id) } label: { Label("授权", systemImage: "checkmark.shield") }
        }
        Button { movingApp = a } label: { Label("移到文件夹…", systemImage: "folder") }
        if authed {
            Button(role: .destructive) { revoke(id: id) } label: { Label("取消授权", systemImage: "xmark.shield") }
        }
    }

    @ViewBuilder
    private func moveActions(_ a: [String: Any]) -> some View {
        let id = sid(a)
        let cur = folderOf(id).map { sid($0) }
        ForEach(folders.indices, id: \.self) { i in
            let f = folders[i]
            Button(((f["name"] as? String) ?? "文件夹") + (cur == sid(f) ? " ✓" : "")) { assign(appId: id, folderId: sid(f)) }
        }
        Button("新建文件夹并放入…") { newFolderName = ""; DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { newFolderFor = .some(id) } }
        if cur != nil { Button("移出文件夹") { assign(appId: id, folderId: nil) } }
    }

    // ── 动作 ──
    private func isAuthed(_ a: [String: Any]) -> Bool { (a["userAuthed"] as? Bool) ?? ((a["userAuthed"] as? Int) == 1) }

    private func run(_ id: String?, _ work: @escaping () async throws -> Void) {
        busyId = id
        Task {
            do { try await work(); await load() }
            catch { await MainActor.run { msg = error.localizedDescription } }
            await MainActor.run { busyId = nil }
        }
    }
    private func authorize(id: String) { run(id) { try await state.api().appAuthorize(id: id, token: state.token) } }
    private func revoke(id: String) { run(id) { try await state.api().appRevoke(id: id, token: state.token) } }
    private func assign(appId: String, folderId: String?) { run(nil) { try await state.api().appFolderAssign(appId: appId, folderId: folderId, token: state.token) } }
    private func createFolder(name: String, appId: String?) {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return }
        run(nil) { try await state.api().appFolderCreate(name: n, appIds: appId.map { [$0] } ?? [], token: state.token) }
    }
    private func renameFolder(_ id: String, _ name: String) {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return }
        run(nil) { try await state.api().appFolderRename(id: id, name: n, token: state.token) }
    }
    private func deleteFolder(_ id: String) { run(nil) { try await state.api().appFolderDelete(id: id, token: state.token) } }

    private func openApp(id: String, name: String) {
        busyId = id
        Task {
            do {
                let urlStr = try await state.api().appLaunch(id: id, token: state.token)
                await MainActor.run {
                    busyId = nil
                    if let u = URL(string: urlStr) { UIApplication.shared.open(u) }
                    else { msg = "无法打开该应用" }
                }
            } catch {
                await MainActor.run { busyId = nil; msg = error.localizedDescription }
            }
        }
    }

    private func load() async {
        guard !state.token.isEmpty else { return }
        await MainActor.run { loading = true }
        let list = (try? await state.api().appsMarket(token: state.token)) ?? []
        let fs = (try? await state.api().appFolders(token: state.token)) ?? []
        let ac = (try? await state.api().request("GET", "/api/user/app-center", token: state.token)) ?? [:]
        await MainActor.run {
            apps = list; folders = fs; loading = false
            tools = (ac["tools"] as? [String: Any]) ?? [:]
            passDoors = (ac["pass_doors"] as? [[String: Any]]) ?? []
        }
    }
}

/// 打开的文件夹：网格 + 重命名 / 删除
private struct FolderSheet: View {
    let folder: [String: Any]
    let apps: [[String: Any]]
    let base: String
    let onTap: ([String: Any]) -> Void
    let onRename: (String) -> Void
    let onDelete: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var renaming = false
    @State private var name = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                if apps.isEmpty {
                    Text("文件夹是空的。在应用上长按 →「移到文件夹」即可放进来。").font(.footnote).foregroundColor(.secondary).padding()
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 14)], spacing: 18) {
                    ForEach(apps.indices, id: \.self) { i in
                        let a = apps[i]
                        Button { onTap(a) } label: {
                            VStack(spacing: 6) {
                                AppIconView(app: a, base: base, size: 56)
                                Text((a["name"] as? String) ?? "应用").font(.caption2).lineLimit(1).foregroundColor(.primary)
                            }
                        }.buttonStyle(.plain)
                    }
                }.padding()
            }
            .navigationTitle((folder["name"] as? String) ?? "文件夹")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) { Button("完成") { dismiss() } }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Button { name = (folder["name"] as? String) ?? ""; renaming = true } label: { Label("重命名", systemImage: "pencil") }
                        Button(role: .destructive) { onDelete() } label: { Label("删除文件夹", systemImage: "trash") }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
            .alert("重命名文件夹", isPresented: $renaming) {
                TextField("名称", text: $name)
                Button("取消", role: .cancel) {}
                Button("保存") { onRename(name) }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
