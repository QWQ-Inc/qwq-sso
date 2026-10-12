import SwiftUI
import CryptoKit
import UIKit

/// 应用内 TOTP 保管库（v3.5.95，端到端口令加密）：
/// 把别的网站的 2FA（otpauth://）导进来,本机出 6 位滚动码;种子在 App 用保管库口令加密后才上传,服务器只存密文、跨设备同步。
struct VaultView: View {
    @EnvironmentObject var state: AppState

    enum Phase { case loading, create, locked, unlocked, error }
    @State private var phase: Phase = .loading
    @State private var errMsg = ""

    // 服务端元数据
    @State private var hasVault = false
    @State private var kdfSalt = ""
    @State private var verifier = ""
    @State private var kdfIter = 210000
    @State private var rawItems: [[String: Any]] = []   // {id,label,issuer,enc}

    // 内存态（解锁后）
    @State private var key: SymmetricKey?
    @State private var entries: [VaultDisplayItem] = []  // 解密后的条目
    @State private var now = Date()

    // 口令输入
    @State private var pw = ""
    @State private var pw2 = ""

    // 添加
    @State private var showAdd = false
    @State private var showReset = false
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        content
            .navigationTitle("验证器 / 2FA 保管库")
            .navigationBarTitleDisplayMode(.inline)
            .task { await load() }
            .onReceive(tick) { t in if phase == .unlocked { now = t } }
            .toolbar {
                if phase == .unlocked {
                    ToolbarItemGroup(placement: .navigationBarTrailing) {
                        Button { showAdd = true } label: { Image(systemName: "plus") }
                        Button { lock() } label: { Image(systemName: "lock.fill") }
                    }
                }
            }
            .sheet(isPresented: $showAdd) { AddTOTPSheet { raw in handleAdd(raw) } }
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case .loading: ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .error:   VStack(spacing: 10) { Text(errMsg).foregroundColor(.red); Button("重试") { Task { await load() } } }
        case .create:  createView
        case .locked:  unlockView
        case .unlocked: listView
        }
    }

    // 首次：设保管库口令
    private var createView: some View {
        Form {
            Section { Text("设一个「保管库口令」。它用来端到端加密你的 2FA 种子——服务器永远拿不到。\n⚠️ 口令忘了就无法恢复库里的 2FA,请牢记。") .font(.footnote).foregroundColor(.secondary) }
            Section {
                SecureField("保管库口令（≥8 位）", text: $pw)
                SecureField("再输一次", text: $pw2)
            }
            if !errMsg.isEmpty { Text(errMsg).foregroundColor(.red).font(.caption) }
            Section { Button("创建保管库") { doCreate() }.disabled(pw.count < 8 || pw != pw2) }
        }
    }

    // 解锁
    private var unlockView: some View {
        Form {
            Section { Text("输入保管库口令解锁。").font(.footnote).foregroundColor(.secondary) }
            Section { SecureField("保管库口令", text: $pw) }
            if !errMsg.isEmpty { Text(errMsg).foregroundColor(.red).font(.caption) }
            Section { Button("解锁") { doUnlock() }.disabled(pw.isEmpty) }
            Section { Button("忘记口令?重置保管库", role: .destructive) { showReset = true } }
                .alert("重置保管库", isPresented: $showReset) {
                    Button("重置（清空所有 2FA）", role: .destructive) { phase = .create; pw = ""; pw2 = ""; errMsg = "" }
                    Button("取消", role: .cancel) {}
                } message: { Text("端到端加密无法找回旧口令。重置会清空库里所有 2FA,再设新口令。") }
        }
    }

    // 已解锁：滚动码列表
    private var listView: some View {
        List {
            if entries.isEmpty {
                Text("还没有 2FA。点右上角「+」扫码或粘贴 otpauth:// 导入。").font(.footnote).foregroundColor(.secondary)
            }
            ForEach(entries) { it in codeRow(it) }
                .onDelete { idx in Task { await deleteAt(idx) } }
        }
    }

    @ViewBuilder private func codeRow(_ it: VaultDisplayItem) -> some View {
        let code = TOTPGen.code(it.entry, at: now)
        let left = TOTPGen.secondsRemaining(period: it.entry.period, at: now)
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(it.issuer.isEmpty ? (it.label.isEmpty ? "未命名" : it.label) : it.issuer).font(.subheadline).bold()
                if !it.label.isEmpty && !it.issuer.isEmpty { Text(it.label).font(.caption).foregroundColor(.secondary) }
                Text(code.prefix(3) + " " + code.suffix(code.count - 3))
                    .font(.system(size: 26, weight: .semibold, design: .monospaced))
                    .foregroundColor(left <= 5 ? .orange : .primary)
            }
            Spacer()
            ZStack {
                Circle().stroke(Color.secondary.opacity(0.25), lineWidth: 3).frame(width: 30, height: 30)
                Circle().trim(from: 0, to: CGFloat(left) / CGFloat(max(1, it.entry.period)))
                    .stroke(left <= 5 ? Color.orange : Color.accentColor, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90)).frame(width: 30, height: 30)
                Text("\(left)").font(.caption2)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { UIPasteboard.general.string = TOTPGen.code(it.entry, at: Date()) }
        .contextMenu {
            Button { UIPasteboard.general.string = TOTPGen.code(it.entry, at: Date()) } label: { Label("复制验证码", systemImage: "doc.on.doc") }
            Button { UIPasteboard.general.string = TOTPGen.otpauthURI(it.entry, label: it.label, issuer: it.issuer) } label: { Label("复制备份链接 (otpauth)", systemImage: "square.and.arrow.up") }
        }
    }

    // ── 逻辑 ──
    private func load() async {
        guard !state.token.isEmpty else { return }
        do {
            let j = try await state.api().getVault(token: state.token)
            await MainActor.run {
                hasVault = (j["has_vault"] as? Bool) ?? false
                kdfSalt = (j["kdf_salt"] as? String) ?? ""
                verifier = (j["verifier"] as? String) ?? ""
                kdfIter = (j["kdf_iter"] as? Int) ?? 210000
                rawItems = (j["items"] as? [[String: Any]]) ?? []
                errMsg = ""
                if key != nil { decryptItems(); phase = .unlocked }   // 已解锁:刷新列表
                else { phase = hasVault ? .locked : .create }
            }
        } catch { await MainActor.run { errMsg = error.localizedDescription; phase = .error } }
    }

    private func doCreate() {
        errMsg = ""
        let salt = VaultCrypto.randomData(16)
        let k = VaultCrypto.deriveKey(password: pw, salt: salt, iterations: kdfIter)
        guard let ver = VaultCrypto.makeVerifier(key: k) else { errMsg = "加密失败"; return }
        Task {
            do {
                if hasVault { try await state.api().vaultReset(kdfSalt: salt.base64EncodedString(), verifier: ver, kdfIter: kdfIter, token: state.token) }
                else { try await state.api().vaultInit(kdfSalt: salt.base64EncodedString(), verifier: ver, kdfIter: kdfIter, token: state.token) }
                await MainActor.run { key = k; pw = ""; pw2 = ""; entries = []; hasVault = true }
                await load()
            } catch { await MainActor.run { errMsg = error.localizedDescription } }
        }
    }

    private func doUnlock() {
        errMsg = ""
        guard let salt = Data(base64Encoded: kdfSalt) else { errMsg = "保管库数据异常"; return }
        let k = VaultCrypto.deriveKey(password: pw, salt: salt, iterations: kdfIter)
        if VaultCrypto.verify(key: k, verifier: verifier) {
            key = k; pw = ""; decryptItems(); phase = .unlocked
        } else { errMsg = "口令不正确" }
    }

    private func decryptItems() {
        guard let k = key else { entries = []; return }
        entries = rawItems.compactMap { r in
            guard let id = r["id"] as? String, let enc = r["enc"] as? String,
                  let pt = VaultCrypto.open(enc, key: k),
                  let e = try? JSONDecoder().decode(TOTPEntry.self, from: pt) else { return nil }
            return VaultDisplayItem(id: id, label: (r["label"] as? String) ?? "", issuer: (r["issuer"] as? String) ?? "", entry: e)
        }
    }

    private func lock() { key = nil; entries = []; pw = ""; phase = .locked }

    private func handleAdd(_ raw: String) {
        showAdd = false
        guard let k = key, let parsed = TOTPGen.parse(raw) else { errMsg = "无法识别的二维码/密钥"; return }
        guard let pt = try? JSONEncoder().encode(parsed.entry), let enc = VaultCrypto.seal(pt, key: k) else { return }
        Task {
            do {
                try await state.api().vaultAddItem(label: parsed.label, issuer: parsed.issuer, enc: enc, token: state.token)
                await load()
            } catch { await MainActor.run { errMsg = error.localizedDescription } }
        }
    }

    private func deleteAt(_ idx: IndexSet) async {
        for i in idx { let it = entries[i]
            try? await state.api().vaultDeleteItem(it.id, token: state.token) }
        await load()
    }
}

struct VaultDisplayItem: Identifiable {
    let id: String
    let label: String
    let issuer: String
    let entry: TOTPEntry
}

/// 添加 2FA：扫码 或 粘贴 otpauth:// / 裸 base32
struct AddTOTPSheet: View {
    let onResult: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var showScan = false
    @State private var pasted = ""

    var body: some View {
        NavigationStack {
            Form {
                Section { Button { showScan = true } label: { Label("扫描二维码", systemImage: "qrcode.viewfinder") } }
                Section("或粘贴") {
                    TextField("otpauth://... 或 base32 种子", text: $pasted, axis: .vertical).lineLimit(1...4)
                    Button("导入") { let v = pasted.trimmingCharacters(in: .whitespacesAndNewlines); if !v.isEmpty { onResult(v) } }
                        .disabled(pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Section { Text("支持别的网站导出的 2FA 二维码(otpauth://totp/...)或手动输入的密钥。种子会在本机加密后才上传。").font(.caption).foregroundColor(.secondary) }
            }
            .navigationTitle("添加 2FA")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
            .sheet(isPresented: $showScan) { NavigationStack { ScannerView { code in showScan = false; onResult(code) } } }
        }
    }
}
