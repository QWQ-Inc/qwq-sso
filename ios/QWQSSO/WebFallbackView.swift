import SwiftUI
import UIKit
import WebKit

/// WKWebView 兜底：当 App 原生流程不支持（或用户选「网页登录」）时，直接在内嵌浏览器里用网页版。
struct WebFallbackView: View {
    let url: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            WebView(url: url)
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

    func makeUIView(context: Context) -> WKWebView {
        let wv = WKWebView()
        // 在 UA 里加 "QWQSSOApp" 标记，网页据此判断「已在 App 内」，避免再触发 qwqsso:// 深链导致循环
        wv.configuration.applicationNameForUserAgent = "QWQSSOApp"
        if let u = URL(string: url) { wv.load(URLRequest(url: u)) }
        return wv
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
