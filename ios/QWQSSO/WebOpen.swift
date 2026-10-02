import UIKit

/// 用外部浏览器（真 Safari）打开网页，并带上登录态：
/// 经 /login-success.html?token=&next= 落地——它把 token 存进 localStorage 再跳到 next。
/// 真 Safari 里网页交互正常、Passkey 可用（WKWebView 里都不行）。
func openAuthedWeb(base: String, token: String, path: String) {
    let te = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
    let pe = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
    guard let u = URL(string: "\(base)/login-success.html?token=\(te)&next=\(pe)") else { return }
    UIApplication.shared.open(u)
}
