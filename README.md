# opencode-session-async

> OpenCode 会话跨设备同步插件 —— 你的会话数据，永远不丢。

## 解决什么问题

OpenCode 的所有会话数据只存在本机的 SQLite 数据库里（`~/.local/share/opencode/opencode.db`），这意味着：

- **换电脑，历史会话全没了** —— 新机器上打开 opencode，会话列表一片空白
- **本地数据丢失无法恢复** —— 磁盘损坏、误删、系统重装，几年的对话记录瞬间消失
- **多台电脑各有一份，互不知道** —— 公司电脑聊的，家里电脑看不到

**本插件把会话自动同步到你自己的 GitHub 私有仓库**，换电脑、误删、多设备协作，历史会话随时恢复。

## 效果

| 场景 | 没有本插件 | 有本插件 |
|---|---|---|
| 换新电脑 | 手动拷贝 12GB 数据库，路径还不一定对 | 打开 opencode，全部历史会话自动出现 |
| 磁盘坏了 | 数据全丢 | 从 GitHub 私有仓库完整恢复 |
| 两台电脑同时用 | 各聊各的，互不知道 | 近实时双向同步（~2 分钟内） |
| 误删会话 | 找不回来 | 远端有快照，随时导回 |

## 安装

```bash
opencode plugin add github:nbb-ai/opencode-session-async
```

## 首次使用（全自动引导）

1. 打开 opencode
2. TUI 弹出「会话跨机同步」对话框 → 点「连接 GitHub」
3. 浏览器完成授权（输入验证码，点确认）
4. 插件自动在你的账号下创建私有仓库，开始全量同步

**不需要**安装 gh CLI、不需要配置 SSH key、不需要手动建仓库。

## 换新电脑

```bash
# 1. 安装插件（或从配置仓库继承）
opencode plugin add github:nbb-ai/opencode-session-async

# 2. 打开 opencode，弹出授权对话框，浏览器点一次

# 3. 完成。742 个历史会话约 40 秒内全部出现。
```

## 工作原理

```
本机会话 ──导出──> gzip 快照 ──git push──> GitHub 私有仓库
                                                    │
另一台机器 <──git pull── 解压导入 <──────────────────┘
```

- **粒度**：一个会话一个压缩文件，只传变化的（增量）
- **冲突**：同一会话两台机器都改过 → 保留时间最新的（最后写入者胜出）
- **安全**：仓库强制私有，传输 HTTPS 加密，token 存 macOS 钥匙串（不落磁盘）
- **可靠**：更新前先备份，失败自动回滚

## 配置

`~/.config/opencode/session-sync.json`：

```jsonc
{
  "enabled": true,
  "repoName": "opencode-sessions",    // GitHub 仓库名
  "authMode": "device",               // device = 纯浏览器授权（推荐）
  "deviceFlowClientId": "Ov23xxx",   // 你的 OAuth App client_id
  "interval": 120,                    // 同步间隔（秒）
  "maxSessionMB": 32,                 // 单会话体积上限
  "onConflict": "replace"             // 冲突时替换本地
}
```

## 命令

```
/session-sync          # 查看同步状态
/session-sync now      # 立即同步一次
/session-sync setup    # 重新引导连接 GitHub
/session-sync gc 90    # 清理 90 天前的快照（释放仓库空间）
/session-sync doctor   # 自检
```

TUI 调色板（`Ctrl+P`）也有「会话同步」入口。

## 隐私

- 会话数据只存**你自己的** GitHub 账号下，不经任何第三方
- 仓库强制私有（非私有仓库会拒绝同步）
- GitHub token 存 macOS 钥匙串 / Linux token.txt（600 权限），磁盘不留明文
- `opencode.json`（API key）不会被同步

## License

MIT
