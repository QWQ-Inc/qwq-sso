import SwiftUI
import CoreImage.CIFilterBuiltins
import UIKit

/// 门禁（原生）：全屏出示动态开门码（像健康码）+ 我能通行的门。
/// 开门码 45 秒一次性，本页自动倒计时刷新。二维码本地用 CoreImage 生成。
struct AccessView: View {
    @EnvironmentObject var state: AppState
    @State private var qrImage: UIImage?
    @State private var left = 0
    @State private var loading = false
    @State private var err: String?
    @State private var doors: [[String: Any]] = []

    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                // 开门码卡
                VStack(spacing: 12) {
                    Text("开门码").font(.footnote).foregroundColor(.secondary)
                    ZStack {
                        RoundedRectangle(cornerRadius: 16).fill(Color.white)
                            .frame(width: 280, height: 280)
                            .shadow(color: .black.opacity(0.08), radius: 8)
                        if let img = qrImage {
                            Image(uiImage: img).interpolation(.none).resizable()
                                .frame(width: 252, height: 252)
                        } else if loading {
                            ProgressView()
                        } else {
                            Text("点下方按钮出示").font(.footnote).foregroundColor(.secondary)
                        }
                    }
                    if qrImage != nil {
                        Text("对准门口扫码机 · \(left) 秒后自动刷新")
                            .font(.caption).foregroundColor(.secondary)
                    }
                    Button(action: { Task { await refresh() } }) {
                        HStack {
                            if loading { ProgressView().tint(.white) }
                            Image(systemName: "qrcode")
                            Text(qrImage == nil ? "出示开门码" : "刷新")
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 13)
                        .background(Color.accentColor).foregroundColor(.white).cornerRadius(10)
                    }
                    .disabled(loading)
                    if let err = err { Text(err).font(.caption).foregroundColor(.red) }
                    Text("开门码 45 秒失效且一次性，截图无法复用。").font(.caption2).foregroundColor(.secondary)
                }
                .frame(maxWidth: .infinity).padding(18)
                .background(Color(.secondarySystemBackground)).cornerRadius(14)

                // 我能开的门
                VStack(alignment: .leading, spacing: 8) {
                    Text("我能通行的门").font(.footnote).foregroundColor(.secondary)
                    if doors.isEmpty {
                        Text("暂无你有权限通行的门，如需开通请联系管理员。")
                            .font(.caption).foregroundColor(.secondary)
                    } else {
                        ForEach(doors.indices, id: \.self) { i in
                            let d = doors[i]
                            HStack {
                                Image(systemName: "door.left.hand.closed").foregroundColor(.accentColor)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text((d["name"] as? String) ?? "门").font(.subheadline)
                                    if let loc = d["location"] as? String, !loc.isEmpty {
                                        Text(loc).font(.caption).foregroundColor(.secondary)
                                    }
                                }
                                Spacer()
                            }
                            .padding(12)
                            .background(Color(.secondarySystemBackground)).cornerRadius(10)
                        }
                    }
                }
            }
            .padding(20)
        }
        .navigationTitle("门禁")
        .navigationBarTitleDisplayMode(.inline)
        .task { await refresh(); await loadDoors() }
        .onReceive(timer) { _ in
            guard qrImage != nil else { return }
            if left > 0 { left -= 1 } else { Task { await refresh() } }
        }
    }

    private func refresh() async {
        guard !state.token.isEmpty else { return }
        await MainActor.run { loading = true; err = nil }
        do {
            let r = try await state.api().accessQr(token: state.token)
            let img = AccessView.makeQR(r.code)
            await MainActor.run { qrImage = img; left = r.expiresIn; loading = false }
        } catch {
            await MainActor.run { loading = false; err = error.localizedDescription }
        }
    }
    private func loadDoors() async {
        guard !state.token.isEmpty else { return }
        let list = (try? await state.api().accessDoors(token: state.token)) ?? []
        await MainActor.run { doors = list }
    }

    /// 本地用 CoreImage 生成二维码（不出端、不引第三方库）
    static func makeQR(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let out = filter.outputImage else { return nil }
        let scaled = out.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        let ctx = CIContext()
        guard let cg = ctx.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
