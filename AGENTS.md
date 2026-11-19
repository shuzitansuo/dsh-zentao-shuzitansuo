# 项目约定

本仓库是「禅道 AI 工作台」DSH 插件。

- 改 UI 之前先读 `DESIGN.md`，以现有「列表」页为唯一基准，复用 `zt-tabs`、`zt-tab`、`zt-count`、`zt-table`、`zt-team-pager`、`zt-team-range`、`zt-btn`/`zt-chip-btn` 等既有类。
- 不要为单个页面另造一套 Tab、按钮、输入框、表格、卡片或分页样式。
- 不要把页面专属样式写成全局选择器；新增样式优先限定在 `zt-<页面>-*` 下。
- 修改功能后运行 `node --check client.js`、`node --check index.js`，并对 `lib/*.js` 做语法检查。
- 提交前确认 `cordis.patch.yml` 是占位模板，不要包含真实账号、密码、IP 或 API Key。
