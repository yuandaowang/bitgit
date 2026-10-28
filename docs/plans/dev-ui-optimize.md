# 看板密度、标签与搜索历史

Status: 未开始。分支 `dev-ui-optimize`，基线 `main` @ `12d0095`（Prepare 1.2.1，已与 `origin/main` 对齐）。后续实现都在该分支上提交，不推送，除非另有要求。

本计划只覆盖看板项目列表。Analytics 视图、恢复工作区、发布和凭据流程保持原样。

## 目标

1. 收藏星标只出现一次。
2. 在现有「详细 + 单列」之外，增加信息密度（Detail / Simple）和排布（List / Grid），让同一块看板能同时看到更多仓库。
3. 给项目打标签：可新建，也可选用已有标签；看板按标签筛选。
4. 项目搜索框获得焦点时展示最近 10 条搜索历史，可点选回填，也可单条删除。

默认仍是现在的详细单列，不改变已有项目数据的含义。

## 现状（实现时直接改这些位置）

看板是 `src/components/Dashboard.tsx`。筛选在组件内的 `useState`，不落盘。项目列表是单列 `space-y-4`（约 513–517 行），每项一个 `ProjectCard`。筛选条 `sticky top-16`，批量操作条写死 `sticky top-[136px]`（约 426 行）。「Clear Filters」只清空搜索词和状态（约 502–505 行）。搜索匹配名称、本地路径、`githubOwner`、`githubRepo`（约 55–58 行），输入即筛选，没有历史。

卡片是 `src/components/ProjectCard.tsx`。收藏为真时，标题旁画一颗实心星（约 750 行），旁边的收藏按钮再画一颗实心星（约 756–766 行）。这就是截图 3 的两颗星。卡片正文还包括描述、「Add description」、GitHub 行、本地路径、上次同步、分支与 ahead/behind、其他远程分支，以及一行文字按钮（Create / Link / Details / Archive）。弹层是 `fixed inset-0`，放进网格不会被裁切。

项目模型：

- 前端 `Project`：`src/types/index.ts`
- Rust `Project`：`src-tauri/src/models.rs`
- 新建项目字面量：`src-tauri/src/commands.rs`（`create_project` 一带，约 345 行）、`src-tauri/src/project_sync.rs`（`merge_local_import`、`merge_github_import` 里的新项目，以及测试辅助 `project`）
- 测试夹具：`src-tauri/src/project_cache.rs` 的 `sample_project`
- 原地更新：`project_cache::update_project`。`update_project_metadata` 用 `Option` 的 `None` 表示「不改」，不适合用来清空列表
- 再次导入同一路径或同一 GitHub 身份时，`merge_local_import` / `merge_github_import` 保留原结构体上的用户字段，只刷新状态。`favorite` 已有回归测试（`project_sync.rs` 约 947 行、1042 行）

项目列表存在本机缓存。`GitStatus` 后加的字段用 `#[serde(default)]` 读旧缓存。新字段必须同样默认，否则旧 `projects.json` 无法加载。

前端没有组件测试运行器。界面以 `npm run build` 和 `npm run tauri:dev` 里的手工路径验收；标签的缓存兼容与导入保留用 `cargo test`。

## 已经定下的行为

这些选择实现时不再另开讨论。

- 密度和排布是两个独立开关，可以组合。默认 `detail` + `list`。
- 显示偏好和搜索历史只放 `localStorage`，不进项目缓存，不进 `UISettings`。
  - `bitgit.dashboard.view`：`{ "density": "detail" | "simple", "layout": "list" | "grid" }`
  - `bitgit.dashboard.searchHistory`：字符串数组，最新在前，最多 10 条
  - 解析失败或形状不对时丢弃该键，回退默认，不抛到界面。
- 标签存在项目上，随项目缓存走。全局标签表不单独存储，由全部项目的标签求并集得到。最后一个项目去掉某标签后，筛选器里它自然消失。
- 多选标签是「或」：命中任一选中标签即显示。未选任何标签等于不按标签过滤。
- 搜索历史不上传、不写入项目缓存。清空筛选不删除历史，也不重置密度和排布。
- 不做的事：标签重命名、标签颜色编辑器、把标签同步成 GitHub topics、搜索历史超过 10 条、改 Analytics。

## 标签规则

Rust 是校验的唯一来源，前端只做同样的预检以便即时提示。

- 字段：`labels: Vec<String>`，`#[serde(default, skip_serializing_if = "Vec::is_empty")]`。前端类型为 `labels?: string[]`，读取时当成 `[]`。
- 写入前：trim；连续空白折成一个空格；空串丢弃。
- 单个项目内按不区分大小写去重，保留先出现的写法。
- 每个标签最长 24 个 Unicode 标量值。每个项目最多 8 个标签。
- 允许字母、数字、空格、连字符，以及中日韩统一表意文字。其他字符拒绝，并在界面说明原因。
- 非法输入不落盘，项目上的原标签保持不变。
- 新命令 `set_project_labels(project_id, labels)`，经 `update_project` 整表替换，因此可以清空。不要塞进 `update_project_metadata`。
- 所有 `Project { ... }` 字面量补 `labels: Vec::new()`。再导入已有项目必须留下标签；为本地再导入和 GitHub 再导入各加一条断言，比照现有的 `favorite` 测试。
- 芯片颜色由规范化后的小写名称做稳定哈希，映射到一套固定的浅色底 + 深色字组合（含 dark mode）。不入库。

## 工作顺序

按下面四段提交。每段都要能单独编译。前一段的验收通过后再做下一段。

### 1. 收藏只留一颗星

改 `src/components/ProjectCard.tsx` 标题行。

- 删掉标题旁那颗仅在收藏时出现的装饰星（约 750 行）。
- 保留收藏按钮。未收藏：灰色空心星。已收藏：黄色实心星，按钮保持可点，用来取消收藏。
- 归档图标仍留在标题旁。`toggle_project_favorite`、toast 和 store 更新不改。
- 后面的 Simple 卡片复用这一颗星，不再各画一颗。

完成标准：对一个项目点收藏，标题行只有按钮上的一颗黄星；再点一次，星变为空心，项目不再算收藏。排序「Favorites First」和「只看收藏」仍按 `project.favorite` 工作。

### 2. Simple 密度和 Grid 排布

在 `Dashboard.tsx` 筛选条增加两组分段按钮，样式对齐顶栏 Projects / Analytics 的选中态：

- Detail | Simple
- List | Grid

状态放在 `Dashboard`，挂载时读 `bitgit.dashboard.view`，变更时写回。把筛选条和批量操作条放进同一个 sticky 容器，批量条紧跟筛选条，删掉 `top-[136px]`。筛选条变高或换行时，批量条不能盖住卡片，也不能在卡片滚动时漂走。

`ProjectCard` 增加 `density: 'detail' | 'simple'`。详细密度就是现在的卡片，只带上一步的星标修正。Simple 不复制一套收藏、刷新、删除、链接逻辑；把这些处理留在现有组件里，Simple 只换展示。卡片根节点加 `data-density`。列表容器加 `data-layout`。

Simple 卡片保留：

- 勾选框、状态图标、名称、一颗收藏星、归档图标、删除
- 一行状态文案（现在的 `status-text`）
- 标签芯片和添加入口（第 3 段接上；本段先留出插槽）
- 一行身份：有本地路径就显示路径，否则显示 `owner/repo`；过长截断
- 一个紧凑的同步摘要：分支名，以及 ahead / behind 或「未连接」。没有 git 状态时不占这行
- 图标按钮：有本地目录时保留刷新、Save & Recover。Create、Link、Details、Archive、Restore 收进一个溢出菜单，功能与现在的文字按钮相同

Simple 卡片不渲染：

- 「Add description」和描述编辑区。已有描述放到名称的 `title` 上，悬停能看到
- 「Last synced」整句
- 「其他远程分支」列表
- 现在那一排全宽文字按钮

排布：

- List：维持单列 `space-y-4`。Detail 用现在的 `p-6`；Simple 把内边距降到 `p-3`，块间距降到 `space-y-2`。
- Grid + Simple：`grid-cols-1 md:grid-cols-2 xl:grid-cols-3`，`gap-3`。
- Grid + Detail：`grid-cols-1 xl:grid-cols-2`，`gap-4`。详细卡片仍然高，两列是上限。
- 路径、分支名、标签行在格子里截断或换行，不把格子撑出横向滚动。

顶栏「N of M projects」继续用筛选后的数量，两种排布都一样。空列表和「没有匹配」的空状态不随排布改变。

完成标准：

- 刷新页面后，上次选的密度和排布还在。损坏的 localStorage 值回到 Detail + List。
- 五个以上的项目在 Simple + Grid 下，一屏能看到的卡片数多于现在的详细单列。
- Simple 里仍能刷新、打开 Save & Recover、从溢出菜单归档、链接本地目录、链接或创建 GitHub、打开 Details。
- Detail + List 与改动前相比，除星标和筛选条上的新开关外，卡片内容一致。

### 3. 标签

模型与命令按「标签规则」落地，并在 `src-tauri/src/main.rs` 注册 `set_project_labels`。前端经 `invoke` 调用，成功后用返回的 `Project` 更新 store（与 `toggle_project_favorite` 同一路径）。

共享组件 `src/components/ProjectLabels.tsx`，Detail 和 Simple 都用它：

- 已有标签是芯片。芯片上的移除按钮只去掉这一枚，并立刻调用 `set_project_labels`。
- 「+ Label」打开组合框。输入时，用现有标签做不区分大小写的包含过滤。
- 点已有标签即采用它的现有写法，不另造一种大小写。
- 没有匹配且输入合法时，提供「创建 “…”」。创建成功后它出现在其他卡片的候选里。
- 已在本项目上的标签不再出现在候选中。达到 8 个时禁用添加并说明上限。
- 失败时 toast 错误，芯片回到保存前的列表。

筛选条在状态筛选和收藏按钮之间加「Labels」。按钮展示已选数量。弹出层列出按使用次数降序、次数相同则按名称排序的全部标签，多选。没有任何标签时，按钮禁用，提示到卡片上添加。选中的标签参与 `filteredProjects`，与搜索、状态、归档、收藏同时生效（全部为与）。搜索同时匹配标签原文。

「Clear Filters」额外清空标签选择，以及搜索和状态。收藏开关、归档开关、排序不在这次清空里，保持它们现在的独立行为。空结果页的 Clear 与筛选条语义一致。

完成标准：

- 旧缓存没有 `labels` 字段时，`cargo test` 覆盖的加载路径仍能读出项目，标签为空。
- 给项目 A 新建 `work`，项目 B 的候选里能点到 `work`，不会变成第二条不同大小写。
- 只选 `work` 时，看板只剩带 `work` 的项目；再选另一个标签时，带其中任一标签的项目都在。
- 再导入同一本地路径或同一 GitHub 仓库后，标签还在。
- 去掉某标签在所有项目上的使用后，筛选器里不再列出它。

### 4. 搜索历史

把 `Dashboard.tsx` 里的搜索框抽成 `src/components/ProjectSearchBox.tsx`。筛选逻辑仍留在 `Dashboard`。

- 输入框获得焦点，且历史非空时，在输入框下方打开列表，最多 10 条。
- 输入框有内容时，列表只保留包含该内容的历史（不区分大小写），仍最多 10 条。没有匹配则不打开空面板。
- 点击一条：写入搜索框并立即筛选，该条移到历史最前，面板关闭。
- 每条有移除按钮。移除只改历史，不改当前搜索词，并阻止输入框失焦（在面板上 `mousedown` `preventDefault`）。
- 写入时机：非空 trim 后的查询在按下 Enter，或输入框失焦时写入。与已有条目不区分大小写相同则只把最新写法挪到最前，不增加条数。超过 10 条丢掉最旧的。纯空白不写入。
- Escape 关闭面板。点击面板和输入框以外的区域关闭面板。方向键在面板打开时移动高亮，Enter 采用高亮项。
- `⌘F` / `Ctrl+F` 聚焦后，若已有历史，面板同样出现。

完成标准：依次搜索 11 个不同词，面板只留最新的 10 个，最旧的不在。删掉一条后再聚焦，它不再出现。点一条历史后，列表按该词过滤，效果与手打相同。重启应用后历史仍在。

## 验证

标签与缓存：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

至少看到：旧 JSON 缺 `labels` 仍能加载；本地再导入保留标签；GitHub 再导入保留标签；非法标签被拒绝且原列表不变。

类型与打包：

```bash
npm run build
```

界面在 `npm run tauri:dev` 里走完。前端没有组件测试，不能用单次截图代替这些路径。

- 收藏：点星，只有一颗；再点取消；Favorites First 和只看收藏跟着变。
- 密度和排布：四种组合都能切换。Simple 溢出菜单里的归档、链接、Details 可用。刷新后偏好还在。窗口拉窄到一列，再拉宽到三列（Simple）或两列（Detail）。
- 标签：新建、点已有、移除、筛选或关系、搜索词命中标签、Clear Filters 清掉标签选择但留下历史和视图偏好。故意输入超长和非法字符，看到拒绝且原标签还在。
- 搜索历史：聚焦出现、点击回填、单条删除、第 11 条挤掉最旧、Escape 关闭、重启仍在。
- 回归：批量选择和 Bulk Push / Bulk Sync 在 Grid 下仍作用于选中的项目。Analytics 切换回来，项目列表的筛选和视图偏好还在。深色模式下芯片、分段按钮和历史面板可读。

## 提交切分

1. `Fix the duplicate favorite star on project cards`
2. `Add simple density and grid layout to the project board`
3. `Let projects carry labels and filter the board by them`
4. `Remember the ten latest project searches`

每条说明为什么，不罗列文件名。
