import SwiftUI

@main
struct QWQSSOApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate   // 主屏幕快捷操作（v3.5.34）
    @StateObject private var state = AppState()
    @StateObject private var shortcuts = ShortcutRouter.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .environmentObject(shortcuts)
                // 深链回跳：qwqsso://login?token=... （配合后端 v3.4.25 登录深链）
                .onOpenURL { url in
                    state.handleDeepLink(url)
                }
        }
    }
}

/// 顶层路由：无任何系统 → 填网域；当前系统未登录 → 登录；已登录 → 首页
struct RootView: View {
    @EnvironmentObject var state: AppState
    @EnvironmentObject var shortcuts: ShortcutRouter

    /// 快捷操作「出示开门码」：只在已登录时弹；未登录先挂着，登录后自动弹出
    private var showQuickAccess: Binding<Bool> {
        Binding(get: { state.isLoggedIn && shortcuts.pending == ShortcutRouter.accessQR },
                set: { if !$0 { shortcuts.pending = nil } })
    }

    var body: some View {
        Group {
            if !state.hasAccounts {
                DomainEntryView()
            } else if !state.isLoggedIn {
                LoginView()
            } else {
                MainTabView()
            }
        }
        .animation(.default, value: state.hasAccounts)
        .animation(.default, value: state.isLoggedIn)
        .animation(.default, value: state.currentId)
        // 从「切换系统」里点「添加系统」→ 弹网域输入
        .sheet(isPresented: $state.showAddSystem) { DomainEntryView(asSheet: true) }
        .fullScreenCover(isPresented: showQuickAccess) { QuickAccessSheet().environmentObject(state) }
    }
}
