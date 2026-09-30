import SwiftUI
import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// 备忘录 新建/编辑（原生）：标题/正文/标签 + 附件（上传图片/文件/链接、查看、删除）+ 转交 + 删除。
struct MemoEditView: View {
    let memoId: String?          // nil = 新建
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var noteBody = ""
    @State private var tags = ""
    @State private var attachments: [[String: Any]] = []
    @State private var loading = false
    @State private var saving = false
    @State private var transferAccount = ""
    @State private var err: String?
    @State private var previewImage: IdentifiableImage?
    // 附件上传
    @State private var photoItem: PhotosPickerItem?
    @State private var showFileImporter = false
    @State private var showLinkAlert = false
    @State private var linkUrl = ""
    @State private var linkLabel = ""
    @State private var uploading = false

    var isNew: Bool { memoId == nil }

    var bodyView: some View {
        Form {
            Section("内容") {
                TextField("标题", text: $title)
                ZStack(alignment: .topLeading) {
                    if noteBody.isEmpty { Text("正文…").foregroundColor(.secondary).padding(.top, 8).padding(.leading, 4) }
                    TextEditor(text: $noteBody).frame(minHeight: 140)
                }
                TextField("标签（逗号分隔）", text: $tags)
            }

            if !isNew {
                Section("附件") {
                    if attachments.isEmpty { Text("无附件").foregroundColor(.secondary) }
                    ForEach(attachments.indices, id: \.self) { i in attachmentRow(attachments[i]) }
                        .onDelete { idx in idx.map { (attachments[$0]["id"] as? String) ?? "" }.filter { !$0.isEmpty }.forEach(deleteAttachment) }
                    PhotosPicker(selection: $photoItem, matching: .images) { Label("添加图片", systemImage: "photo") }
                    Button { showFileImporter = true } label: { Label("添加文件", systemImage: "doc") }
                    Button { linkUrl = ""; linkLabel = ""; showLinkAlert = true } label: { Label("添加链接", systemImage: "link") }
                    if uploading { HStack { ProgressView(); Text("上传中…").font(.caption).foregroundColor(.secondary) } }
                }
                Section("转交给其他用户") {
                    HStack {
                        TextField("对方 邮箱/手机/UID/用户名", text: $transferAccount)
                            .autocorrectionDisabled(true).textInputAutocapitalization(.never)
                        Button("转交") { doTransfer() }.disabled(transferAccount.isEmpty || saving)
                    }
                    Text("转交后这条备忘录归对方所有，你不再拥有。").font(.caption2).foregroundColor(.secondary)
                }
            }

            if let err = err { Text(err).foregroundColor(.red).font(.footnote) }
        }
    }

    var body: some View {
        NavigationStack {
            bodyView
                .navigationTitle(isNew ? "新建备忘录" : "备忘录")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) { Button("取消") { dismiss() } }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button(saving ? "保存中…" : "保存") { save() }.disabled(saving)
                    }
                    if !isNew {
                        ToolbarItem(placement: .bottomBar) {
                            Button(role: .destructive) { doDelete() } label: { Label("删除", systemImage: "trash") }
                        }
                    }
                }
                .task { await load() }
                .sheet(item: $previewImage) { img in
                    ImagePreview(image: img.image)
                }
                .onChange(of: photoItem) { _ in handlePhoto() }
                .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.pdf, .image, .plainText, .commaSeparatedText, .item], allowsMultipleSelection: false) { result in
                    handleFile(result)
                }
                .alert("添加链接", isPresented: $showLinkAlert) {
                    TextField("链接地址 https://…", text: $linkUrl)
                    TextField("显示名（可选）", text: $linkLabel)
                    Button("添加") { addLink() }
                    Button("取消", role: .cancel) {}
                } message: { Text("默认仅允许白名单内网域；站内相对链接 /xxx 也可") }
        }
    }

    // ── 附件上传/删除 ──
    private func handlePhoto() {
        guard let item = photoItem, let id = memoId else { return }
        Task {
            if let data = try? await item.loadTransferable(type: Data.self),
               let ui = UIImage(data: data),
               let jpg = ui.jpegData(compressionQuality: 0.9) {
                await upload(id: id, filename: "photo_\(Int(Date().timeIntervalSince1970)).jpg", data: jpg)
            }
            await MainActor.run { photoItem = nil }
        }
    }
    private func handleFile(_ result: Result<[URL], Error>) {
        guard let id = memoId, case .success(let urls) = result, let url = urls.first else { return }
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return }
        let name = url.lastPathComponent
        Task { await upload(id: id, filename: name, data: data) }
    }
    private func addLink() {
        guard let id = memoId, !linkUrl.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        Task {
            do { try await state.api().memoAddLink(memoId: id, url: linkUrl.trimmingCharacters(in: .whitespaces), label: linkLabel.trimmingCharacters(in: .whitespaces), token: state.token); await load() }
            catch { await MainActor.run { err = error.localizedDescription } }
        }
    }
    @MainActor private func upload(id: String, filename: String, data: Data) async {
        uploading = true; err = nil
        do { try await state.api().memoUpload(memoId: id, filename: filename, data: data, token: state.token); await load() }
        catch { err = error.localizedDescription }
        uploading = false
    }
    private func deleteAttachment(_ aid: String) {
        guard let id = memoId else { return }
        Task { try? await state.api().memoDeleteAttachment(memoId: id, aid: aid, token: state.token); await load() }
    }

    @ViewBuilder
    private func attachmentRow(_ a: [String: Any]) -> some View {
        let kind = (a["kind"] as? String) ?? "file"
        let name = (a["filename"] as? String) ?? "附件"
        let aid = (a["id"] as? String) ?? ""
        if kind == "link" {
            if let u = a["url"] as? String, let url = URL(string: u) {
                Link(destination: url) { Label(name.isEmpty ? u : name, systemImage: "link") }
            } else { Label(name, systemImage: "link") }
        } else if kind == "image" {
            Button { openImage(aid) } label: { Label(name, systemImage: "photo") }
        } else {
            Label(name, systemImage: "doc").foregroundColor(.secondary)
        }
    }

    private func openImage(_ aid: String) {
        guard let mid = memoId, !aid.isEmpty else { return }
        Task {
            if let d = try? await state.api().attachmentData(memoId: mid, aid: aid, token: state.token),
               let ui = UIImage(data: d) {
                await MainActor.run { previewImage = IdentifiableImage(image: ui) }
            }
        }
    }

    private func load() async {
        guard let id = memoId else { return }
        loading = true
        if let m = try? await state.api().memoGet(id: id, token: state.token) {
            await MainActor.run {
                title = (m["title"] as? String) ?? ""
                noteBody = (m["body"] as? String) ?? ""
                tags = ((m["tags"] as? [String]) ?? []).joined(separator: ", ")
                attachments = (m["attachments"] as? [[String: Any]]) ?? []
                loading = false
            }
        } else { await MainActor.run { loading = false } }
    }

    private func save() {
        if title.trimmingCharacters(in: .whitespaces).isEmpty && noteBody.trimmingCharacters(in: .whitespaces).isEmpty {
            err = "标题和内容不能都为空"; return
        }
        saving = true; err = nil
        Task {
            do {
                if let id = memoId { try await state.api().memoUpdate(id: id, title: title, body: noteBody, tags: tags, token: state.token) }
                else { try await state.api().memoCreate(title: title, body: noteBody, tags: tags, token: state.token) }
                await MainActor.run { saving = false; dismiss() }
            } catch { await MainActor.run { saving = false; err = error.localizedDescription } }
        }
    }

    private func doDelete() {
        guard let id = memoId else { return }
        saving = true
        Task {
            try? await state.api().memoDelete(id: id, token: state.token)
            await MainActor.run { saving = false; dismiss() }
        }
    }

    private func doTransfer() {
        guard let id = memoId else { return }
        saving = true; err = nil
        Task {
            do {
                try await state.api().memoTransfer(id: id, account: transferAccount.trimmingCharacters(in: .whitespaces), token: state.token)
                await MainActor.run { saving = false; dismiss() }
            } catch { await MainActor.run { saving = false; err = error.localizedDescription } }
        }
    }
}

struct IdentifiableImage: Identifiable { let id = UUID(); let image: UIImage }

struct ImagePreview: View {
    let image: UIImage
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView([.horizontal, .vertical]) {
                Image(uiImage: image).resizable().scaledToFit()
            }
            .navigationTitle("图片").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button("关闭") { dismiss() } } }
        }
    }
}
