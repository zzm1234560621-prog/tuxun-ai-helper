# 图寻 AI 助手 / 图寻答案助手

图寻（[tuxun.fun](https://tuxun.fun/)）的两个浏览器扩展，Windows / macOS 的 Chrome、Edge 都能用。

| 目录 | 是什么 |
| --- | --- |
| [`tuxun-ai-helper/`](tuxun-ai-helper/) | **完整版**：AI（DeepSeek）看街景猜位置、对战计分、AI 代打、直接答案、分步排除地图动画 |
| [`tuxun-answer/`](tuxun-answer/) | **独立答案版**：只读当前街景的真实坐标并显示国家，可缩放小地图 + 自动打点，不需要 AI |

## 安装（免构建）

1. 下载本仓库（Code → Download ZIP）并解压
2. 打开 `edge://extensions/`（Chrome 是 `chrome://extensions`），开启右上角「开发人员模式 / Developer mode」
3. 点「加载解压缩的扩展 / Load unpacked」，选择 `tuxun-ai-helper` 或 `tuxun-answer` 文件夹（能看到 `manifest.json` 的那一层）
4. macOS 的 Chrome/Edge 步骤完全一样；不支持 Safari / Firefox

## 快速使用

- **完整版**：进游戏 → 点工具栏扩展图标（授权截图）→ 悬浮窗里点「让 DeepSeek 看图猜位置」；或在「设置」里填自己的 DeepSeek API Key（本仓库不含任何 Key）
- **独立答案版**：进游戏后右上角小面板直接显示国家 + 坐标，可一键打点

两个扩展互不冲突，可以同时装。

## 说明

- 这是个人学习/研究用的工具，不保证长期可用；图寻改版后可能需要更新。
- 「直接答案」类功能是读取游戏数据里的真实坐标，属于作弊性质；使用风险自负，请遵守图寻的规则。
- 扩展不会把数据发往任何第三方服务器；完整版只把你截的图发给你自己配置的 DeepSeek API。

## 目录结构

```
tuxun-ai-helper/   完整版扩展
  manifest.json
  src/             hook.js（页面主世界钩子）、content.js（悬浮窗）、background.js（截图 + AI 调用）、
                   map-anim.js（地图动画）、world-data.js（国家数据）、geo-meta.js（线索库）
  icons/
tuxun-answer/      独立答案版扩展
  manifest.json
  src/             hook.js、answer.js（面板）、map-anim.js、world-data.js
  icons/
```
