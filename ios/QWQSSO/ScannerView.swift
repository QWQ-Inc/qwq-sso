import SwiftUI
import AVFoundation

/// 相机扫码（AVFoundation）。扫到一个二维码即回调结果并返回上一页。
struct ScannerView: View {
    let onResult: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var denied = false

    var body: some View {
        ZStack {
            if denied {
                VStack(spacing: 12) {
                    Image(systemName: "camera.fill").font(.largeTitle).foregroundColor(.secondary)
                    Text("未授权相机权限").foregroundColor(.secondary)
                    Text("请到系统设置里为本 App 开启相机").font(.footnote).foregroundColor(.secondary)
                }
            } else {
                ScannerRepresentable(onResult: { value in
                    onResult(value)
                    dismiss()
                }, onDenied: { denied = true })
                .ignoresSafeArea()

                VStack {
                    Spacer()
                    Text("将二维码放入框内").foregroundColor(.white)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Color.black.opacity(0.5)).cornerRadius(8)
                        .padding(.bottom, 60)
                }
            }
        }
        .navigationTitle("扫码")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct ScannerRepresentable: UIViewControllerRepresentable {
    let onResult: (String) -> Void
    let onDenied: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onResult: onResult) }

    func makeUIViewController(context: Context) -> ScannerVC {
        let vc = ScannerVC()
        vc.delegate = context.coordinator
        vc.onDenied = onDenied
        return vc
    }

    func updateUIViewController(_ uiViewController: ScannerVC, context: Context) {}

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let onResult: (String) -> Void
        private var handled = false
        init(onResult: @escaping (String) -> Void) { self.onResult = onResult }

        func metadataOutput(_ output: AVCaptureMetadataOutput,
                            didOutput metadataObjects: [AVMetadataObject],
                            from connection: AVCaptureConnection) {
            guard !handled,
                  let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  let value = obj.stringValue else { return }
            handled = true
            onResult(value)
        }
    }
}

final class ScannerVC: UIViewController {
    weak var delegate: AVCaptureMetadataOutputObjectsDelegate?
    var onDenied: (() -> Void)?
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            DispatchQueue.main.async {
                if granted { self?.configure() } else { self?.onDenied?() }
            }
        }
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { onDenied?(); return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { onDenied?(); return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(delegate, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        preview = layer

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning { session.stopRunning() }
    }
}
