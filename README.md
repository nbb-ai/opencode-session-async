# opencode-session-async

OpenCode 会话跨机同步插件。

## 安装

```bash
opencode plugin add github:nbb-ai/opencode-session-async
```

或手动复制到 `~/.config/opencode/plugins/session-sync/`：
- `index.ts` → 服务端插件
- `tui.ts` → TUI 插件

## 功能

- 把本机 OpenCode 会话自动同步到你自己的 GitHub 私有仓库
- 多台电脑之间近实时双向同步（最后写入者胜出）
- 换电脑后打开 opencode 即可看到全部历史会话
- 会话结束自动增量上传，其它机器的会话自动导入

## 首次使用

1. 打开 opencode，TUI 弹出「会话跨机同步」对话框
2. 点击「连接 GitHub」，浏览器完成授权（设备流）
3. 插件自动在你的账号下创建私有仓库 `opencode-sessions`
4. 开始首次全量同步

无需安装 gh CLI，纯浏览器授权。

## 配置

`~/.config/opencode/session-sync.json`：

```jsonc
{
  "enabled": true,
  "repoName": "opencode-sessions",   // 仓库名
  "owner": null,                     // GitHub 账号（null = 授权的账号）
  "authMode": "device",              // device(纯设备流) | auto(优先 gh) | gh
  "deviceFlowClientId": "Ov23xxxx", // 你的 OAuth App client_id
  "interval": 120,                   // 定时同步间隔（秒）
  "maxSessionMB": 32,                // 单会话快照上限
  "onConflict": "replace"            // replace(远端新则替换本地) | keep-local
}
```

## 命令

```
/session-sync          # 状态
/session-sync now      # 立即同步
/session-sync setup    # 引导登录
/session-sync gc 90    # 清理 90 天前的快照
/session-sync doctor   # 自检
```

## 技术细节

| 项 | 说明 |
|---|---|
| 同步粒度 | 每个会话一个 gzip 文件 |
| 冲突处理 | 最后写入者胜出（time.updated 最大者） |
| 更新已有会话 | 备份 → 删除 → 导入 → 校验 → 失败回滚 |
| 删除传播 | tombstone 机制 |
| 存储 | GitHub 私有仓库（git 增量传输） |
| 凭据 | macOS 钥匙串 / token.txt（Linux） |
| 授权 | GitHub 设备流（OAuth App） |

## License

MIT
