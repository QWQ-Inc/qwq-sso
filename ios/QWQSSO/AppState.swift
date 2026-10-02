import SwiftUI

/// 一个「系统/网域」= 一份独立的登录态（网域 + token + 展示信息）
struct Account: Codable, Identifiable, Equatable {
    var id: String
    var domain: String
    var token: String
    var name: String
    var uid: String
}

/// 全局状态：可同时保存多个来源系统（多网域），随时切换。
/// 不加 @MainActor：@Published 的 UI 变更由调用方在主线程改。
final class AppState: ObservableObject {
    @Published private(set) var accounts: [Account] = []
    @Published var currentId: String?
    @Published var methods: [LoginMethod] = []
    @Published var showAddSystem = false        // RootView 据此弹「添加系统」

    init() { loadPersisted() }

    // ── 持久化 ──
    private func persist() {
        if let data = try? JSONEncoder().encode(accounts) {
            UserDefaults.standard.set(data, forKey: "sso_accounts")
        }
        UserDefaults.standard.set(currentId, forKey: "sso_current_id")
    }
    private func loadPersisted() {
        if let d = UserDefaults.standard.data(forKey: "sso_accounts"),
           let arr = try? JSONDecoder().decode([Account].self, from: d) {
            accounts = arr
        }
        currentId = UserDefaults.standard.string(forKey: "sso_current_id")
        // 迁移旧的单系统存储（sso_domain/sso_token）
        if accounts.isEmpty {
            let od = UserDefaults.standard.string(forKey: "sso_domain") ?? ""
            let ot = UserDefaults.standard.string(forKey: "sso_token") ?? ""
            if !od.isEmpty {
                let a = Account(id: UUID().uuidString, domain: od, token: ot, name: "", uid: "")
                accounts = [a]; currentId = a.id; persist()
                UserDefaults.standard.removeObject(forKey: "sso_domain")
                UserDefaults.standard.removeObject(forKey: "sso_token")
            }
        }
        if currentId == nil || !accounts.contains(where: { $0.id == currentId }) {
            currentId = accounts.first?.id
        }
    }

    // ── 当前系统 ──
    var current: Account? { accounts.first { $0.id == currentId } ?? accounts.first }
    var domain: String { current?.domain ?? "" }
    var token: String { current?.token ?? "" }
    var baseURL: String { AppState.normalizeBase(domain) }
    var hasAccounts: Bool { !accounts.isEmpty }
    var isLoggedIn: Bool { !(current?.token ?? "").isEmpty }
    var meName: String { current?.name ?? "" }
    var meUid: String { current?.uid ?? "" }

    func api() -> APIClient { APIClient(base: baseURL) }

    // ── 变更 ──
    private func mutateCurrent(_ f: (inout Account) -> Void) {
        guard let id = currentId, let idx = accounts.firstIndex(where: { $0.id == id }) else { return }
        var a = accounts[idx]; f(&a); accounts[idx] = a; persist()
    }
    func setToken(_ t: String) { mutateCurrent { $0.token = t } }
    func setMe(name: String, uid: String) { mutateCurrent { $0.name = name; $0.uid = uid } }
    func logoutCurrent() { mutateCurrent { $0.token = ""; $0.name = ""; $0.uid = "" } }

    func switchTo(_ id: String) { currentId = id; methods = []; persist() }

    /// 添加系统（网域）；已存在相同网域则切过去。返回该账户。
    @discardableResult
    func addSystem(domain: String) -> Account {
        let d = domain.trimmingCharacters(in: .whitespacesAndNewlines)
        if let exist = accounts.first(where: { AppState.normalizeBase($0.domain) == AppState.normalizeBase(d) }) {
            currentId = exist.id; methods = []; persist(); return exist
        }
        let a = Account(id: UUID().uuidString, domain: d, token: "", name: "", uid: "")
        accounts.append(a); currentId = a.id; methods = []; persist()
        return a
    }
    func removeSystem(_ id: String) {
        accounts.removeAll { $0.id == id }
        if currentId == id { currentId = accounts.first?.id }
        persist()
    }

    /// 深链：qwqsso://login?domain=<host>&token=<jwt>
    /// - domain：加入/切到该系统（多网域）；token：设为当前系统的登录态
    func handleDeepLink(_ url: URL) {
        guard url.scheme == "qwqsso" else { return }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func q(_ n: String) -> String? { items.first { $0.name == n }?.value }
        if let d = q("domain"), !d.isEmpty { _ = addSystem(domain: d) }
        if let t = q("token"), !t.isEmpty { setToken(t) }
    }

    static func normalizeBase(_ d: String) -> String {
        var s = d.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return "" }
        if !s.hasPrefix("http://") && !s.hasPrefix("https://") { s = "https://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
