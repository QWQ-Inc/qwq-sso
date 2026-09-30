import Foundation

struct APIError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// 极简 REST 客户端：针对某个网域的 base（https://host）发请求。
/// 用 JSONSerialization 而非 Codable，容忍后端字段增减（骨架期更省事）。
final class APIClient {
    let base: String
    init(base: String) { self.base = base }

    private func makeURL(_ path: String) throws -> URL {
        guard let u = URL(string: base + path) else { throw APIError(message: "网址无效") }
        return u
    }

    func getJSON(_ path: String, token: String? = nil) async throws -> [String: Any] {
        var req = URLRequest(url: try makeURL(path))
        req.httpMethod = "GET"
        if let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        return try await send(req)
    }

    func postJSON(_ path: String, body: [String: Any], token: String? = nil) async throws -> [String: Any] {
        var req = URLRequest(url: try makeURL(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(req)
    }

    private func send(_ req: URLRequest) async throws -> [String: Any] {
        let (data, resp) = try await URLSession.shared.data(for: req)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if let http = resp as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            let msg = (json["error"] as? String) ?? "请求失败（HTTP \(http.statusCode)）"
            throw APIError(message: msg)
        }
        return json
    }

    // ── 具体接口封装 ──

    /// 拉该域的登录方式，同时充当「域名是否有效」的探针
    func loginMethods() async throws -> [LoginMethod] {
        let json = try await getJSON("/api/public/login-methods")
        let arr = (json["methods"] as? [[String: Any]]) ?? []
        return arr.compactMap { LoginMethod.from($0) }
    }

    /// 账号密码登录：账号可为邮箱/手机/UID/用户名
    /// 返回 (token, twofaToken)——二者只会有一个非空
    func passwordLogin(account: String, password: String) async throws -> (token: String?, twofa: String?) {
        let json = try await postJSON("/api/account/login", body: ["account": account, "password": password])
        if (json["twofa_required"] as? Bool) == true {
            return (nil, json["twofa_token"] as? String)
        }
        return (json["token"] as? String, nil)
    }

    /// 邮箱验证码：发送
    func sendEmailCode(email: String) async throws {
        _ = try await postJSON("/api/email/send-code", body: ["email": email])
    }

    /// 邮箱验证码：校验并登录/注册，返回 token（或 twofa）
    func emailCodeLogin(email: String, code: String) async throws -> (token: String?, twofa: String?) {
        let json = try await postJSON("/api/email/verify-code", body: ["email": email, "code": code])
        if (json["twofa_required"] as? Bool) == true {
            return (nil, json["twofa_token"] as? String)
        }
        return (json["token"] as? String, nil)
    }

    /// 手机验证码：发送
    func sendSmsCode(phone: String) async throws {
        _ = try await postJSON("/api/sms/send", body: ["phone": phone])
    }

    /// 手机验证码：校验并登录/注册，返回 token（或 twofa）
    func smsCodeLogin(phone: String, code: String) async throws -> (token: String?, twofa: String?) {
        let json = try await postJSON("/api/sms/verify", body: ["phone": phone, "code": code])
        if (json["twofa_required"] as? Bool) == true {
            return (nil, json["twofa_token"] as? String)
        }
        return (json["token"] as? String, nil)
    }

    /// 二段验证：动态码 / 恢复码换正式 token
    func twofaLogin(twofaToken: String, code: String) async throws -> String? {
        let json = try await postJSON("/api/2fa/login-verify", body: ["twofa_token": twofaToken, "code": code])
        return json["token"] as? String
    }

    /// 拉当前用户信息
    func me(token: String) async throws -> (name: String, uid: String) {
        let u = try await meUser(token: token)
        let name = (u["name"] as? String) ?? ""
        var uid = ""
        if let code = u["uid_code"] as? String, !code.isEmpty { uid = code }
        else if let seq = u["uid_seq"] as? Int { uid = String(format: "#%05d", seq) }
        return (name, uid)
    }

    /// 完整用户对象（积分/签到/实名等）
    func meUser(token: String) async throws -> [String: Any] {
        let json = try await getJSON("/api/user/me", token: token)
        return (json["user"] as? [String: Any]) ?? [:]
    }

    /// 签到（返回本次积分/连签/总积分；"今日已签到" 会抛 APIError）
    func checkin(token: String) async throws -> (points: Int, streak: Int, total: Int) {
        let j = try await postJSON("/api/user/checkin/v2", body: [:], token: token)
        return (j["points"] as? Int ?? 0, j["streak"] as? Int ?? 0, j["total"] as? Int ?? 0)
    }

    /// 在售商品
    func shopGoods(token: String) async throws -> [[String: Any]] {
        let j = try await getJSON("/api/shop/goods", token: token)
        return (j["goods"] as? [[String: Any]]) ?? []
    }

    /// 兑换商品（返回原始结果 json）
    func exchange(goodsId: String, token: String) async throws -> [String: Any] {
        return try await postJSON("/api/shop/exchange/\(goodsId)", body: [:], token: token)
    }

    /// 我的兑换券
    func coupons(token: String) async throws -> [[String: Any]] {
        let j = try await getJSON("/api/user/coupons", token: token)
        return (j["coupons"] as? [[String: Any]]) ?? (j["data"] as? [[String: Any]]) ?? []
    }

    // ── 备忘录 ──
    func memoList(token: String) async throws -> [[String: Any]] {
        let j = try await getJSON("/api/memos", token: token)
        return (j["memos"] as? [[String: Any]]) ?? []
    }
    func memoGet(id: String, token: String) async throws -> [String: Any] {
        let j = try await getJSON("/api/memos/\(id)", token: token)
        return (j["memo"] as? [String: Any]) ?? [:]
    }
    @discardableResult
    func memoCreate(title: String, body: String, tags: String, token: String) async throws -> String {
        let j = try await postJSON("/api/memos", body: ["title": title, "body": body, "tags": tags], token: token)
        return (j["id"] as? String) ?? ""
    }
    func memoUpdate(id: String, title: String, body: String, tags: String, token: String) async throws {
        _ = try await sendBody("PATCH", "/api/memos/\(id)", body: ["title": title, "body": body, "tags": tags], token: token)
    }
    func memoDelete(id: String, token: String) async throws {
        _ = try await sendBody("DELETE", "/api/memos/\(id)", body: nil, token: token)
    }
    func memoTransfer(id: String, account: String, token: String) async throws {
        _ = try await postJSON("/api/memos/\(id)/transfer", body: ["account": account], token: token)
    }
    /// 附件原始字节（需 Bearer，用于图片/PDF 展示）
    func attachmentData(memoId: String, aid: String, token: String) async throws -> Data {
        var req = URLRequest(url: try makeURL("/api/memos/\(memoId)/attachments/\(aid)"))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200...299).contains(http.statusCode) { throw APIError(message: "附件加载失败") }
        return data
    }

    // ── 应用市场 / 授权 / 打开 ──
    func appsMarket(token: String) async throws -> [[String: Any]] {
        let j = try await getJSON("/api/apps/market", token: token)
        return (j["apps"] as? [[String: Any]]) ?? []
    }
    func appAuthorize(id: String, token: String) async throws {
        _ = try await postJSON("/api/apps/\(id)/auth", body: [:], token: token)
    }
    func appRevoke(id: String, token: String) async throws {
        _ = try await sendBody("DELETE", "/api/apps/\(id)/auth", body: nil, token: token)
    }
    /// 打开应用（IdP 发起式）：/oauth/launch 挂在根路径（非 /api），返回要打开的 url
    func appLaunch(id: String, token: String) async throws -> String {
        let j = try await postJSON("/oauth/launch", body: ["app_id": id], token: token)
        return (j["url"] as? String) ?? ""
    }

    /// PATCH/DELETE 等带可选 body 的通用请求
    private func sendBody(_ method: String, _ path: String, body: [String: Any]?, token: String?) async throws -> [String: Any] {
        var req = URLRequest(url: try makeURL(path))
        req.httpMethod = method
        if let t = token { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        if let b = body { req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.httpBody = try JSONSerialization.data(withJSONObject: b) }
        return try await send(req)
    }
}
