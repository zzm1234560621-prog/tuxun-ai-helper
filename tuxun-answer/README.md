# 图寻答案助手（独立版）

图寻（tuxun.fun）专用的小扩展：**直接显示当前这条街景的真实位置**（也就是这一题的答案），并给出中文判断线索和小地图。

- 不需要 AI、不需要 Key、不联网（除了图寻页面自身的请求）
- 不截图、不需要截图授权
- 只用浏览器标准 API，**Windows / macOS 都能用**（Chrome、Edge）

## 功能

- **国家 + 经纬度**：读取街景对象自带的坐标，100% 准确
- **中国模式显示省份**：例如「中国 · 辽宁省」
- **可缩放小地图**：滚轮缩放、拖动平移、双击放大，点一下打开大图
- **中文线索库**：覆盖世界地图全部 175 个国家（共 208 条，含港澳台/关岛/格陵兰等扩展地区），按车牌/路桩/电线杆/建筑/植被/语言/区域/地貌分类，默认折叠
- **通用口诀**：汇总图寻/Plonk It 的通用排除顺序
- **复制坐标** 一键复制

> 本版本**不提供打点（自动选点）功能**。

## 安装（Windows：Edge / Chrome）

1. 打开 `edge://extensions/`（Chrome 是 `chrome://extensions/`）
2. 打开左下角的 **开发人员模式 / Developer mode**
3. 点 **加载解压缩的扩展 / Load unpacked**
4. 选择 `tuxun-answer` 这个文件夹（能看到 `manifest.json` 的那一层）

## 安装（macOS：Chrome / Edge）

1. 把 `tuxun-answer` 文件夹拷到 Mac
2. 打开 Chrome/Edge，地址栏输入 `chrome://extensions` 或 `edge://extensions`
3. 打开 **开发者模式**
4. 点 **加载已解压的扩展程序**，选择 `tuxun-answer` 文件夹

> 不支持 Safari / Firefox。

## 使用

1. 打开 https://tuxun.fun/ 并进入一局游戏
2. 右侧出现「图寻答案」小面板，直接显示国家/省份 + 经纬度
3. 小地图可缩放拖动，方便核对位置
4. 展开「线索库」查看这个国家的判断技巧

面板可拖动（按住标题栏），`−` 收起。

## 说明

- 这是**直接读取游戏数据**（街景对象自带的经纬度），属于作弊性质，风险自担。
- 扩展不会向任何第三方服务器发送数据。

## 目录

```
manifest.json
src/answer.js        面板逻辑（答案、小地图、线索库）
src/hook.js          页面主世界钩子（读街景坐标）
src/world-data.js    国家数据
src/extra-regions.js 补充地区（港澳/关岛等）
src/cn-provinces.js  中国省份边界
src/geo-meta.js      英文线索库（兜底）
src/geo-meta-zh.js   中文线索库（优先）
src/map-anim.js      瓦片地图渲染
icons/
```
