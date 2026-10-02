import UIKit
import AuthenticationServices

/// 用系统的 ASWebAuthenticationSession 打开网页登录（真 Safari 引擎 → Passkey / 第三方 OAuth 都能用）。
/// 网页登录完成后跳 qwqsso://login?token=...，会话自动捕获该回调并把 token 交回 App。
/// 相比 WKWebView：Passkey 可用、第三方 OAuth 更顺、系统自动在命中回调 scheme 时关闭并返回。
final class WebAuthLauncher: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = WebAuthLauncher()
    private var session: ASWebAuthenticationSession?

    func start(url: URL, onToken: @escaping (String) -> Void) {
        let s = ASWebAuthenticationSession(url: url, callbackURLScheme: "qwqsso") { callback, _ in
            guard let callback = callback else { return }
            let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if let t = items.first(where: { $0.name == "token" })?.value, !t.isEmpty {
                DispatchQueue.main.async { onToken(t) }
            }
        }
        s.presentationContextProvider = self
        s.prefersEphemeralWebBrowserSession = false   // 保留 Safari 会话：Passkey / 已登录更顺
        session = s
        s.start()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
        return window ?? ASPresentationAnchor()
    }
}
