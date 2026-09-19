# dsh-view-state

[![test](https://img.shields.io/badge/test-94%20assertions%20passing-brightgreen)](#测试) · [English](README.md)

**让 DeepSeek Harness（`dsh`）Web UI 的「每标签页视图状态」可被外部寻址。**

`dsh` 前端没有路由：当前选中的会话和两个面板宽度只存在于页面内存里。因此，把
UI 托管在 WebView 中的外部外壳（比如需要保存、恢复「每标签页布局预设」的桌面
包装器）既无法观测、也无法重放这些状态。本插件把这三项事实放进 URL：

```
http://127.0.0.1:3080/?dsh_session=session-abc&dsh_sidebar=300&dsh_rightbar=420&token=…
```

它会在页面所在的**任意路径**上与实时状态保持同步（只使用
`history.replaceState`），并在加载时读回。插件**不添加任何 UI、插槽、DOM 或
CSS**。

---

## URL 契约

| 参数 | 含义 | 缺失时表示 | 取值范围 |
|---|---|---|---|
| `dsh_session` | 当前选中的会话 | 未选中任何会话 | 会话列表中存在的任意 id |
| `dsh_sidebar` | 侧边栏宽度偏好（px） | 尚不可知 | `0` = 已折叠，否则 `264`–`420` |
| `dsh_rightbar` | 右面板**已保存**宽度（px） | 尚不可知 | `0` = 尚无保存宽度，否则 `300`–`0.7 × 视口宽` |

插件保证的规则：

1. **只写这三个参数**，且只通过 `history.replaceState` —— 绝不使用
   `pushState`，绝不刷新，绝不导航。**永不改变 pathname**，因此
   `/s/<sessionId>` 深链继续可用。
2. **外来参数按字节、按顺序原样保留。** 尤其是 `token`：绝不解码、不重新编码、
   不重排 —— 服务端就是用它完成鉴权的。
3. 无法解析的、以及负数的宽度一律视为**缺失**，而不是 `0`。
4. URL 与 `localStorage` 同时有值时 **URL 优先**；`localStorage` 只补 URL 的
   空缺。若 URL 已与实时状态一致，则**完全不重写**。
5. 未知会话 id **软失败**：只丢弃该参数，其余功能照常。
6. 任何服务缺失、插槽缺失或异常都被吞掉，每次激活**最多一条**
   `console.warn`。

---

## 安装

```bash
dsh plugin --profile web add github:RailgunHamster/dsh-view-state
```

本包声明了 `dsh.bundle.patch`，因此 `dsh plugin add` 会自动把它登记进 profile 的
`dsh.profile.bundles`，启动时自动组合该配置行，无需手工修改 YAML。

```bash
dsh web           # 重启 Web GUI，然后刷新页面
```

> **其他安装形式。** 发布到 npm 后可用：`dsh plugin --profile web add dsh-view-state`。
> 不使用 bundle 机制的手工安装：在 profile 目录执行 `pnpm add dsh-view-state`，
> 再在 profile 的 patch 层（如 `~/.dsh/profiles/web/cordis.patch.yml`）加入：
>
> ```yaml
> - insert:
>     - id: view-state
>       name: 'dsh-view-state'
> ```

**环境要求：** 带 web profile 的 dsh，大约 `0.1.0-rc.6` 及以上（本插件针对
`0.1.5-rc.1`/`0.1.5-rc.2` 开发）。无需其他依赖 —— `sessions`、`layout`、`slots`
都由官方 web bundle 组合，且本插件**不声明任何硬性服务依赖**，因此永远不会把
启动流程卡住。

---

## 外部外壳应该怎么做

整个设计的要点就是：包装器永远不必伸手进页面。读 URL、存下来、回放即可。

### 采集（每个标签页）

读取 URL，只保留你自己拥有的参数：

```csharp
// WPF / WinForms WebView2
string source = webView.Source.ToString();          // 例如 http://127.0.0.1:3080/s/session-abc?dsh_session=…&token=…
var uri  = new Uri(source);
string query = uri.Query;                            // "?dsh_session=…&dsh_sidebar=300&dsh_rightbar=420&token=…"
string path  = uri.AbsolutePath;                     // "/s/session-abc" —— 也存下来，它不是我们该改的东西

// 把 `path` 与三个 dsh_* 值一起存为该标签页的预设。
// 不要把 `token` 跨进程重启复用，它是每次启动独有的。
```

由于插件在每次真实状态变化时都会写入，URL 永远是当下的：用户选定会话或拖动
分隔条之后，`Source` 已经反映了新状态。

### 恢复（每个标签页）

把 WebView 导航到「源站 + 已保存路径 + 三个参数」，同时**保留应用自身的启动
参数**：

```csharp
string restored =
    $"{origin}{savedPath}" +
    $"?dsh_session={Uri.EscapeDataString(savedSession)}" +
    $"&dsh_sidebar={savedSidebar}" +
    $"&dsh_rightbar={savedRightbar}" +
    startupParameters;          // 必须仍然带着应用自己的 `token`

webView.Source = new Uri(restored);
```

加载后，插件会在会话列表与布局 store 就绪时读取这三个值并应用。若某个会话 id
已不在列表中，只丢弃那一个参数，其余照常生效。

### 给包装器作者的提示

- **能用就地改写就不要整页重载。** 设置 `Source` 会让应用重新加载；如果你的
  包装器能就地改写查询串，插件会自行感知到变化。
- **绝不要只发这三个参数。** 必须保留外壳自身的查询串（尤其是 `token`），否则
  页面无法通过鉴权。
- **尚无状态的标签页其 `dsh_session` 为空。** 应把缺失或空的 `dsh_session`
  理解为「没有会话」，而不是错误。
- `dsh_sidebar=0` 表示侧边栏确实处于折叠状态；`dsh_rightbar=0` 表示右面板
  「从未打开过」，因此没有宽度可恢复。

---

## 已知限制

以下是本插件在 dsh `0.1.5-rc.*` 上诚实的边界。底层 API 依据见
[`docs/API-NOTES.md`](docs/API-NOTES.md)。

- **右面板的「显示 / 隐藏」状态不会被采集或恢复。** 右面板是否展开并不属于
  布局 store 的事实源：它是
  `@deepseek-ai/dsh-client-ui-sidebar-right` **按会话**存储中的
  `surface.layout.expanded`，而该座席会在每次布局副作用时把它回报给框架。从这
  里写入会与该座席竞争。因此 `dsh_rightbar` 只采集**已保存宽度** —— 用户之后
  打开面板时会以恢复的宽度打开。
- **侧边栏一旦折叠，其展开时的精确 px 就会丢失。** 按契约「关闭会遗忘拖动宽度
  —— 重新打开恢复契约默认值」（`SIDEBAR_DEFAULT = 280`）。展开时采集可得到精确
  px；折叠时采集得到 `0`，恢复 `0` 就是重新折叠。插件不会凭空编造数值，但折叠
  前的宽度确实按应用自身的设计消失了。
- **宽度会被应用重新钳制。** `setSidebar` 钳制到 `[264, 420]`，`setRightbar`
  钳制到 `[300, 0.7 × 视口宽]`。右面板上限与视口相关，因此在宽窗口保存的宽度
  在窄窗口恢复时会更窄。插件不会与之对抗。
- **未建模 1024px 以下的侧边栏自动折叠。** 视口小于
  `SIDEBAR_AUTO_COLLAPSE = 1024` 时，侧边栏渲染为由 `narrowExpanded` 驱动的窄
  轨，该状态不属于本契约。
- **不采集：** 当前选中的全局主面板（`panelInfo.activePanelId`）、右面板的
  标签页 / 分屏内容、滚动位置，以及会话 id 以外的任何会话信息。
- **列表之外的会话 id 无法恢复**，且 `dsh_session` 只在同一个 `$DSH_HOME` 内
  往返有效；会话 id 是不透明且本地的。
- **访问布局 store 依赖一项实现细节。** 插件从 `root` 插槽注册项的 `store`
  座席取得实时 store，并校验它已被「钉住」（两次 `create()` 必须返回同一对象）。
  若未来的 ui-layout 不再钉住它，宽度恢复会退化为一条警告，而 URL /
  localStorage 双向镜像仍继续工作。见
  [`docs/API-NOTES.md` §2.3](docs/API-NOTES.md)。
- **未在真实浏览器中验证。** 本仓库带有 stub-Cordis 测试；此处并未实际跑过
  WebView。见 [`docs/API-NOTES.md` §7](docs/API-NOTES.md)。

---

## 测试

```bash
node test/client-half.test.mjs     # 或：npm test
```

94 条断言，零依赖，无需浏览器：用一份手写的假 `ctx`（服务 `sessions`、
`layout`、`slots`，以及 `effect`）加载真实的 `lib/client.js`，并配合
`window`、`history`、`localStorage` 的替身。覆盖内容：冻结契约、精确的 URL
字符串结果、pathname 保留、`token` 保留与外来参数的字节级不变、未知 id 丢弃、
localStorage 回退与优先级、未钉住 store 的探测，以及 effect 卸载。

---

## 目录结构

```
lib/client.js              浏览器半边（纯 ESM，无构建步骤，无打包器）
lib/index.js               空的宿主半边 —— Loader 行需要宿主侧导出，故必须存在
cordis.patch.yml           bundle 补丁（`dsh.bundle.patch`）：只插入本插件这一行
test/client-half.test.mjs  stub-Cordis 契约测试
docs/API-NOTES.md          所依赖的全部 API 事实，含文件路径与原文引用
```

## 许可

[MIT](LICENSE)
