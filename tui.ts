/**
 * session-sync 的 TUI 侧：状态展示 + 首次连接引导 + 调色板命令
 *
 * 与服务端插件通过两个文件通道解耦：
 *   读  ~/.local/share/opencode/sync/state.json   → 状态 / 授权验证码
 *   写  ~/.local/share/opencode/sync/requests/*.json → 触发动作（setup / sync / check）
 */

import { Plugin } from "@opencode/plugin/tui"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

const HOME = os.homedir()
const SYNC_DIR = path.join(HOME, ".local", "share", "opencode", "sync")
const STATE_FILE = path.join(SYNC_DIR, "state.json")
const REQ_DIR = path.join(SYNC_DIR, "requests")

function readState(): any {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
  } catch {
    return {}
  }
}

/** 写一个请求文件，服务端插件会在 3 秒内处理 */
function request(action: string) {
  try {
    fs.mkdirSync(REQ_DIR, { recursive: true })
    fs.writeFileSync(path.join(REQ_DIR, `${action}-${Date.now()}.json`), JSON.stringify({ action, at: Date.now() }))
  } catch {}
}

function statusLine(st: any): string {
  if (!st || !st.status || st.status === "unknown") return "会话同步：未初始化"
  if (st.status === "needs-setup") return "会话同步：待连接 GitHub"
  if (st.status === "needs-auth") return "会话同步：等待 GitHub 授权"
  if (st.status === "error") return `会话同步：出错${st.error ? "（" + st.error + "）" : ""}`
  const t = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleTimeString() : "-"
  return `会话同步：${t}`
}

export default Plugin.define({
  id: "session-sync-tui",
  setup(ctx: any) {
    let lastStatus = ""
    let asked = false
    let layer: any = null

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
      try {
        ctx.ui.toast.show({ message, variant })
      } catch {}
    }

    /** 状态变化时的引导 */
    const check = async () => {
      const st = readState()
      const status = st.status || "unknown"
      try {
        fs.mkdirSync(SYNC_DIR, { recursive: true })
        fs.writeFileSync(
          path.join(SYNC_DIR, "tui-state.json"),
          JSON.stringify({ status, at: Date.now(), repo: st.repo ?? null }, null, 2),
        )
      } catch {}
      if (status === lastStatus) return
      const prev = lastStatus
      lastStatus = status

      try {
        const needSetup = status === "needs-setup" || (status === "ok" && !st.repo)
        if (needSetup && !asked) {
          asked = true
          const yes = await ctx.ui.dialog.confirm({
            title: "会话跨机同步",
            message:
              "把 OpenCode 的会话自动同步到你自己的 GitHub 私有仓库？\n\n" +
              "· 换一台电脑后，打开 opencode 就能看到全部历史会话\n" +
              "· 会话内容存放在你的账号下，仓库强制私有\n" +
              "· 之后自动进行，无需再管",
            label: { confirm: "连接 GitHub", cancel: "暂不" },
          })
          if (yes) {
            request("setup")
            toast("正在准备 GitHub 授权…", "info")
          }
        } else if (status === "needs-auth" && st.authRequest) {
          toast(`请在浏览器授权：${st.authRequest.url}  验证码 ${st.authRequest.code}`, "warning")
          try {
            await ctx.ui.dialog.alert({
              title: "GitHub 授权",
              message:
                `请在浏览器打开：\n${st.authRequest.url}\n\n` +
                `验证码：${st.authRequest.code}\n\n` +
                "授权后会自动创建私有仓库并开始同步。",
            })
          } catch {}
        } else if (status === "ok" && prev === "needs-auth") {
          toast("已连接 GitHub，会话同步已开启", "success")
        } else if (status === "error") {
          toast(`会话同步出错：${st.error || "未知错误"}`, "error")
        }
      } catch {}
    }

    /** 调色板命令 */
    const openMenu = async () => {
      const st = readState()
      let choice = ""
      try {
        choice = await ctx.ui.dialog.select({
          title: "会话跨机同步",
          current: "sync",
          options: [
            { title: "立即同步", value: "sync", description: "马上导出/导入一次" },
            { title: "连接 / 重新连接 GitHub", value: "setup", description: st.repo ? st.repo : "未连接" },
            { title: "查看状态", value: "status" },
          ],
        })
      } catch {
        return
      }
      if (choice === "sync") {
        request("sync")
        toast("已触发同步", "info")
      } else if (choice === "setup") {
        request("setup")
        toast("正在连接 GitHub…", "info")
      } else if (choice === "status") {
        try {
          await ctx.ui.dialog.alert({
            title: "会话同步状态",
            message:
              `${statusLine(st)}\n\n` +
              (st.repo ? `仓库：${st.repo}\n` : "") +
              (st.lastResult ? `上次结果：${st.lastResult}\n` : "") +
              (st.error ? `错误：${st.error}` : ""),
          })
        } catch {}
      }
    }

    try {
      layer = ctx.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "session-sync.menu",
            title: "会话同步",
            group: "OpenCode",
            palette: true,
            run: async () => {
              await openMenu()
            },
          },
        ],
      }))
    } catch {}

    const timer = setInterval(() => void check(), 3000)
    timer.unref?.()
    setTimeout(() => void check(), 1500)

    return () => {
      clearInterval(timer)
      try {
        layer?.dispose?.()
      } catch {}
    }
  },
})
