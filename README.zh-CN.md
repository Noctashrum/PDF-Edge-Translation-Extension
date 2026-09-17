# PDF 划词翻译 · Edge 扩展

[English](README.md) | **简体中文**

在 Edge 里读 PDF 时，**鼠标选中一个英文单词 → 出现蓝色「译」按钮 → 点一下 → 显示中文释义**（词性、音标、发音、词形变化、短语、双语例句）。

![PDF 划词翻译效果](docs/screenshot-pdf.png)

---

## 1. 安装（1 分钟）

1. 打开 Edge，地址栏输入 `edge://extensions/` 回车；
2. 打开左下角 **开发人员模式**；
3. 点 **加载解压缩的扩展**，选择本项目的 `extension` 目录（或把 `dist/pdf-huaci-translator-1.2.0.zip` 解压后选那个目录）；
4. 装好后会自动打开一次设置页，看完关掉即可。工具栏出现蓝色图标就成功了。

> 可选：如果你要看**本地磁盘上的 PDF**（`file:///D:/xxx.pdf`），需要在 `edge://extensions/` 里点本扩展的「详细信息」，打开 **允许访问文件 URL**。

如果你是从 git 克隆的仓库，`extension/vendor/`（pdf.js 资源）与 `extension/icons/`（图标）**不在仓库里**（见 `.gitignore`），先跑一次构建再加载：

```bash
npm run build    # 下载 pdf.js 资源 + 生成图标 + 校验 pdf.js core/组件包接口契约
npm run pack     # 可选：打成 dist/pdf-huaci-translator-<版本>.zip
npm test         # 可选：翻译层单测 + 真机端到端测试
```

---

## 2. 怎么用

| 场景 | 操作 |
| --- | --- |
| 读 PDF | 打开任意 PDF（自动由本扩展的阅读器渲染）→ 选中英文单词 → 点「译」 |
| 精确选词 | 在 PDF 里**双击**单词即可选中（和 Edge 原生阅读器一致） |
| **选不全 / 想改词** | 卡片最上面那段文字**可以直接编辑**，改完按回车（或点「翻译」）重译；也可以点 **扩选整行 / 扩选整段** 让它自动把漏掉的部分补回来，**还原** 回到鼠标选中的原文 |
| **多开 + 拖动** | 卡片左上角的**手柄**按住就能拖：拖过之后卡片会**钉住**（加一圈蓝边，不再跟着选区跑），可以拖到屏幕边上留着对比；然后接着选下一个词，会**再开一张新卡片**，之前那张不会被顶掉。右下角出现「N 张卡片 · 全部关闭」角标，`Esc` 关掉最上面那张，手柄**双击**可以取消固定 |
| 看整句 | 直接拖选一整句，卡片会给出整句翻译 |
| 普通网页 | 同样选中文字 → 点「译」（可在设置里关掉） |
| 快捷键 | `Alt+Shift+T` 翻译当前选中的文字 |
| 右键菜单 | 选中文字 → 右键 →「翻译选中的文字」；对 `.pdf` 链接右键 →「在划词翻译器中打开这个 PDF」 |
| 换回原生阅读器 | 阅读器工具栏右侧 **用 Edge 打开**（该地址半小时内不再被自动接管，点弹窗里的「在翻译阅读器中打开」可撤销） |
| 阅读器功能 | 页码跳转、缩放（`Ctrl+滚轮`）、适合宽度、旋转、缩略图/大纲、`Ctrl+F` 查找、下载、打印、记住上次读到第几页 |

> 论文里框选漏字很常见：pdf.js 的文本层是按词切成一个个绝对定位的 `<span>` 的，
> 词与词之间连空格节点都没有，鼠标稍微歪一点就会少头少尾。
> 所以卡片既允许直接改文字，也能按「同一视觉行」把 span 重新拼回完整的一行/一段。

| 选不全就改，或一键扩选 | 多开 + 拖动固定 | 缩略图侧栏 | 网页划词 |
| --- | --- | --- | --- |
| ![编辑与扩选](docs/screenshot-edit.png) | ![多开](docs/screenshot-multi.png) | ![侧栏](docs/screenshot-sidebar.png) | ![网页](docs/screenshot-webpage.png) |

设置页（工具栏图标 →「更多设置」）里可以改：总开关、是否自动接管 PDF、是否在网页上划词、选中即翻译、双击即翻译、翻译引擎、目标语言、是否显示音标/例句、阅读器主题与默认缩放、清空缓存、测试翻译。

---

## 3. 先回答一个关键问题：为什么不直接用 Edge 自带的 PDF 阅读器？

因为**做不到**，这不是本扩展偷懒，而是 Chromium 的安全边界：

* Edge 内置 PDF 阅读器（`edge://` 内部页面 + 内嵌插件）**不加载任何第三方扩展的内容脚本**，扩展拿不到它的 DOM，也就无从知道「你选中了哪个词」；
* 扩展的右键菜单、快捷键在那个页面里同样拿不到选区文本；
* 这也是为什么市面上所有「PDF 划词翻译」类扩展（沉浸式翻译的 PDF 模式等）都自带一个阅读器。

所以本扩展的做法是：**用 pdf.js 自带一个功能对齐的阅读器**，让 PDF 的文本层落在我们自己的页面里，划词才成立。为了尽量少打扰你：

* 只接管**顶层** PDF 标签页；页面里内嵌的 PDF（`<iframe>`）不动它，需要时在弹窗里点一下「打开页面内嵌的 PDF」；
* 阅读器工具栏始终留着 **用 Edge 打开**，一键回到原生阅读器；
* 在设置里关掉「自动接管 PDF」，就完全退回原生行为（此时只有网页划词可用）。

**已知限制**（都尽量给了出路）：

| 情况 | 表现 / 出路 |
| --- | --- |
| 扫描版 PDF（图片型） | 没有文本层，选不中文字，任何方案都无解（需要 OCR） |
| 需要登录 / 有防盗链的 PDF | 阅读器可能报「服务器拒绝了读取请求」→ 点「用 Edge 内置阅读器打开」 |
| 加密 PDF | 会弹出输入密码 |
| 本地 `file://` PDF | 需在扩展详情页打开「允许访问文件 URL」 |
| 后台标签页 | 浏览器不渲染隐藏标签页，切过去就会正常显示（与 Edge 原生一致） |

---

## 4. 翻译引擎

默认用**有道词典**（`dict.youdao.com`，国内可直连，释义/音标/例句最全，实测毫秒级返回）。可在设置页切换：

| 引擎 | 说明 |
| --- | --- |
| 有道词典（默认） | 词典释义、英/美音标、发音、词形变化、短语、双语例句 |
| Google 翻译 | 需要能访问 `translate.googleapis.com` |
| MyMemory | 免费整句翻译，作为兜底 |

* 选中**单词/短语**走词典接口（词性 + 释义 + 例句）；选中的是**整句**则走整句翻译；
* 选中中文时自动反向查（中→英）；
* 主引擎失败会自动降级到下一个引擎；
* 结果缓存在本机（`chrome.storage.local`），同一个词第二次查是 0 延迟；设置页可清空。

---

## 5. 目录结构

```
extension/                     ← 加载这个目录（就是扩展本体）
├── manifest.json              MV3 清单
├── background/service-worker.js   PDF 接管（三道保险）+ 翻译代理 + 缓存 + 菜单/快捷键
├── shared/
│   ├── providers.js           翻译服务层（有道/Google/MyMemory，纯 ESM、零依赖）
│   ├── bubble.js              划词气泡 UI（Shadow DOM，PDF 与网页共用）
│   ├── cache.js               翻译缓存
│   └── settings.js            设置读写（chrome.storage.sync）
├── viewer/                    自带 PDF 阅读器（基于 pdf.js 组件 + 自写工具栏/侧栏）
├── content/selection-translate.js  普通网页划词
├── popup/  options/           弹窗与设置页
├── icons/                     图标（tools/make-icons.mjs 生成）
└── vendor/pdfjs/              pdfjs-dist 6.3.289（build + web 组件 + cmaps/wasm 等资源）

tools/    vendor-pdfjs.mjs（vendor 资源）· make-icons.mjs（零依赖画图标）
          check-pdfjs-contract.mjs（校验 core 与组件包接口契约）· pack.mjs（打 zip）
tests/    providers.test.mjs（翻译层联网单测）· e2e.mjs（真机端到端）· serve.mjs（测试服务器）
          sample-pdf.mjs（现场生成测试用 PDF）
docs/     截图（README 用）
根目录    README.md · LICENSE（MIT）· package.json（npm 脚本）· .gitignore
```

> `extension/vendor/`、`extension/icons/`、`dist/`、`tests/artifacts/`、`.tmp/` 都是生成物，已写进 `.gitignore`；
> 克隆后先跑 `npm run build` 再加载扩展。

---

## 6. 开发与测试

```bash
npm run build          # vendor（pdf.js 资源）+ icons（图标）+ 校验 pdf.js 接口契约
npm run vendor         # 只拉取 pdfjs-dist 运行时资源到 extension/vendor/pdfjs
npm run icons          # 只生成 16/32/48/128 图标（纯 node 光栅化 + PNG 编码）
npm run check:pdfjs    # 只校验 core 与组件包的导出/版本是否对齐
npm test               # 翻译层单测 + 真机端到端测试（需要 Edge，约 40 秒）
npm run test:providers # 只跑翻译服务层单测（真实联网）
npm run test:e2e       # 只跑端到端测试（真浏览器 + 真鼠标 + 真翻译）
npm run serve          # 起测试服务器，配合手动调试
npm run pack           # 打包 dist/*.zip
```

> 构建产物（`extension/vendor/`、`extension/icons/`、`dist/`、`tests/artifacts/`、`.tmp/`）都不入库（见 `.gitignore`）；
> 端到端测试发现资源缺失时会直接提示先跑 `npm run build`。

**单测**（翻译服务层，真实联网）：

```bash
npm run test:providers
```

**端到端测试**（真浏览器、真 PDF、真鼠标、真翻译，26 项检查）：

```bash
npm run test:e2e                      # headless 跑一遍
node tests/e2e.mjs --headed --keep-open  # 有界面跑完保留浏览器，方便手动体验
```

它会：启动本地服务器提供测试 PDF → 用 `--load-extension` 把 `extension/` 装进真实 Edge →
打开 PDF 并断言标签页被换成扩展阅读器 → 用 CDP 派发**真实鼠标按下/移动/松开**完成划词 →
断言出现「译」按钮 → 点击 → 断言卡片里出现中文释义/词性/音标 →
再验证无 `.pdf` 后缀的响应头兜底、普通网页划词、设置页与弹窗页可打开、搜索/翻页/缩略图、
「用 Edge 打开」切回原生后不被重新接管、无未捕获异常；截图落在 `tests/artifacts/`。

`npm run serve` 可以单独起测试服务器（`http://127.0.0.1:8788/sample.pdf`）配合手动调试。

---

## 7. 实现笔记（踩过的坑，供后来者少走弯路）

1. **`declarativeNetRequest` 拦不住并传递原始 URL**：`redirect.extensionPath` 配 `regexSubstitution` 在 Chromium 上**不生效**——规则能装上，但 `\0` 会原样留在地址里（实测得到 `viewer.html?file=\0`），拿不到被拦截的 URL。改回 `webRequest` + `tabs.update`，原始地址直接拼进 `?file=`。
2. **接管要"校验后重试"**：标签页刚创建时第一次导航还在途中，此时 `tabs.update` 可能被原导航覆盖，表现为 PDF 时而接管时而没有。所以 update 之后 700ms 校验一次，没成功就重试（最多 4 次）。
3. **service worker 冷启动窗口会丢事件**：全新配置文件下，扩展监听器注册完成前发生的导航事件会丢。补了一个**启动补扫**（启动时、+1.5s、+4s 扫描仍是 `.pdf` 地址的标签页），顺带也覆盖了「浏览器启动时批量恢复 PDF 标签页」。
4. **`pdf_viewer.mjs` 是 webpack bundle，从 `globalThis.pdfjsLib` 取 core**：必须先 `import` core 并挂到全局，再**动态 `import()`** 组件包；`tools/check-pdfjs-contract.mjs` 会校验两边 62 个成员与版本号是否对得上。`PDFViewer` 构造时还要求容器**绝对定位**、`viewer` 为 DIV。
5. **npm 包不含 `web/locale`**，所以不能直接 `new GenericL10n()`，需要自己实现一个极简 l10n 桩（`viewer/viewer.js` 里的 `L10N`）。
6. **pdf.js v6 已完全不使用 `eval` / `new Function`**（实测 0 处），MV3 的 CSP 不会挡它，也不需要 `isEvalSupported`。
7. **隐藏标签页不渲染**：`document.visibilityState === 'hidden'` 时 Chromium 不跑渲染循环，pdf.js 页面会停在 loading——这是浏览器行为（Edge 原生阅读器同理），自动化测试里必须先把标签页切到前台。
8. **有道接口细节**：`dict.youdao.com/jsonapi` 不返回 CORS 头，所以翻译必须在 service worker 里做（内容脚本会被 CORS 拦）；整句接口 `aidemo.youdao.com/trans` 只认 `to=zh-CHS`（传 `zh-CN` 返回 errorCode 102），且不支持中译英。
9. **“放行”要按 URL 记、而且不能被一次事件消费掉**：最初把「用 Edge 打开」按标签页记、命中即删。结果同一次导航会触发好几个事件，第一个事件就把标记用掉了，几秒后启动补扫又把标签页抢回阅读器（这个 bug 是端到端测试里的「切回原生后不会被再次接管」一项抓出来的）。现在改成按 URL 记、30 分钟有效、不做消费式删除。
10. **PDF “选不全”的根因与对策**：pdf.js 文本层把每个词/片段做成绝对定位的 `<span>`，词间没有空格节点，鼠标框选容易漏首尾字符、甚至把词切断。对策在 `shared/bubble.js`：① 卡片顶部的文字本身就是输入框，改完回车即可重译（结果区与输入框分离，重译不会清掉你输入的内容，并用请求序号保证只渲染最后一次结果）；② `expandRange()` 按**底边对齐**（同一视觉行的 span 基线基本一致）把片段归行、按 x 排序、按水平间距补空格，重新拼出整行/整段，并把页面选区一起换掉，用户能看到高亮扩出来。
11. **多开 + 拖动的几个坑**：卡片从「一个全局实例」改成 `BubbleCard` 对象数组，每张各自持有待翻译文字、文档选区、请求序号、位置与钉住状态。几个刻意的取舍：① 拖过就**钉住**（只跟选区跑的卡片在滚动/重排时会乱飘，拖过之后必须完全听用户的），双击手柄可解除；② 点击页面别处**不再关闭卡片**——否则「翻一个词、拖到边上、再翻一个」根本没法做，改由 `Esc`（关最上面一张）/ 每张的 ✕ / 角标里的「全部关闭」来收；③ 「选中即译/双击即译」这种连续自动触发会复用上一张自动卡片，避免自动模式刷出一屏；④ 最多 6 张，超了先关没钉住的最早那张；⑤ 新卡片与旧卡片重叠时按 22px 阶梯错开（错位偏移量存在卡片上，重译后不会被 `place()` 覆盖掉）。

---

## 8. 隐私

* 只做两件事：把你**选中的文字**发给翻译引擎，以及把 **PDF 文件**读进本地阅读器渲染；
* 无账号、无统计、无遥测，不上传浏览记录；
* 翻译缓存与阅读位置只存在本机（`chrome.storage.local`），设置页可一键清空；
* 默认引擎会把查询词发给 `dict.youdao.com`；切到 Google 引擎则发给 `translate.googleapis.com`。

## 9. 许可证

* 本扩展代码：MIT（见 `LICENSE`）；
* 内置的 pdf.js（`extension/vendor/pdfjs/`）：Apache-2.0，见 `extension/vendor/pdfjs/LICENSE.pdfjs`；
* 字体与 CMap 资源版权见 `extension/vendor/pdfjs/standard_fonts/`、`cmaps/` 下的 LICENSE 文件。
