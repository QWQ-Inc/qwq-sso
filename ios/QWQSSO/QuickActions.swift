import SwiftUI
import UIKit

/// 主屏幕快捷操作（长按 App 图标，v3.5.34）：「出示开门码」一步直达门禁码。
/// 静态条目写在 Info.plist 的 UIApplicationShortcutItems；这里只负责把点了哪一项交给 SwiftUI。
/// - 冷启动：系统把 shortcutItem 放在场景连接参数里 → AppDelegate 取出
/// - 热启动：系统回调 SceneDelegate.windowScene(_:performActionFor:)
/// 未登录时先记着，登录完成后再弹出（RootView 只在已登录时消费）。
final class ShortcutRouter: ObservableObject {
    static let shared = ShortcutRouter()
    static let accessQR = "cn.xubainet.qwqsso.accessqr"
    @Published var pending: String?
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        if let item = options.shortcutItem { ShortcutRouter.shared.pending = item.type }
        let config = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
    // 兜底：万一按非场景生命周期运行，系统走这里
    func application(_ application: UIApplication, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        ShortcutRouter.shared.pending = shortcutItem.type
        completionHandler(true)
    }
}

final class SceneDelegate: NSObject, UIWindowSceneDelegate {
    func windowScene(_ windowScene: UIWindowScene,
                     performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        ShortcutRouter.shared.pending = shortcutItem.type
        completionHandler(true)
    }
}

/// 快捷操作打开的全屏门禁码（带「完成」按钮）
struct QuickAccessSheet: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            AccessView()
                .toolbar {
                    ToolbarItem(placement: .navigationBarTrailing) { Button("完成") { dismiss() } }
                }
        }
    }
}
