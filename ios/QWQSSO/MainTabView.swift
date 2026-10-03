import SwiftUI

/// 登录后的原生主界面：底部分页。逐步把用户端功能原生化（先 首页/商城/我的）。
struct MainTabView: View {
    var body: some View {
        TabView {
            HomeTabView()
                .tabItem { Label("首页", systemImage: "house") }
            ShopTabView()
                .tabItem { Label("积分商城", systemImage: "bag") }
            MemoTabView()
                .tabItem { Label("备忘录", systemImage: "note.text") }
            AppsTabView()
                .tabItem { Label("应用", systemImage: "square.grid.2x2") }
            MeTabView()
                .tabItem { Label("我的", systemImage: "person.crop.circle") }
        }
    }
}
