import SwiftUI

/// 多系统/多网域切换：列出已添加的系统，点选切换、左滑删除、或添加新系统。
struct SystemSwitcherView: View {
    @EnvironmentObject var state: AppState
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("我的系统") {
                    ForEach(state.accounts) { a in
                        Button {
                            state.switchTo(a.id)
                            dismiss()
                        } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(a.name.isEmpty ? a.domain : a.name)
                                        .foregroundColor(.primary)
                                    Text(a.domain + (a.token.isEmpty ? " · 未登录" : ""))
                                        .font(.caption).foregroundColor(.secondary)
                                }
                                Spacer()
                                if a.id == state.currentId {
                                    Image(systemName: "checkmark").foregroundColor(.accentColor)
                                }
                            }
                        }
                    }
                    .onDelete { idxSet in
                        idxSet.map { state.accounts[$0].id }.forEach { state.removeSystem($0) }
                    }
                }
                Section {
                    Button {
                        dismiss()
                        state.showAddSystem = true
                    } label: {
                        Label("添加系统", systemImage: "plus.circle")
                    }
                }
            }
            .navigationTitle("切换系统")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) { Button("完成") { dismiss() } }
                ToolbarItem(placement: .navigationBarLeading) { EditButton() }
            }
        }
    }
}
