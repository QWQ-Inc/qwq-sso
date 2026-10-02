import Foundation

/// 登录方式（来自 GET /api/public/login-methods 的 methods 数组）
struct LoginMethod: Identifiable {
    let id = UUID()
    let platform: String       // wechat / feishu / google ...
    let instanceId: String?    // 额外主体的实例 id；默认主体为 nil
    let label: String          // 主体名（如「A公司」），默认主体为空

    /// 平台中文名（login-methods 不下发平台名，客户端本地映射）
    var platformName: String { LoginMethod.names[platform] ?? platform }

    /// 展示名：有主体名则「平台 · 主体名」
    var displayName: String { label.isEmpty ? platformName : "\(platformName) · \(label)" }

    /// 授权入口路径：/auth/<平台>[?inst=<实例id>]
    var authPath: String {
        var p = "/auth/\(platform)"
        if let inst = instanceId, !inst.isEmpty { p += "?inst=\(inst)" }
        return p
    }

    static let names: [String: String] = [
        "wechat": "微信", "wecom": "企业微信", "feishu": "飞书", "dingtalk": "钉钉",
        "douyin": "抖音", "kuaishou": "快手", "xiaohongshu": "小红书", "bilibili": "哔哩哔哩",
        "qq": "QQ", "google": "Google", "apple": "Apple", "github": "GitHub", "microsoft": "Microsoft"
    ]

    static func from(_ dict: [String: Any]) -> LoginMethod? {
        guard let platform = dict["platform"] as? String else { return nil }
        let inst = dict["instance_id"] as? String
        let label = (dict["label"] as? String) ?? ""
        return LoginMethod(platform: platform, instanceId: inst, label: label)
    }
}
