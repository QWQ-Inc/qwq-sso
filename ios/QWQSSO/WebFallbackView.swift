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
        let wv = WKWebView()
        // UA 加 "QWQSSOApp" 标记：网页据此知道「在 App 内」，登录成功后跳 qwqsso:// 回 App，且不再套娃触发深链
        wv.configuration.applicationNameForUserAgent = "QWQSSOApp"
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
