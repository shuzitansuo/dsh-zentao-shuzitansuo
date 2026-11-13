# 禅道 AI 工作台（DSH 插件）

把 DeepSeek Harness 和禅道（ZenTao）连起来的三栏工作台：

- 左侧：项目 / 迭代树（排序、搜索、显示已关闭、展开动画）
- 中间：研发需求 / BUG 列表（状态/阶段、模块、优先级、指派人、行内改状态/指派、列宽列序、只看我）
- 右侧：DeepSeek 会话（录入需求/BUG、改状态、新增迭代、文档批量建需求、指派提醒、通用只读接口查询）

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| DeepSeek Harness（桌面版） | 需要支持本地插件（bundle patch + client plugin）。插件按开发时版本的插件 API 编写，DSH 大版本升级后如有接口变化需要微调 |
| 禅道 16.x | 用登录会话 + HTML 接口；「通用接口查询」依赖禅道 REST API v1（`/api.php/v1/...`，多数 16.x 默认开启） |
| Node.js / pnpm | DSH 自带 Node；profile 目录需要 pnpm 来建立本地 link |
| 可选的语音 | 语音输入接口依赖 DSH 的 speech-to-text（SenseVoice）插件包；没装不影响其它功能 |

## 安装

### 方式一：一键脚本（推荐）

1. 把本目录放到一个**固定位置**（后续升级直接替换，不要放在下载目录里随时删），例如：
   ```bash
   mv dsh-zentao-share ~/dsh-zentao-share
   ```
2. 运行安装脚本（默认写入 `~/.dsh/profiles/desktop`；如果你的 profile 叫 web，可传参）：
   ```bash
   cd ~/dsh-zentao-share
   ./install.sh            # 默认 desktop profile
   # 或 ./install.sh ~/.dsh/profiles/web
   ```
3. 编辑插件配置，填入你自己的禅道地址和账号：
   ```bash
   open ~/dsh-zentao-share/dsh-zentao/cordis.patch.yml
   ```
   ```yaml
   baseUrl: 'http://你的禅道地址:端口'   # 不要以 / 结尾
   account: '你的账号'
   password: '你的密码'
   ```
4. **重启 DeepSeek Harness**（完全退出再打开），刷新页面，左侧栏出现「禅道 AI 工作台」。

### 方式二：手动安装

1. 把 `dsh-zentao` 文件夹放到固定位置，例如 `~/dsh-zentao-share/dsh-zentao`。
2. 打开 profile 的 `package.json`（如 `~/.dsh/profiles/desktop/package.json`）：
   - 在 `dependencies` 中加入：
     ```json
     "@local/dsh-zentao": "link:/Users/你的用户名/dsh-zentao-share/dsh-zentao"
     ```
   - 在 `dsh.profile.bundles` 数组中加入 `"@local/dsh-zentao"`。
3. 在该 profile 目录执行：
   ```bash
   cd ~/.dsh/profiles/desktop
   pnpm install
   ```
   （没有 pnpm 时：`corepack enable` 或 `npm i -g pnpm`）
4. 编辑 `~/dsh-zentao-share/dsh-zentao/cordis.patch.yml` 填禅道账号（同上）。
5. 重启 DeepSeek Harness。

## 配置项（`dsh-zentao/cordis.patch.yml`）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | — | 禅道地址，如 `http://192.168.1.10:8080` |
| `account` / `password` | — | 禅道登录账号（只保存在本机） |
| `showClosed` | `true` | 左树是否默认显示已关闭的项目/迭代 |
| `chatMode` | `custom` | `custom` = 插件自带三栏聊天；`native` = 用 DeepSeek 原生会话 + agent 工具驱动禅道 |
| `assignmentWatch` | `true` | 是否轮询「我的 Bug/需求」做指派提醒（只读） |
| `assignmentIntervalMs` | `60000` | 指派提醒轮询间隔（毫秒） |
| `updateUrl` | 空 | 更新清单 JSON 地址，例如 `https://example.com/dsh-zentao/latest.json`；留空则「检查更新」提示未配置 |

## 更新机制

- 把新版插件打成 zip 上传，并提供一个清单 JSON：
  ```json
  { "version": "0.0.3", "url": "https://example.com/dsh-zentao-0.0.3.zip",
    "notes": "更新说明", "sha256": "可选的 zip SHA-256" }
  ```
- 在 `cordis.patch.yml` 配置 `updateUrl: '.../latest.json'`
- 左下角版本号旁会出现「检查更新」按钮：打开面板时会自动检查并提示新版本；点击后自动下载、校验并覆盖插件文件
- 更新不会覆盖你的 `cordis.patch.yml`；装完需重启 DeepSeek Harness 生效

## 升级

- 用新版 `dsh-zentao` 文件夹覆盖旧文件夹（保留你自己的 `cordis.patch.yml` 配置）。
- 因为是 `link:` 安装，通常不用重新 `pnpm install`；重启 DeepSeek Harness 即可。
- 如果新增/删除了依赖文件，进入 profile 目录重新 `pnpm install`。

## 卸载

1. 从 profile 的 `package.json` 中删除 `@local/dsh-zentao` 依赖和 `dsh.profile.bundles` 里的 `@local/dsh-zentao`。
2. 在 profile 目录执行 `pnpm install`。
3. 删除插件文件夹，重启 DeepSeek Harness。

## 安全提示

- `cordis.patch.yml` 里会保存禅道账号密码，**不要**把它提交到公开仓库或发给别人；分享插件时请保持占位符。
- 本插件对禅道的写入操作（建需求/BUG/迭代、改状态、指派）都走禅道原有权限校验，不会绕过禅道权限。
- 「通用接口查询」第一版是只读的，不会修改禅道数据。

## 常见问题

- **左侧没有出现「禅道 AI 工作台」**：确认 `install.sh` 或手动步骤改的是当前正在使用的 profile（`~/.dsh/profiles/desktop`），并完全重启 DSH。
- **登录失败 / 401**：检查 `baseUrl` 是否可访问、账号密码是否正确；有的禅道开启了 IP 白名单或二次验证。
- **部分功能 404**：多为禅道版本差异；需求/BUG/迭代等核心功能兼容 16.x，REST 查询需要 API v1 可用。
- **改完插件不生效**：宿主端文件（`index.js`、`lib/*.js`）需要重启 DSH；仅 `client.js` 改动刷新页面即可。
