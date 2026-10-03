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
    func couponUse(code: String, token: String) async throws -> [String: Any] {
        try await postJSON("/api/user/coupons/\(code)/use", body: [:], token: token)
    }
    func couponDiscard(code: String, token: String) async throws {
        _ = try await postJSON("/api/user/coupons/\(code)/discard", body: [:], token: token)
    }
    func couponTransfer(code: String, toUid: String, toName: String, password: String, token: String) async throws {
        _ = try await postJSON("/api/user/coupons/\(code)/transfer", body: ["to_uid": toUid, "to_name": toName, "password": password], token: token)
    }
    /// 积分转账
    func pointsTransfer(toUid: String, toName: String, amount: Int, password: String, token: String) async throws -> [String: Any] {
        try await postJSON("/api/shop/transfer", body: ["to_uid": toUid, "to_name": toName, "amount": amount, "password": password], token: token)
    }
    /// 兑换记录
    func shopRecords(token: String) async throws -> [[String: Any]] {
        let j = try await getJSON("/api/shop/records", token: token)
        return (j["records"] as? [[String: Any]]) ?? []
    }
    /// 积分日志
    func pointsLog(token: String) async throws -> [[String: Any]] {
        let j = try await getJSON("/api/user/points-log", token: token)
        return (j["logs"] as? [[String: Any]]) ?? []
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
    /// 通用带鉴权的原始字节 GET
    func rawGet(_ path: String, token: String) async throws -> Data {
        var req = URLRequest(url: try makeURL(path))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200...299).contains(http.statusCode) { throw APIError(message: "请求失败(\(http.statusCode))") }
        return data
    }
    /// 附件原始字节（需 Bearer，用于图片/PDF 展示）
    func attachmentData(memoId: String, aid: String, token: String) async throws -> Data {
        try await rawGet("/api/memos/\(memoId)/attachments/\(aid)", token: token)
    }
    /// 上传备忘录附件（原始字节 + ?filename=）
    func memoUpload(memoId: String, filename: String, data: Data, token: String) async throws {
        let fn = filename.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? filename
        var req = URLRequest(url: try makeURL("/api/memos/\(memoId)/attachments?filename=\(fn)"))
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = data
        let (d, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            let j = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
            throw APIError(message: (j?["error"] as? String) ?? "上传失败")
        }
    }
    func memoAddLink(memoId: String, url: String, label: String, token: String) async throws {
        _ = try await postJSON("/api/memos/\(memoId)/links", body: ["url": url, "label": label], token: token)
    }
    func memoDeleteAttachment(memoId: String, aid: String, token: String) async throws {
        _ = try await sendBody("DELETE", "/api/memos/\(memoId)/attachments/\(aid)", body: nil, token: token)
    }
    /// 登录日志 CSV（导出/分享）
    func loginLogsCSV(token: String) async throws -> Data {
        try await rawGet("/api/user/login-logs/export", token: token)
    }

    // ── 应用市场 / 授权 / 打开 ──
    /// 应用市场；org 非空时只看「全局应用 + 该组织开放的应用」（须是该组织成员，v3.5.32）
    func appsMarket(token: String, org: String? = nil) async throws -> [[String: Any]] {
        var path = "/api/apps/market"
        if let o = org, !o.isEmpty, let q = o.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { path += "?org=" + q }
        let j = try await getJSON(path, token: token)
        return (j["apps"] as? [[String: Any]]) ?? []
    }
    /// 我所属的组织（id / name / org_uid）
    func myOrgs(token: String) async throws -> [[String: Any]] {
        let j = try await getJSON("/api/user/orgs", token: token)
        return (j["orgs"] as? [[String: Any]]) ?? []
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

    // ── 我的应用文件夹（v3.5.28，个人整理，不影响可见性/授权）──
    func appFolders(token: String) async throws -> [[String: Any]] {
        let j = try await getJSON("/api/user/app-folders", token: token)
        return (j["folders"] as? [[String: Any]]) ?? []
    }
    func appFolderCreate(name: String, appIds: [String], token: String) async throws {
        _ = try await postJSON("/api/user/app-folders", body: ["name": name, "app_ids": appIds], token: token)
    }
    func appFolderRename(id: String, name: String, token: String) async throws {
        _ = try await sendBody("PATCH", "/api/user/app-folders/\(id)", body: ["name": name], token: token)
    }
    func appFolderDelete(id: String, token: String) async throws {
        _ = try await sendBody("DELETE", "/api/user/app-folders/\(id)", body: nil, token: token)
    }
    /// folderId 为 nil = 移出文件夹
    func appFolderAssign(appId: String, folderId: String?, token: String) async throws {
        let body: [String: Any] = ["app_id": appId, "folder_id": folderId ?? NSNull()]
        _ = try await sendBody("PUT", "/api/user/app-folders/assign", body: body, token: token)
    }

    // ── 登录日志 ──
    func loginLogs(token: String) async throws -> (logs: [[String: Any]], windowDays: Int, canExport: Bool) {
        let j = try await getJSON("/api/user/login-logs", token: token)
        return ((j["logs"] as? [[String: Any]]) ?? [], (j["windowDays"] as? Int) ?? 30, (j["canExport"] as? Bool) ?? false)
    }

    // ── 公告 ──
    func announcementsPending(token: String) async throws -> [[String: Any]] {
        let j = try await getJSON("/api/user/announcements/pending", token: token)
        return (j["announcements"] as? [[String: Any]]) ?? []
    }
    func announcementRead(id: String, token: String) async throws {
        _ = try await postJSON("/api/user/announcements/\(id)/read", body: [:], token: token)
    }

    // ── 账号设定：改邮箱/手机 ──
    func contactSendCode(type: String, value: String, token: String) async throws {
        _ = try await postJSON("/api/user/contact/send-code", body: ["type": type, "value": value], token: token)
    }
    func contactVerify(type: String, value: String, code: String, token: String) async throws {
        _ = try await postJSON("/api/user/contact/verify", body: ["type": type, "value": value, "code": code], token: token)
    }

    // ── 账号设定：两步验证 ──
    func twofaStatus(token: String) async throws -> (enabled: Bool, recoveryLeft: Int) {
        let j = try await getJSON("/api/user/2fa/status", token: token)
        return ((j["enabled"] as? Bool) ?? false, (j["recoveryCodesLeft"] as? Int) ?? 0)
    }
    func twofaSetup(token: String) async throws -> (secret: String, otpauth: String) {
        let j = try await postJSON("/api/user/2fa/setup", body: [:], token: token)
        return ((j["secret"] as? String) ?? "", (j["otpauth"] as? String) ?? "")
    }
    func twofaEnable(secret: String, code: String, token: String) async throws -> [String] {
        let j = try await postJSON("/api/user/2fa/enable", body: ["secret": secret, "code": code], token: token)
        return (j["recoveryCodes"] as? [String]) ?? []
    }
    func twofaDisable(code: String, token: String) async throws {
        _ = try await postJSON("/api/user/2fa/disable", body: ["code": code], token: token)
    }

    // ── 关于 / 许可协议 ──
    /// 公开法律文档（key=terms|privacy）→ (title, html, link)
    func publicDocument(key: String) async throws -> (title: String, html: String, link: String) {
        let j = try await getJSON("/api/public/document/\(key)")
        return ((j["title"] as? String) ?? "", (j["content"] as? String) ?? "", (j["link"] as? String) ?? "")
    }
    /// GitHub 最新发布 tag（公开，用于「检查更新」）
    func latestTag(repo: String = "QWQ-Inc/qwq-sso") async throws -> String {
        guard let u = URL(string: "https://api.github.com/repos/\(repo)/tags?per_page=20") else { return "" }
        var req = URLRequest(url: u); req.setValue("QWQSSOApp", forHTTPHeaderField: "User-Agent")
        let (data, _) = try await URLSession.shared.data(for: req)
        guard let arr = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return "" }
        let tags = arr.compactMap { $0["name"] as? String }.filter { $0.range(of: #"^v?\d+\.\d+\.\d+"#, options: .regularExpression) != nil }
        return tags.sorted { a, b in verGt(a, b) }.first ?? ""
    }
    private func verGt(_ a: String, _ b: String) -> Bool {
        let pa = a.replacingOccurrences(of: "v", with: "").split(separator: ".").map { Int($0) ?? 0 }
        let pb = b.replacingOccurrences(of: "v", with: "").split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) { let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0; if x != y { return x > y } }
        return false
    }

    // ── 门禁 ──
    /// 出示动态开门码：返回 (code, 有效秒数)
    /// doorId 为 nil = 主码（能开有权限的所有门）；传门 id = 该门子码（v3.5.29）
    func accessQr(token: String, doorId: String? = nil) async throws -> (code: String, expiresIn: Int) {
        let body: [String: Any] = doorId.map { ["door_id": $0] } ?? [:]
        let j = try await postJSON("/api/user/access/qr", body: body, token: token)
        return ((j["code"] as? String) ?? "", (j["expires_in"] as? Int) ?? 60)
    }
    /// 我能通行的门
    func accessDoors(token: String) async throws -> [[String: Any]] {
        let j = try await getJSON("/api/user/access/doors", token: token)
        return (j["doors"] as? [[String: Any]]) ?? []
    }

    /// 通用请求（v3.5.30 应用中心管理工具用）：任意方法 + 可选 JSON body
    func request(_ method: String, _ path: String, body: [String: Any]? = nil, token: String) async throws -> [String: Any] {
        try await sendBody(method, path, body: body, token: token)
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
