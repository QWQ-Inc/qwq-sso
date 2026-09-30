import SwiftUI
import UIKit

/// 备忘录 新建/编辑（原生）：标题/正文/标签 + 附件查看 + 转交 + 删除。
/// 附件的上传/新增暂走网页端；这里可查看（图片内联、其余显示名称/链接）。
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
                    Text("新增附件请在网页端备忘录里操作").font(.caption2).foregroundColor(.secondary)
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
        }
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
