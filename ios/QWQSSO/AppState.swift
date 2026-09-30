import SwiftUI

/// 全局状态：所属网域 + 登录令牌 + 该域下的登录方式。
/// 不加 @MainActor：@Published 的 UI 相关变更由调用方在主线程（MainActor.run / @MainActor 方法）里改。
final class AppState: ObservableObject {
    @Published var domain: String { didSet { UserDefaults.standard.set(domain, forKey: "sso_domain") } }
    @Published var token: String  { didSet { UserDefaults.standard.set(token, forKey: "sso_token") } }
    @Published var methods: [LoginMethod] = []
    @Published var meName: String = ""
    @Published var meUid: String = ""

    init() {
        // 属性观察器在 init 内赋值时不触发，这里直接从本地读回
        domain = UserDefaults.standard.string(forKey: "sso_domain") ?? ""
        token  = UserDefaults.standard.string(forKey: "sso_token") ?? ""
    }

    /// 归一化成 https://host（去尾斜杠、补协议）
    var baseURL: String { AppState.normalizeBase(domain) }
    var hasDomain: Bool { !domain.isEmpty }
    var isLoggedIn: Bool { !token.isEmpty }

    func api() -> APIClient { APIClient(base: baseURL) }

    func logout() {
        token = ""
        meName = ""
        meUid = ""
    }

    /// 换个网域：清空令牌 + 域名 + 登录方式，回到首屏
    func resetDomain() {
        token = ""
        domain = ""
        methods = []
        meName = ""
        meUid = ""
    }

    /// qwqsso://login?token=xxx 深链回跳（第三方/网页登录完成后唤起 App）
    func handleDeepLink(_ url: URL) {
        guard url.scheme == "qwqsso" else { return }
        let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        if let t = comps?.queryItems?.first(where: { $0.name == "token" })?.value, !t.isEmpty {
            token = t
        }
    }

    static func normalizeBase(_ d: String) -> String {
        var s = d.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return "" }
        if !s.hasPrefix("http://") && !s.hasPrefix("https://") { s = "https://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
}
