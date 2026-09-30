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

/// 顶层路由：无域名 → 填域名；有域名未登录 → 登录；已登录 → 首页
struct RootView: View {
    @EnvironmentObject var state: AppState

    var body: some View {
        Group {
            if !state.hasDomain {
                DomainEntryView()
            } else if !state.isLoggedIn {
                LoginView()
            } else {
                HomeView()
            }
        }
        .animation(.default, value: state.hasDomain)
        .animation(.default, value: state.isLoggedIn)
    }
}
