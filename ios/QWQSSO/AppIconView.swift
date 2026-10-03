import SwiftUI

/// 应用图标（v3.5.28）：有上传的图片图标（icon_url，站内相对路径或 http(s)）就显示图片，否则显示 emoji + 背景色。
/// 之前 App 端应用列表完全没画图标，这里统一一个组件给应用中心 / 文件夹复用。
struct AppIconView: View {
    let app: [String: Any]
    let base: String
    var size: CGFloat = 52

    private var iconURL: URL? {
        let raw = ((app["icon_url"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
        if raw.isEmpty { return nil }
        if raw.hasPrefix("http://") || raw.hasPrefix("https://") { return URL(string: raw) }
        if raw.hasPrefix("/") && !raw.hasPrefix("//") { return URL(string: base + raw) }
        return nil
    }
    private var emoji: String {
        let e = ((app["icon"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
        return e.isEmpty ? "📦" : e
    }
    private var bg: Color { Color(hexString: (app["icon_bg"] as? String) ?? "") ?? Color(.secondarySystemBackground) }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.23, style: .continuous).fill(bg)
            if let u = iconURL {
                AsyncImage(url: u) { phase in
                    switch phase {
                    case .success(let img): img.resizable().scaledToFill()
                    case .failure: Text(emoji).font(.system(size: size * 0.5))
                    default: ProgressView()
                    }
                }
            } else {
                Text(emoji).font(.system(size: size * 0.5))
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.23, style: .continuous))
    }
}

extension Color {
    /// "#RGB" / "#RRGGBB" / "#RRGGBBAA" → Color；格式不对返回 nil
    init?(hexString: String) {
        var s = hexString.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6 || s.count == 8, let v = UInt64(s, radix: 16) else { return nil }
        let r, g, b, a: Double
        if s.count == 6 {
            r = Double((v >> 16) & 0xFF) / 255; g = Double((v >> 8) & 0xFF) / 255; b = Double(v & 0xFF) / 255; a = 1
        } else {
            r = Double((v >> 24) & 0xFF) / 255; g = Double((v >> 16) & 0xFF) / 255; b = Double((v >> 8) & 0xFF) / 255; a = Double(v & 0xFF) / 255
        }
        self.init(.sRGB, red: r, green: g, blue: b, opacity: a)
    }
}
