import SwiftUI

struct AnnouncementRef: Identifiable {
    let id: String
    let title: String
    let content: String
    let level: String
    let link: String?
}

/// 公告详情（原生）：渲染富文本 HTML + 「我知道了」标记已读。
struct AnnouncementDetailView: View {
    let ann: AnnouncementRef
    var onRead: () -> Void
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(ann.title).font(.title3).bold()
                    Text(AnnouncementDetailView.htmlToAttributed(ann.content))
                        .font(.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let l = ann.link, let u = URL(string: l) {
                        Link("查看详情", destination: u)
                    }
                }.padding(20)
            }
            .navigationTitle("公告").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("我知道了") {
                        Task { try? await state.api().announcementRead(id: ann.id, token: state.token); onRead() }
                        dismiss()
                    }
                }
            }
        }
    }

    /// 富文本 HTML → AttributedString（主线程解析；内容已服务端净化）
    static func htmlToAttributed(_ html: String) -> AttributedString {
        guard let data = html.data(using: .utf8) else { return AttributedString(html) }
        if let ns = try? NSAttributedString(
            data: data,
            options: [.documentType: NSAttributedString.DocumentType.html,
                      .characterEncoding: String.Encoding.utf8.rawValue],
            documentAttributes: nil),
           let a = try? AttributedString(ns) {
            return a
        }
        return AttributedString(html)
    }

    static func from(_ d: [String: Any]) -> AnnouncementRef {
        AnnouncementRef(
            id: (d["id"] as? String) ?? "",
            title: (d["title"] as? String) ?? "公告",
            content: (d["content"] as? String) ?? "",
            level: (d["level"] as? String) ?? "info",
            link: d["link"] as? String
        )
    }
}
