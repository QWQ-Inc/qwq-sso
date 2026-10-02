import SwiftUI
import UIKit
import WebKit

/// WKWebView 兜底：App 原生流程不支持（或用户选「网页登录」）时，在内嵌浏览器里用网页版。
/// 网页登录成功后会跳 qwqsso://login?token=...，这里拦截该导航、取出 token 回调、关闭页面。
struct WebFallbackView: View {
    let url: String
    var onToken: ((String) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            WebView(url: url) { deepURL in
                let items = URLComponents(url: deepURL, resolvingAgainstBaseURL: false)?.queryItems ?? []
                if let t = items.first(where: { $0.name == "token" })?.value, !t.isEmpty {
                    onToken?(t)
                }
                dismiss()
            }
            .ignoresSafeArea(edges: .bottom)
            .navigationTitle("网页")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }
}

struct WebView: UIViewRepresentable {
    let url: String
    var onDeepLink: ((URL) -> Void)? = nil

    func makeCoordinator() -> Coordinator { Coordinator(onDeepLink: onDeepLink) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // ⚠️ 必须在创建 WKWebView 之前设到 configuration 上——之前设在 wv.configuration（创建后）不生效，
        // 导致网页 UA 里没有 QWQSSOApp、误以为是普通手机浏览器 → 触发 qwqsso:// 深链 → 被 nav 代理拦截并关页（表现为「一打开就被弹回」）。
        config.applicationNameForUserAgent = "QWQSSOApp"
        // 每次打开都用干净会话，避免残留 token 让登录页在加载时就自动跳回 App
        config.websiteDataStore = .nonPersistent()
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = context.coordinator
        if let u = URL(string: url) { wv.load(URLRequest(url: u)) }
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let onDeepLink: ((URL) -> Void)?
        init(onDeepLink: ((URL) -> Void)?) { self.onDeepLink = onDeepLink }

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let u = navigationAction.request.url, u.scheme == "qwqsso" {
                onDeepLink?(u)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }
    }
}
