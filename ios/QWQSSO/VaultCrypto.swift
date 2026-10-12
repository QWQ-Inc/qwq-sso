import Foundation
import CryptoKit
import CommonCrypto

/// 应用内 TOTP 保管库（v3.5.95）：端到端加密 + TOTP 出码。
/// 口令派生密钥(PBKDF2-HMAC-SHA256) → AES-GCM 加密每条种子;服务器只拿到密文。
enum VaultCrypto {
    static let VERIFIER_PLAINTEXT = "QWQ-VAULT-OK"

    /// PBKDF2-HMAC-SHA256 → 32 字节密钥
    static func deriveKey(password: String, salt: Data, iterations: Int) -> SymmetricKey {
        var out = [UInt8](repeating: 0, count: 32)
        let pwData = Data(password.utf8)
        let saltBytes = [UInt8](salt)
        pwData.withUnsafeBytes { (pwRaw: UnsafeRawBufferPointer) in
            // 把 UInt8 内存重绑为 Int8（CChar），匹配 CCKeyDerivationPBKDF 的 const char* 入参
            let pwPtr = pwRaw.bindMemory(to: Int8.self).baseAddress
            saltBytes.withUnsafeBufferPointer { saltBuf in
                _ = CCKeyDerivationPBKDF(
                    CCPBKDFAlgorithm(kCCPBKDF2),
                    pwPtr, pwData.count,
                    saltBuf.baseAddress, saltBuf.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                    UInt32(iterations),
                    &out, out.count)
            }
        }
        return SymmetricKey(data: Data(out))
    }

    /// 随机字节（用 CryptoKit 生成,避免引 Security 框架）
    static func randomData(_ n: Int) -> Data {
        let k = SymmetricKey(size: SymmetricKeySize(bitCount: max(8, n * 8)))
        return k.withUnsafeBytes { Data(Array($0.prefix(n))) }
    }

    /// 加密 → base64(nonce+ct+tag)
    static func seal(_ plaintext: Data, key: SymmetricKey) -> String? {
        guard let box = try? AES.GCM.seal(plaintext, using: key), let comb = box.combined else { return nil }
        return comb.base64EncodedString()
    }
    /// 解密 base64(nonce+ct+tag) → 明文;口令错/密文坏返回 nil
    static func open(_ b64: String, key: SymmetricKey) -> Data? {
        guard let comb = Data(base64Encoded: b64), let box = try? AES.GCM.SealedBox(combined: comb) else { return nil }
        return try? AES.GCM.open(box, using: key)
    }

    /// 校验口令是否正确：能解出 verifier 且等于已知串
    static func verify(key: SymmetricKey, verifier: String) -> Bool {
        guard let d = open(verifier, key: key) else { return false }
        return String(data: d, encoding: .utf8) == VERIFIER_PLAINTEXT
    }
    static func makeVerifier(key: SymmetricKey) -> String? {
        seal(Data(VERIFIER_PLAINTEXT.utf8), key: key)
    }
}

/// 一条 2FA 的明文参数（加密存进 enc）
struct TOTPEntry: Codable {
    var secret: String       // base32
    var digits: Int = 6
    var period: Int = 30
    var algo: String = "SHA1"
}

enum TOTPGen {
    /// base32 解码（RFC4648，大写，忽略空格/填充）
    static func base32Decode(_ s: String) -> Data? {
        let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        var map = [Character: UInt8]()
        for (i, c) in alphabet.enumerated() { map[c] = UInt8(i) }
        let cleaned = s.uppercased().replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "=", with: "")
        var bits = 0, value = 0
        var out = [UInt8]()
        for ch in cleaned {
            guard let v = map[ch] else { return nil }
            value = (value << 5) | Int(v); bits += 5
            if bits >= 8 { out.append(UInt8((value >> (bits - 8)) & 0xff)); bits -= 8 }
        }
        return out.isEmpty ? nil : Data(out)
    }

    /// 计算当前 TOTP 码
    static func code(_ e: TOTPEntry, at: Date = Date()) -> String {
        guard let key = base32Decode(e.secret) else { return String(repeating: "-", count: e.digits) }
        var counter = UInt64(floor(at.timeIntervalSince1970 / Double(max(1, e.period)))).bigEndian
        let counterData = withUnsafeBytes(of: &counter) { Data($0) }
        let sk = SymmetricKey(data: key)
        let mac: Data
        switch e.algo.uppercased() {
        case "SHA256": mac = Data(HMAC<SHA256>.authenticationCode(for: counterData, using: sk))
        case "SHA512": mac = Data(HMAC<SHA512>.authenticationCode(for: counterData, using: sk))
        default:       mac = Data(HMAC<Insecure.SHA1>.authenticationCode(for: counterData, using: sk))
        }
        let offset = Int(mac[mac.count - 1] & 0x0f)
        let binary = (UInt32(mac[offset] & 0x7f) << 24) | (UInt32(mac[offset + 1]) << 16)
                   | (UInt32(mac[offset + 2]) << 8) | UInt32(mac[offset + 3])
        let mod = UInt32(pow(10.0, Double(e.digits)))
        return String(format: "%0\(e.digits)d", binary % mod)
    }

    /// 还原成 otpauth:// 链接（备份/迁移到别的验证器用）
    static func otpauthURI(_ e: TOTPEntry, label: String, issuer: String) -> String {
        func enc(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? s }
        let acct = label.isEmpty ? (issuer.isEmpty ? "account" : issuer) : label
        let path = issuer.isEmpty ? enc(acct) : "\(enc(issuer)):\(enc(acct))"
        var q = "secret=\(e.secret)&algorithm=\(e.algo)&digits=\(e.digits)&period=\(e.period)"
        if !issuer.isEmpty { q += "&issuer=\(enc(issuer))" }
        return "otpauth://totp/\(path)?\(q)"
    }

    /// 剩余秒数（下一次刷新倒计时）
    static func secondsRemaining(period: Int, at: Date = Date()) -> Int {
        let p = max(1, period)
        return p - Int(at.timeIntervalSince1970.truncatingRemainder(dividingBy: Double(p)))
    }

    /// 解析 otpauth:// URI 或裸 base32 → (entry, label, issuer)
    static func parse(_ raw: String) -> (entry: TOTPEntry, label: String, issuer: String)? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URLComponents(string: s), url.scheme?.lowercased() == "otpauth", url.host?.lowercased() == "totp" {
            let q = Dictionary(uniqueKeysWithValues: (url.queryItems ?? []).map { ($0.name.lowercased(), $0.value ?? "") })
            guard let secret = q["secret"], !secret.isEmpty else { return nil }
            var label = url.path
            if label.hasPrefix("/") { label.removeFirst() }
            label = label.removingPercentEncoding ?? label
            var issuer = q["issuer"] ?? ""
            // label 常是 "Issuer:account",拆出 issuer
            if issuer.isEmpty, let idx = label.firstIndex(of: ":") { issuer = String(label[..<idx]) }
            if let idx = label.firstIndex(of: ":") { label = String(label[label.index(after: idx)...]) }
            var e = TOTPEntry(secret: secret)
            if let d = q["digits"], let dv = Int(d) { e.digits = min(max(dv, 6), 8) }
            if let p = q["period"], let pv = Int(p) { e.period = max(pv, 10) }
            if let a = q["algorithm"], !a.isEmpty { e.algo = a }
            return (e, label, issuer)
        }
        // 裸 base32 种子
        let bare = s.replacingOccurrences(of: " ", with: "")
        if base32Decode(bare) != nil { return (TOTPEntry(secret: bare), "", "") }
        return nil
    }
}
