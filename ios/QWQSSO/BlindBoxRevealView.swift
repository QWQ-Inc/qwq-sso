import SwiftUI

struct BlindReward: Identifiable {
    let id = UUID()
    let title: String
    let detail: String
}

/// 盲盒开启动画：礼盒抖动放大 → 翻转揭晓奖励。
struct BlindBoxRevealView: View {
    let reward: BlindReward
    @Environment(\.dismiss) private var dismiss
    @State private var opened = false
    @State private var wobble = false
    @State private var showReward = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            ZStack {
                if !opened {
                    Text("🎁")
                        .font(.system(size: 110))
                        .rotationEffect(.degrees(wobble ? 8 : -8))
                        .scaleEffect(wobble ? 1.08 : 0.96)
                        .animation(.easeInOut(duration: 0.22).repeatForever(autoreverses: true), value: wobble)
                } else {
                    VStack(spacing: 12) {
                        Text("🎉").font(.system(size: 70))
                        Text(reward.title).font(.title2).bold().multilineTextAlignment(.center)
                        if !reward.detail.isEmpty {
                            Text(reward.detail).font(.headline).foregroundColor(.accentColor)
                        }
                    }
                    .scaleEffect(showReward ? 1 : 0.5)
                    .opacity(showReward ? 1 : 0)
                    .animation(.spring(response: 0.5, dampingFraction: 0.6), value: showReward)
                }
            }
            .frame(height: 220)

            Spacer()

            if !opened {
                Button(action: open) {
                    Text("开启").frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(Color.accentColor).foregroundColor(.white).cornerRadius(12)
                }
            } else {
                Button(action: { dismiss() }) {
                    Text("收下").frame(maxWidth: .infinity).padding(.vertical, 14)
                        .background(Color.accentColor).foregroundColor(.white).cornerRadius(12)
                }
            }
        }
        .padding(24)
        .onAppear { wobble = true }
        .presentationDetents([.medium])
    }

    private func open() {
        withAnimation(.easeIn(duration: 0.2)) { opened = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { showReward = true }
    }
}
