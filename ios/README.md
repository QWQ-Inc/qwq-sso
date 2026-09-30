# QWQ SSO — iOS App（原生 SwiftUI 骨架）

QWQ SSO 的 iOS 客户端骨架，SwiftUI 编写，最低 iOS 16。

## 交互流程

1. **首屏填「所属网域」**（`DomainEntryView`）：输入你所属的网域（如 `qwqsso.zeabur.app`），
   App 拉取该域 `GET /api/public/login-methods` 校验并加载登录方式。
2. **登录**（`LoginView`）：
   - 账号密码（账号 = 邮箱/手机/UID/用户名，走 `POST /api/account/login`）
   - 邮箱验证码（`/api/email/send-code` + `/api/email/verify-code`）
   - 开了 2FA 会弹二段验证（`/api/2fa/login-verify`）
   - 第三方登录 / 网页登录：内嵌 `WKWebView`（`WebFallbackView`）打开该域网页流程
   - 扫码登录（`ScannerView`，AVFoundation 相机扫二维码）
3. **首页**（`HomeView`）：显示当前用户，可扫一扫、打开网页控制台、退出登录、换网域。

`qwqsso://login?token=...` 深链已在 `Info.plist` 注册并由 `AppState.handleDeepLink` 处理，
配合后端 v3.4.25「登录深链」即可让网页/第三方登录完成后回跳唤起 App。

## 本地编译（需要 macOS + Xcode）

```bash
brew install xcodegen
cd ios
xcodegen generate      # 生成 QWQSSO.xcodeproj
open QWQSSO.xcodeproj   # Xcode 里选模拟器直接 Run
```

> 工程用 [XcodeGen](https://github.com/yonaskolb/XcodeGen) 的 `project.yml` 生成，
> **不手写 `.pbxproj`**（避免手写易错、合并冲突）。改依赖/文件后重跑 `xcodegen generate`。

## 云端编译（不用 Mac）

仓库根 `.github/workflows/ios.yml`：GitHub 的 **macOS runner 自带 Xcode**，
push 到 `ios/**` 或手动触发（Actions → iOS Build → Run workflow）即在云端做**未签名**构建，
验证代码可编译。**无需任何证书、免费**。

产出可安装/上架的**已签名 .ipa**（TestFlight/真机）需要 Apple 开发者账号（个人 $99/年）的
证书 + 描述文件，存成 GitHub Secrets 后在工作流里加签名导出步骤——`ios.yml` 底部有说明。

## Bundle ID / 版本

- Bundle ID：`cn.xubainet.qwqsso`（改在 `project.yml` 的 `PRODUCT_BUNDLE_IDENTIFIER`）
- URL Scheme：`qwqsso`（`Info.plist` 的 `CFBundleURLTypes`）
- 版本：`project.yml` 的 `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`
