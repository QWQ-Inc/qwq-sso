import SwiftUI

@main
struct QWQSSOApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
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

    var body: some View {
        Group {
            if !state.hasAccounts {
                DomainEntryView()
            } else if !state.isLoggedIn {
                LoginView()
            } else {
                HomeView()
            }
        }
        .animation(.default, value: state.hasAccounts)
        .animation(.default, value: state.isLoggedIn)
        .animation(.default, value: state.currentId)
        // 从「切换系统」里点「添加系统」→ 弹网域输入
        .sheet(isPresented: $state.showAddSystem) { DomainEntryView(asSheet: true) }
    }
}
