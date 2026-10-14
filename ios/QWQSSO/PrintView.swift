import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// 发去打印（v3.5.99 Phase 2）：列我所在组织的打印机 → 选文件/照片 + 类别/份数/双面/彩色 → 发打印；下方看任务状态。
struct PrintView: View {
    @EnvironmentObject var state: AppState
    @State private var printers: [[String: Any]] = []
    @State private var jobs: [[String: Any]] = []
    @State private var loading = false
    @State private var toast: String?
    @State private var sendPrinterId: String?

    private let statusLabel: [String: String] = [
        "pending": "排队中", "pending_approval": "⏳ 待审批", "printing": "打印中",
        "done": "✅ 已完成", "failed": "❌ 失败", "canceled": "已取消",
    ]

    var body: some View {
        List {
            Section {
                if printers.isEmpty && !loading {
                    Text("你所在组织还没有可用打印机，联系管理员登记后即可发打印。").foregroundColor(.secondary)
                }
                ForEach(printers.indices, id: \.self) { i in printerRow(printers[i]) }
            } header: { Text("可用打印机") }

            Section {
                if jobs.isEmpty { Text("暂无打印任务").foregroundColor(.secondary) }
                ForEach(jobs.indices, id: \.self) { i in jobRow(jobs[i]) }
            } header: { Text("我的打印任务") }
        }
        .navigationTitle("打印")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { await load() }
        .sheet(isPresented: Binding(get: { sendPrinterId != nil }, set: { if !$0 { sendPrinterId = nil } })) {
            if let p = printers.first(where: { ($0["id"] as? String) == sendPrinterId }) {
                PrintSendSheet(printer: p) { msg in
                    sendPrinterId = nil
                    if let m = msg { toast = m; Task { try? await Task.sleep(nanoseconds: 400_000_000); await load() } }
                }
                .environmentObject(state)
            }
        }
        .overlay(alignment: .bottom) {
            if let t = toast {
                Text(t).font(.caption).padding(8).background(.ultraThinMaterial).cornerRadius(8).padding(.bottom, 10)
                    .onAppear { DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { toast = nil } }
            }
        }
    }

    @ViewBuilder private func printerRow(_ p: [String: Any]) -> some View {
        let id = (p["id"] as? String) ?? ""
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text((p["name"] as? String) ?? "打印机").font(.headline)
                if let org = p["subject_name"] as? String, !org.isEmpty {
                    Text("· \(org)").font(.caption).foregroundColor(.secondary)
                }
                Spacer()
                Button { sendPrinterId = id } label: { Label("发去打印", systemImage: "printer") }
                    .buttonStyle(.borderedProminent).controlSize(.small)
            }
            Text([(p["color"] as? Bool ?? false) ? "彩色" : "黑白",
                  (p["duplex"] as? Bool ?? false) ? "可双面" : "单面",
                  (p["default_media"] as? String) ?? "A4"].joined(separator: " · "))
                .font(.caption).foregroundColor(.secondary)
        }.padding(.vertical, 2)
    }

    @ViewBuilder private func jobRow(_ j: [String: Any]) -> some View {
        let id = (j["id"] as? String) ?? ""
        let status = (j["status"] as? String) ?? ""
        let cancelable = status == "pending" || status == "pending_approval"
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text((j["file_name"] as? String) ?? "文件").font(.subheadline).lineLimit(1)
                if (j["watermark"] as? Bool) ?? ((j["watermark"] as? NSNumber)?.intValue == 1) { Text("🔏").font(.caption2) }
                Spacer()
                Text(statusLabel[status] ?? status).font(.caption)
                    .foregroundColor(status == "done" ? .green : (status == "failed" ? .red : .secondary))
            }
            HStack {
                Text("\((j["printer_name"] as? String) ?? "")\(((j["copies"] as? Int) ?? 1) > 1 ? " ×\((j["copies"] as? Int) ?? 1)" : "")")
                    .font(.caption2).foregroundColor(.secondary)
                if status == "failed", let r = j["result"] as? String, !r.isEmpty {
                    Text("· \(r)").font(.caption2).foregroundColor(.secondary).lineLimit(1)
                }
                Spacer()
                if cancelable {
                    Button("取消") { cancel(id) }.font(.caption2).foregroundColor(.red)
                }
            }
        }.padding(.vertical, 1)
    }

    private func cancel(_ id: String) {
        Task {
            do { try await state.api().cancelPrintJob(id, token: state.token); toast = "已取消"; await load() }
            catch { toast = (error as? APIError)?.message ?? "取消失败" }
        }
    }
    private func load() async {
        guard !state.token.isEmpty else { return }
        loading = true
        let p = (try? await state.api().userPrinters(token: state.token)) ?? []
        let j = (try? await state.api().printJobs(token: state.token)) ?? []
        await MainActor.run { printers = p; jobs = j; loading = false }
    }
}

/// 发打印弹窗：选文件/照片 + 类别/份数/双面/彩色。
struct PrintSendSheet: View {
    @EnvironmentObject var state: AppState
    let printer: [String: Any]
    var onDone: (String?) -> Void   // 传回提示文案（nil=取消）

    @Environment(\.dismiss) private var dismiss
    @State private var fileName = ""
    @State private var fileData: Data?
    @State private var photoItem: PhotosPickerItem?
    @State private var showFileImporter = false
    @State private var category = ""
    @State private var copies = 1
    @State private var duplex = false
    @State private var color = true
    @State private var sending = false
    @State private var err: String?

    private var categories: [[String: Any]] { (printer["categories"] as? [[String: Any]]) ?? [] }
    private var supportsColor: Bool { (printer["color"] as? Bool) ?? false }
    private var supportsDuplex: Bool { (printer["duplex"] as? Bool) ?? false }
    private var selectedCat: [String: Any]? { categories.first { ($0["key"] as? String) == category } }

    var body: some View {
        NavigationStack {
            Form {
                Section("文件") {
                    if fileData == nil {
                        PhotosPicker(selection: $photoItem, matching: .images) { Label("选择照片", systemImage: "photo") }
                        Button { showFileImporter = true } label: { Label("选择文件（PDF/图片/Office）", systemImage: "doc") }
                    } else {
                        HStack {
                            Image(systemName: "doc.fill").foregroundColor(.accentColor)
                            Text(fileName).lineLimit(1)
                            Spacer()
                            Button("重选") { fileData = nil; fileName = ""; photoItem = nil }.font(.caption)
                        }
                    }
                }
                if !categories.isEmpty {
                    Section("文档类别") {
                        Picker("类别", selection: $category) {
                            ForEach(categories.indices, id: \.self) { i in
                                Text((categories[i]["label"] as? String) ?? "").tag((categories[i]["key"] as? String) ?? "")
                            }
                        }
                        if let c = selectedCat {
                            let hints = [(c["watermark"] as? Bool ?? false) ? "🔏 将烧录身份水印+追踪码（仅 PDF/图片）" : "",
                                         (c["approval"] as? Bool ?? false) ? "⏳ 需组织管理员审批后才打印" : ""].filter { !$0.isEmpty }
                            if !hints.isEmpty { Text(hints.joined(separator: "\n")).font(.caption).foregroundColor(.secondary) }
                        }
                    }
                }
                Section("选项") {
                    Stepper("份数：\(copies)", value: $copies, in: 1...99)
                    if supportsDuplex { Toggle("双面", isOn: $duplex) }
                    if supportsColor { Toggle("彩色", isOn: $color) } else { Text("黑白打印机").font(.caption).foregroundColor(.secondary) }
                }
                if let e = err { Section { Text(e).foregroundColor(.red).font(.caption) } }
            }
            .navigationTitle((printer["name"] as? String) ?? "发去打印")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { onDone(nil); dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(sending ? "发送中…" : "打印") { submit() }.disabled(fileData == nil || sending)
                }
            }
            .onAppear { if category.isEmpty { category = (categories.first { ($0["is_default"] as? Bool) ?? false }?["key"] as? String) ?? (categories.first?["key"] as? String ?? "") } }
            .onChange(of: photoItem) { _ in loadPhoto() }
            .fileImporter(isPresented: $showFileImporter,
                          allowedContentTypes: [.pdf, .image, .plainText, .commaSeparatedText, UTType("org.openxmlformats.wordprocessingml.document") ?? .item, UTType("org.openxmlformats.spreadsheetml.sheet") ?? .item, .item],
                          allowsMultipleSelection: false) { result in handleFile(result) }
        }
    }

    private func loadPhoto() {
        guard let item = photoItem else { return }
        Task {
            if let data = try? await item.loadTransferable(type: Data.self),
               let ui = UIImage(data: data), let jpg = ui.jpegData(compressionQuality: 0.9) {
                await MainActor.run { fileData = jpg; fileName = "photo_\(Int(Date().timeIntervalSince1970)).jpg" }
            }
        }
    }
    private func handleFile(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result, let url = urls.first else { return }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return }
        fileData = data; fileName = url.lastPathComponent
    }
    private func submit() {
        guard let data = fileData else { return }
        sending = true; err = nil
        Task {
            do {
                let r = try await state.api().sendPrintJob(printerId: (printer["id"] as? String) ?? "", filename: fileName,
                    data: data, copies: copies, duplex: duplex, color: supportsColor ? color : false,
                    category: category.isEmpty ? nil : category, token: state.token)
                let needsApproval = (r["needs_approval"] as? Bool) ?? false
                await MainActor.run { onDone(needsApproval ? "✓ 已提交，待管理员审批" : "✓ 已发送打印"); dismiss() }
            } catch {
                await MainActor.run { err = (error as? APIError)?.message ?? "发送失败"; sending = false }
            }
        }
    }
}
