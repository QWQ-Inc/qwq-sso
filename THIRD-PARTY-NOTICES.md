# 第三方署名（Third-Party Notices）

## 控制台「清新」界面风格（v3.5.137）

控制台风格 2「清新」的视觉设计（中性灰阶、字号刻度、圆角、阴影、控件尺寸，以及按钮 /
输入 / 分段 tab / 表格 / 弹窗 / 侧栏的样式）参考自 **Zeabur 的开源设计系统**：

- https://github.com/zeabur-oss/design-system
- Copyright Zeabur Inc.，以 **Apache License, Version 2.0** 授权
- http://www.apache.org/licenses/LICENSE-2.0

本项目**没有复制其源文件**：`public/dashboard.html` 的 `html[data-skin="se"]` 样式块按该设计系统
的 token 与组件样式重新实现。Zeabur 的名称、Logo、商标与品牌色均为 Zeabur 所有，不在本参考
范围内；本风格使用的品牌主色（浅色模式草绿 `#5EA33A`）是本项目自有配色。

字体：Geist 与 Geist Mono（Vercel，SIL Open Font License 1.1）未随仓库打包，由页面以
Google Fonts `<link>` 按需加载，命中不到时回落系统字体（含 PingFang SC / Microsoft YaHei）。
