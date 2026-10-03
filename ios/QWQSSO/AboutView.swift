import SwiftUI
import UIKit

/// 关于 / 版本更新 / 许可协议（原生）。
struct AboutView: View {
    @EnvironmentObject var state: AppState
    @State private var latest = ""
    @State private var checking = false

    private var appVer: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        let b = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
        return b.isEmpty ? v : "\(v) (\(b))"
    }

    var body: some View {
        List {
            Section {
                HStack { Text("App 版本"); Spacer(); Text(appVer).foregroundColor(.secondary) }
                HStack { Text("当前网域"); Spacer(); Text(state.domain).foregroundColor(.secondary).font(.caption) }
                HStack {
                    Text("最新发布")
                    Spacer()
                    if checking { ProgressView() }
                    else { Text(latest.isEmpty ? "—" : latest).foregroundColor(.secondary) }
                }
                Button { Task { await check() } } label: { Label("检查更新", systemImage: "arrow.triangle.2.circlepath") }
            } footer: {
                Text("网页/云部署版本随后台发布自动更新；App 版本更新通过分发渠道获取。")
            }

            Section("许可协议") {
                NavigationLink { DocView(docKey: "terms", fallbackTitle: "服务条款") } label: { Label("服务条款", systemImage: "doc.text") }
                NavigationLink { DocView(docKey: "privacy", fallbackTitle: "隐私政策") } label: { Label("隐私政策", systemImage: "hand.raised") }
            }

            Section("链接") {
                Link(destination: URL(string: "https://qwq.us")!) { Label("官网 qwq.us", systemImage: "globe") }
                Link(destination: URL(string: "https://github.com/QWQ-Inc/qwq-sso")!) { Label("项目仓库", systemImage: "chevron.left.forwardslash.chevron.right") }
            }

            Section {
                Text("Copyright © 2026 QWQ INC.\nLicensed under MIT License")
                    .font(.caption2).foregroundColor(.secondary).frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .navigationTitle("关于")
        .task { await check() }
    }

    private func check() async {
        await MainActor.run { checking = true }
        let t = (try? await state.api().latestTag()) ?? ""
        await MainActor.run { latest = t; checking = false }
    }
}

/// 展示服务端的富文本法律文档（terms/privacy）。
struct DocView: View {
    @EnvironmentObject var state: AppState
    let docKey: String
    let fallbackTitle: String
    @State private var title = ""
    @State private var attr = AttributedString("")
    @State private var link = ""
    @State private var loading = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if loading { ProgressView().frame(maxWidth: .infinity).padding(.top, 40) }
                else {
                    Text(attr).textSelection(.enabled)
                    if let u = URL(string: link), !link.isEmpty {
                        Link("查看完整文档 ↗", destination: u).font(.footnote).padding(.top, 8)
                    }
                }
            }
            .padding(16)
        }
        .navigationTitle(title.isEmpty ? fallbackTitle : title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        do {
            let d = try await state.api().publicDocument(key: docKey)
            await MainActor.run {
                title = d.title; link = d.link
                attr = AboutView_htmlToAttr(d.html)
                loading = false
            }
        } catch { await MainActor.run { attr = AttributedString("加载失败"); loading = false } }
    }
}

/// HTML → AttributedString（复用系统 HTML 渲染）
func AboutView_htmlToAttr(_ html: String) -> AttributedString {
    guard !html.isEmpty, let data = html.data(using: .utf8),
          let ns = try? NSAttributedString(data: data,
            options: [.documentType: NSAttributedString.DocumentType.html, .characterEncoding: String.Encoding.utf8.rawValue],
            documentAttributes: nil)
    else { return AttributedString(html.isEmpty ? "（暂无内容）" : html) }
    return (try? AttributedString(ns, including: \.uiKit)) ?? AttributedString(ns.string)
}
