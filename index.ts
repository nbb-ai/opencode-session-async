/**
 * OpenCode 会话跨机同步插件
 *
 * 作用：把本机会话自动同步到用户自己的 GitHub 私有仓库，多台电脑之间近实时双向同步。
 *
 * 首次使用（尽量傻瓜）：
 *   1. 插件启动检测到未配置 -> 引导登录 GitHub
 *      · 优先复用本机 gh CLI 的登录态
 *      · 没有 gh 则用 GitHub 设备流登录（浏览器点一次授权）
 *   2. 登录后自动在用户自己的账号下创建私有仓库 opencode-sessions
 *   3. 自动初始化本地工作副本，首次全量导出并推送
 *   之后全自动：会话结束即增量上传，别的机器的会话自动拉取导入
 *
 * 同步语义：最后写入者胜出（按会话 time.updated），不做字符级合并。
 */

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import zlib from "node:zlib"
import crypto from "node:crypto"
import { execFile, spawnSync } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

// 运行时自带 @opencode/plugin；取不到就退回等价实现，保证插件永远能加载
let Plugin: any = { define: (x: any) => x }
try {
  const mod: any = await import("@opencode/plugin")
  if (mod?.Plugin) Plugin = mod.Plugin
} catch {}

/* ------------------------------------------------------------------ paths */
const HOME = os.homedir()
const CONFIG_DIR = path.join(HOME, ".config", "opencode")
const CONFIG_FILE = path.join(CONFIG_DIR, "session-sync.json")
const DATA_DIR = path.join(HOME, ".local", "share", "opencode")
const SYNC_DIR = path.join(DATA_DIR, "sync")
const SNAP_DIR = path.join(SYNC_DIR, "snap")
const IDX_DIR = path.join(SYNC_DIR, "idx")
const BACKUP_DIR = path.join(SYNC_DIR, "backup")
const STATE_FILE = path.join(SYNC_DIR, "state.json")
const LOCK_FILE = path.join(SYNC_DIR, "sync.lock")
const LOG_FILE = path.join(SYNC_DIR, "sync.log")
const SERVICE_FILE = path.join(HOME, ".local", "state", "opencode", "service.json")
const KEYCHAIN = "opencode-session-sync"
const CRED_HELPER = path.join(SYNC_DIR, "credential-helper.sh")
const REQ_DIR = path.join(SYNC_DIR, "requests")

const DEFAULT_CONFIG: any = {
  enabled: true,
  repoName: "opencode-sessions",
  owner: null,
  transport: "auto",
  interval: 120,
  debounce: 15,
  sanitize: false,
  maxSessionMB: 32,
  gcDays: 90,
  maxRepoMB: 800,
  defaultDirectory: null,
  onConflict: "replace",
  deviceFlowClientId: "Ov23liaqbVg1uEiIxNhc",
  remap: {},
}

/* ------------------------------------------------------------------- util */
function log(level: string, msg: string) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`
  try {
    fs.mkdirSync(SYNC_DIR, { recursive: true })
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + ".1")
    }
    fs.appendFileSync(LOG_FILE, line + "\n")
  } catch {}
  if (level === "ERROR") console.error("[session-sync] " + msg)
}

function readJSON(file: string, fallback: any) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

function writeJSON(file: string, data: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

/** 同步状态：供 TUI 插件读取（引导配置 / 显示状态） */
function readState(): any {
  return readJSON(STATE_FILE, { status: "unknown", lastSyncAt: 0, lastResult: "" })
}

function writeState(patch: any) {
  const cur = readState()
  const next = { ...cur, ...patch, updatedAt: Date.now() }
  try {
    writeJSON(STATE_FILE, next)
  } catch {}
}

function ensureDirs() {
  for (const d of [SYNC_DIR, SNAP_DIR, IDX_DIR, BACKUP_DIR]) fs.mkdirSync(d, { recursive: true })
  try {
    fs.chmodSync(SYNC_DIR, 0o700)
  } catch {}
}

function machineId(): string {
  const state = readJSON(STATE_FILE, {})
  if (state.machineID) return state.machineID
  const host = (os.hostname() || "machine").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 24)
  const id = `${host}-${crypto.randomBytes(3).toString("hex")}`
  state.machineID = id
  state.createdAt = state.createdAt || Date.now()
  writeJSON(STATE_FILE, state)
  return id
}

async function sh(cmd: string, args: string[], cwd?: string, env?: Record<string, string>) {
  try {
    const r = await exec(cmd, args, { cwd, timeout: 900_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...(env || {}) } })
    return { code: 0, out: r.stdout || "", err: r.stderr || "" }
  } catch (e: any) {
    return { code: e?.code ?? 1, out: e?.stdout || "", err: e?.stderr || e?.message || String(e) }
  }
}

/* ------------------------------------------------------------------- lock */
// 插件按项目位置加载，同一进程里会有多个实例；每次加载都是独立的模块实例，
// 所以状态要挂在 globalThis 上，否则多实例会并发跑同步、抢同一个 git 仓库的 index.lock。
const G = globalThis as any
G.__opencodeSessionSync = G.__opencodeSessionSync || { active: false, instance: Math.random().toString(36).slice(2) }
const SYNC_STATE = G.__opencodeSessionSync

function acquireLock(): boolean {
  ensureDirs()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 原子创建：多个插件实例（按项目位置加载）同时抢锁时只有一个能成功
      const fd = fs.openSync(LOCK_FILE, "wx")
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      return true
    } catch (e: any) {
      if (e?.code !== "EEXIST") return false
      let pid = 0
      try {
        pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim())
      } catch {}
      let alive = false
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0)
          alive = true
        } catch {}
      }
      if (alive) return false // 别的实例正在同步
      try {
        fs.unlinkSync(LOCK_FILE) // 残留的僵死锁
      } catch {}
    }
  }
  return false
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE)
  } catch {}
}

/* -------------------------------------------------------------- keychain */
function keychainSet(token: string, _account: string): boolean {
  let ok = false
  // 钥匙串（macOS）
  try {
    const r = spawnSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN, "-a", "default", "-w", token], {
      encoding: "utf8",
    })
    ok = r.status === 0
  } catch {}
  // 文件版 fallback（Linux / 钥匙串不可用时）
  try {
    fs.mkdirSync(SYNC_DIR, { recursive: true })
    fs.writeFileSync(path.join(SYNC_DIR, "token.txt"), token, { mode: 0o600 })
    ok = true
  } catch {}
  return ok
}

function keychainGetAny(): string | null {
  // 文件版 fallback（Linux / 无钥匙串环境 / 测试）
  try {
    const tf = path.join(SYNC_DIR, "token.txt")
    if (fs.existsSync(tf)) return fs.readFileSync(tf, "utf8").trim()
  } catch {}
  try {
    const r = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN, "-a", "default", "-w"], { encoding: "utf8" })
    if (r.status === 0 && r.stdout) return String(r.stdout).trim()
  } catch {}
  return null
}

function keychainGet(_account: string): string | null {
  // 文件版 fallback（Linux / 无钥匙串环境 / 测试）
  try {
    const tf = path.join(SYNC_DIR, "token.txt")
    if (fs.existsSync(tf)) return fs.readFileSync(tf, "utf8").trim()
  } catch {}
  try {
    const r = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN, "-a", "default", "-w"], { encoding: "utf8" })
    if (r.status === 0 && r.stdout) return String(r.stdout).trim()
  } catch {}
  return null
}

/* --------------------------------------------------------------- github 鉴权 */
async function ghToken(): Promise<{ token: string; login: string } | null> {
  const st = await sh("gh", ["auth", "status"])
  if (st.code !== 0) return null
  const tok = await sh("gh", ["auth", "token"])
  const token = tok.out.trim()
  if (!token) return null
  const who = await sh("gh", ["api", "user", "--jq", ".login"])
  const login = who.out.trim()
  if (!login) return null
  return { token, login }
}

/** GitHub 设备流第一步：申请设备码 */
async function requestDeviceCode(clientId: string): Promise<any | null> {
  try {
    const res = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, scope: "repo" }),
    })
    if (!res.ok) {
      log("ERROR", `设备流申请失败: HTTP ${res.status}`)
      return null
    }
    return await res.json()
  } catch (e: any) {
    log("ERROR", `设备流申请失败: ${e?.message}`)
    return null
  }
}

/** GitHub 设备流第二步：轮询换 token */
async function pollDeviceToken(clientId: string, deviceCode: string): Promise<string | null> {
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000))
    try {
      const poll = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      })
      const p: any = await poll.json()
      if (p.access_token) return p.access_token
      if (p.error && p.error !== "authorization_pending" && p.error !== "slow_down") {
        log("ERROR", `设备流登录失败: ${p.error}`)
        return null
      }
    } catch {}
  }
  return null
}

async function ghApi(method: string, p: string, token: string, body?: any) {
  try {
    const res = await fetch("https://api.github.com" + p, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "opencode-session-sync",
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data: any = null
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    return { ok: res.ok, status: res.status, data }
  } catch (e: any) {
    return { ok: false, status: 0, data: String(e) }
  }
}

async function ensureAuth(cfg: any): Promise<{ token: string; login: string } | null> {
  const owner = cfg.owner
  if (owner) {
    const cached = keychainGet(owner)
    if (cached) {
      const who = await ghApi("GET", "/user", cached)
      if (who.ok) {
        writeState({ status: "ok", auth: { login: who.data.login }, authRequest: null, error: null })
        return { token: cached, login: who.data.login }
      }
    }
  }
  // authMode: auto(优先复用 gh) | device(强制浏览器设备流) | gh(只用 gh)
  const mode = cfg.authMode || "auto"
  // device 模式优先用钥匙串里（设备流授权过）的 token；auto/gh 模式优先用 gh
  const useCached = async (): Promise<{ token: string; login: string } | null> => {
    if (owner) return null
    const any = keychainGetAny()
    if (!any) return null
    const who = await ghApi("GET", "/user", any)
    if (!who.ok) return null
    writeConfig({ ...readConfig(), owner: who.data.login })
    writeState({ status: "ok", auth: { login: who.data.login }, authRequest: null, error: null })
    return { token: any, login: who.data.login }
  }
  if (mode === "device") {
    const cached = await useCached()
    if (cached) return cached
  }
  let auth = mode === "device" ? null : await ghToken()
  if (auth) {
    keychainSet(auth.token, auth.login)
    writeState({ status: "ok", auth: { login: auth.login }, authRequest: null, error: null })
    return auth
  }
  if (mode !== "device") {
    const cached = await useCached()
    if (cached) return cached
  }
  if (cfg.deviceFlowClientId) {
    if (readState().status !== "needs-auth") startDeviceFlow(cfg)
    return null
  }
  writeState({
    status: "needs-setup",
    error: null,
    hint: "未检测到 GitHub 登录态：可安装 gh 后执行 gh auth login，或在 session-sync.json 填 deviceFlowClientId 走浏览器授权",
  })
  return null
}

/** 设备流：立刻把验证码写进状态文件（TUI 弹窗展示），后台等待授权 */
function startDeviceFlow(cfg: any) {
  void (async () => {
    const data = await requestDeviceCode(cfg.deviceFlowClientId)
    if (!data) {
      writeState({ status: "error", error: "设备流申请失败" })
      return
    }
    const url = data.verification_uri_complete || data.verification_uri
    const code = data.user_code
    writeState({ status: "needs-auth", authRequest: { url, code, at: Date.now() }, error: null })
    console.error(`\n[session-sync] 请在浏览器打开 ${url}\n           验证码: ${code}\n`)
    log("INFO", `等待 GitHub 授权: ${url} code=${code}`)
    const token = await pollDeviceToken(cfg.deviceFlowClientId, data.device_code)
    if (!token) {
      writeState({ status: "needs-auth", authRequest: null, error: "授权超时或被取消" })
      return
    }
    let login = "unknown"
    try {
      const who = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "opencode-session-sync" },
      })
      if (who.ok) login = (await who.json()).login
    } catch {}
    keychainSet(token, login)
    // 授权的账号即仓库归属（数据存在用户自己的账号下）
    writeConfig({ ...readConfig(), owner: login })
    writeState({ status: "ok", authRequest: null, auth: { login }, error: null })
    log("INFO", `GitHub 授权成功: ${login}`)
    setTimeout(() => void syncRound(readConfig(), { force: true }).catch(() => {}), 800)
  })()
}

/* -------------------------------------------------------- opencode 本地 API */
let apiCache: { base: string; auth: string; at: number } | null = null

function apiAuth(): { base: string; auth: string } {
  if (apiCache && Date.now() - apiCache.at < 30_000) return apiCache
  const svc = readJSON(SERVICE_FILE, null)
  if (!svc?.url || !svc?.password) {
    throw new Error(`读不到后台服务信息 ${SERVICE_FILE}（opencode 可能以 standalone 模式运行）`)
  }
  const auth = "Basic " + Buffer.from(`opencode:${svc.password}`).toString("base64")
  apiCache = { base: svc.url.replace(/\/$/, ""), auth, at: Date.now() }
  return apiCache
}

async function api(method: string, p: string, body?: any, timeout = 300_000) {
  const { base, auth } = apiAuth()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(base + p, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    const text = await res.text()
    let data: any = null
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    if (data && typeof data === "object" && "data" in data) return { status: res.status, data: data.data }
    return { status: res.status, data }
  } finally {
    clearTimeout(timer)
  }
}

const listSessions = async () => {
  const r = await api("GET", "/api/session?limit=20000")
  return Array.isArray(r.data) ? r.data : []
}
const exportSession = (id: string) => api("GET", `/api/experimental/session/${id}/export`)
const deleteSession = (id: string) => api("DELETE", `/api/session/${id}`)

async function importSession(payload: any, directory: string) {
  return api("POST", "/api/experimental/session/import", {
    info: payload.session ?? payload.info,
    messages: payload.messages,
    location: { directory },
  })
}

/* --------------------------------------------------------------- 目录映射 */
function resolveDirectory(original: string, cfg: any): string {
  const remap = cfg.remap || {}
  if (original && remap[original]) return remap[original]
  if (original && fs.existsSync(original) && fs.statSync(original).isDirectory()) return original
  const parts = (original || "").split("/")
  if (parts.length > 2 && /^\/(Users|home)\//.test(original)) {
    const oldHome = parts.slice(0, 3).join("/")
    if (oldHome !== HOME) {
      const candidate = HOME + original.slice(oldHome.length)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  const fallback = cfg.defaultDirectory || process.cwd()
  try {
    fs.mkdirSync(fallback, { recursive: true })
  } catch {}
  return fallback
}

/* ---------------------------------------------------------------- 快照存储 */
const idxPath = (machine: string) => path.join(IDX_DIR, `${machine}.json`)

function readAllIdx(): Record<string, any> {
  const merged: Record<string, any> = {}
  let files: string[] = []
  try {
    files = fs.readdirSync(IDX_DIR)
  } catch {
    return merged
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue
    const idx = readJSON(path.join(IDX_DIR, f), null)
    if (!idx?.sessions) continue
    for (const [sid, entry] of Object.entries<any>(idx.sessions)) {
      const prev = merged[sid]
      if (!prev) merged[sid] = { ...entry, machine: idx.machine }
      else if (entry.deleted && !prev.deleted) merged[sid] = { ...entry, machine: idx.machine }
      else if (!!entry.deleted === !!prev.deleted && (entry.timeUpdated || 0) > (prev.timeUpdated || 0))
        merged[sid] = { ...entry, machine: idx.machine }
    }
  }
  return merged
}

function writeSnapshot(machine: string, sid: string, payload: any) {
  const blob = zlib.gzipSync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 6 })
  const rel = path.join("snap", `${sid}.${machine}.json.gz`)
  const abs = path.join(SYNC_DIR, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, blob)
  return { file: rel, bytes: blob.length }
}

function readSnapshot(rel: string): any {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SYNC_DIR, rel))).toString("utf8"))
}

/* ------------------------------------------------------------------- git */
// git 的 credential.helper 是叠加的：系统级 osxkeychain + 全局 store 会抢先返回旧凭据，
// 必须用空的 helper 复位，再用只读钥匙串的 helper；GIT_ASKPASS 作为兜底。
const git = (args: string[]) =>
  sh("git", ["-c", "credential.helper=", ...args], SYNC_DIR, {
    GIT_ASKPASS: CRED_HELPER,
    GIT_TERMINAL_PROMPT: "0",
  })

function writeCredHelper(owner: string) {
  const script = `#!/bin/sh
# opencode session-sync：从 macOS 钥匙串取 GitHub token，不在磁盘留明文
token=$(/usr/bin/security find-generic-password -s ${KEYCHAIN} -a default -w 2>/dev/null)
user="${owner}"
case "$1" in
  get)
    if [ -n "$token" ]; then
      printf 'username=%s\\npassword=%s\\n' "$user" "$token"
    fi
    ;;
  Username)
    printf '%s\\n' "$user"
    ;;
  *)
    [ -n "$token" ] && printf '%s\\n' "$token"
    ;;
esac
`
  fs.mkdirSync(SYNC_DIR, { recursive: true })
  fs.writeFileSync(CRED_HELPER, script, { mode: 0o700 })
}

async function ensureRepo(auth: { token: string; login: string }, cfg: any) {
  const owner = cfg.owner || auth.login
  const repo = cfg.repoName || "opencode-sessions"
  const full = `${owner}/${repo}`

  const check = await ghApi("GET", `/repos/${full}`, auth.token)
  if (!check.ok) {
    log("INFO", `创建 GitHub 私有仓库 ${full}`)
    const created = await ghApi("POST", "/user/repos", auth.token, {
      name: repo,
      private: true,
      auto_init: true,
      description: "OpenCode 会话快照（opencode session-sync 插件自动维护）",
    })
    if (!created.ok) {
      // 并发实例同时创建会收到 422（名字已存在），回查确认即可
      const again = await ghApi("GET", `/repos/${full}`, auth.token)
      if (!again.ok) {
        const msg = JSON.stringify(created.data)
        if (created.status === 403) {
          log(
            "ERROR",
            "创建仓库失败(403)：当前 token 没有建库权限（GitHub App token 不行）。" +
              "改用其一：1) gh auth login 后重试；2) 在 session-sync.json 填入自建 OAuth App 的 client_id",
          )
        } else {
          log("ERROR", `创建仓库失败: ${created.status} ${msg.slice(0, 200)}`)
        }
        writeState({ status: "error", error: "GitHub token 无建库权限，请用 gh 登录或配置自建 OAuth App" })
        return null
      }
      if (again.data?.visibility !== "private") {
        log("ERROR", `仓库 ${full} 不是私有仓库，已停止同步（避免泄露会话内容）`)
        return null
      }
      log("INFO", `仓库已存在并复用: ${full}`)
    } else {
      log("INFO", `仓库已创建: ${full}`)
    }
  } else if (check.data?.visibility !== "private") {
    log("ERROR", `仓库 ${full} 不是私有仓库，已停止同步（避免泄露会话内容）`)
    return null
  }

  const remote = `https://github.com/${full}.git`
  if (!fs.existsSync(path.join(SYNC_DIR, ".git"))) {
    await git(["init", "-q", "-b", "main"])
    // 先造一个空提交，保证 HEAD 永远有效（否则后续同步会走到危险的 checkout -B 分支）
    await git(["commit", "-q", "--allow-empty", "-m", "init: opencode session-sync"])
  }
  const remotes = await git(["remote"])
  if (remotes.out.includes("origin")) await git(["remote", "set-url", "origin", remote])
  else await git(["remote", "add", "origin", remote])
  await git(["config", "user.name", "opencode-session-sync"])
  await git(["config", "user.email", "opencode-session-sync@localhost"])
  // 清空继承自全局的 credential.helper（旧 PAT 无权访问本账号仓库），只用自己的钥匙串 helper
  writeState({ repo: full })
  await git(["config", "--local", "--replace-all", "credential.helper", ""])
  await git(["config", "--local", "--add", "credential.helper", CRED_HELPER])
  writeCredHelper(owner)
  ensureDirs()
  return { owner, repo, full, remote }
}

/* --------------------------------------------------------- TUI 请求处理 */
/** TUI 插件通过在 requests/ 写文件来触发动作（解耦，不依赖 RPC） */
async function handleRequests() {
  let files: string[] = []
  try {
    files = fs.readdirSync(REQ_DIR).filter((f) => f.endsWith(".json"))
  } catch {
    return
  }
  for (const f of files) {
    const abs = path.join(REQ_DIR, f)
    const req = readJSON(abs, {})
    try {
      fs.unlinkSync(abs)
    } catch {}
    const cfg = readConfig()
    try {
      if (req.action === "setup") {
        const auth = await ensureAuth(cfg)
        if (auth) {
          writeConfig({ ...cfg, owner: cfg.owner || auth.login })
          const repo = await ensureRepo(auth, readConfig())
          writeState({
            status: repo ? "ok" : "error",
            repo: repo?.full ?? null,
            auth: { login: auth.login },
            error: repo ? null : "仓库创建失败",
          })
        }
      } else if (req.action === "sync") {
        await syncRound(cfg, { force: true })
      } else if (req.action === "check") {
        await ensureAuth(cfg)
      }
    } catch (e: any) {
      log("ERROR", `处理请求 ${req.action} 失败: ${e?.message}`)
      writeState({ status: "error", error: String(e?.message ?? e) })
    }
  }
}

/* --------------------------------------------------------------- 同步主体 */
type SyncResult = {
  exported: number
  imported: number
  replaced: number
  deleted: number
  skipped: number
  failed: number
  pushed: boolean
  message: string
}

async function syncRound(cfg: any, opts: { push?: boolean; pull?: boolean; force?: boolean } = {}): Promise<SyncResult> {
  const result: SyncResult = {
    exported: 0,
    imported: 0,
    replaced: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
    pushed: false,
    message: "",
  }
  const beat = SYNC_STATE.heartbeat || 0
  if (SYNC_STATE.active && Date.now() - beat < 5 * 60 * 1000) {
    result.message = "本机已有同步在跑，本次跳过"
    return result
  }
  if (SYNC_STATE.active) {
    // 上一次轮次可能随插件热重载被丢弃（心跳不再更新），接管它
    log("WARN", "上一次同步已失去心跳，本轮接管")
    SYNC_STATE.active = false
  }
  if (!acquireLock()) {
    result.message = "另一实例正在同步，本次跳过"
    return result
  }
  SYNC_STATE.active = true
  const phase = (p: string) => {
    SYNC_STATE.phase = p
    SYNC_STATE.heartbeat = Date.now()
    log("INFO", `阶段: ${p}`)
  }
  try {
    phase("准备")
    const machine = machineId()
    // 插件按项目位置多次加载，用最小间隔避免各实例重复做同一件事
    const prevState = readJSON(STATE_FILE, {})
    if (!opts.force && prevState.lastSyncAt && Date.now() - prevState.lastSyncAt < 30_000) {
      result.message = "刚刚同步过，本次跳过"
      return result
    }
    const auth = await ensureAuth(cfg)
    if (!auth) {
      result.message = "未登录 GitHub，本轮跳过（运行 /session-sync setup 查看引导）"
      log("WARN", result.message)
      return result
    }
    const repo = await ensureRepo(auth, cfg)
    if (!repo) {
      result.message = "仓库不可用，本轮跳过"
      return result
    }

    let local: any[] = []
    try {
      local = await listSessions()
    } catch (e: any) {
      result.message = `读取本地会话失败: ${e?.message}`
      log("ERROR", result.message)
      return result
    }
    const localMap = new Map<string, any>(local.map((s: any) => [s.id, s]))

    /* ---------- 1. 导出本地变化的会话 ---------- */
    phase("导出")
    const idxFile = idxPath(machine)
    const idx = readJSON(idxFile, { v: 1, machine, updatedAt: 0, sessions: {} })
    idx.sessions = idx.sessions || {}
    const maxBytes = Math.round((cfg.maxSessionMB || 32) * 1024 * 1024)

    const deadline = Date.now() + 12 * 60 * 1000
    for (const s of local) {
      if (Date.now() > deadline) {
        log("WARN", "导出超时（12 分钟），本轮剩余会话下次再导出")
        break
      }
      const sid = s.id
      const updated = s?.time?.updated || 0
      const prev = idx.sessions[sid]
      // 已导出且文件仍在 -> 跳过（文件被删/损坏时重新导出）
      if (prev && prev.timeUpdated === updated && !prev.deleted && !prev.oversized) {
        const p = path.join(SYNC_DIR, prev.file)
        if (prev.file && fs.existsSync(p)) continue
      }
      try {
        const r = await exportSession(sid)
        if (r.status !== 200 || !r.data?.messages) {
          result.failed++
          log("WARN", `导出失败 ${sid}: ${r.status}`)
          continue
        }
        const payload = {
          v: 1,
          machine,
          sanitized: !!cfg.sanitize,
          session: r.data.info,
          messages: r.data.messages,
        }
        const raw = Buffer.byteLength(JSON.stringify(payload), "utf8")
        if (raw > maxBytes) {
          result.skipped++
          log("WARN", `会话过大已跳过 ${sid} (${(raw / 1048576).toFixed(1)}MB)`)
          // 记进索引，避免每轮都重新导出会浪费带宽
          idx.sessions[sid] = {
            file: "",
            title: s.title || "",
            directory: s?.location?.directory || "",
            projectID: s.projectID,
            timeCreated: s?.time?.created || 0,
            timeUpdated: updated,
            messages: 0,
            bytes: 0,
            oversized: true,
            deleted: false,
            exportedAt: Date.now(),
          }
          continue
        }
        const { file, bytes } = writeSnapshot(machine, sid, payload)
        idx.sessions[sid] = {
          file,
          title: s.title || "",
          directory: s?.location?.directory || "",
          projectID: s.projectID,
          timeCreated: s?.time?.created || 0,
          timeUpdated: updated,
          messages: r.data.messages.length,
          bytes,
          deleted: false,
          exportedAt: Date.now(),
        }
        result.exported++
      } catch (e: any) {
        result.failed++
        log("ERROR", `导出会话 ${sid} 出错: ${e?.message}`)
      }
    }

    /* ---------- 2. 本地已删除的会话 -> tombstone ---------- */
    for (const sid of Object.keys(idx.sessions)) {
      if (localMap.has(sid)) continue
      const prev = idx.sessions[sid]
      if (prev?.deleted) continue
      const rel = path.join("snap", `${sid}.${machine}.json.gz`)
      const abs = path.join(SYNC_DIR, rel)
      const payload = {
        v: 1,
        machine,
        exportedAt: Date.now(),
        deleted: true,
        deletedAt: Date.now(),
        session: { id: sid },
        messages: [],
      }
      fs.writeFileSync(abs, zlib.gzipSync(Buffer.from(JSON.stringify(payload), "utf8"), { level: 6 }))
      idx.sessions[sid] = { ...prev, file: rel, deleted: true, deletedAt: Date.now(), timeUpdated: Date.now() }
      result.deleted++
    }
    idx.updatedAt = Date.now()
    writeJSON(idxFile, idx)

    /* ---------- 3. 本地提交 ---------- */
    phase("提交")
    const add = await git(["add", "--", "snap", "idx"])
    if (add.code !== 0) log("WARN", `git add 失败: ${add.err.slice(0, 200)}`)
    const dirty = await git(["status", "--porcelain", "--", "snap", "idx"])
    if (dirty.out.trim()) {
      const commit = await git(["commit", "-q", "-m", `sync: ${result.exported} 个会话快照 ${new Date().toISOString()}`])
      if (commit.code !== 0) log("WARN", `git commit 失败: ${commit.err.slice(0, 200)}`)
    }

    /* ---------- 4. 拉取远端并合并（绝不做 reset --hard，避免丢本地快照） ---------- */
    phase("拉取合并")
    if (opts.pull !== false) {
      const fetch = await git(["fetch", "origin", "main"])
      if (fetch.code === 0) {
        const has = await git(["rev-parse", "--verify", "origin/main"])
        if (has.code === 0) {
          const head = await git(["rev-parse", "--verify", "HEAD"])
          if (head.code !== 0) {
            // 本地还没有任何提交（首次同步）：直接对齐远端
            await git(["checkout", "-q", "-B", "main", "origin/main"])
          } else {
            // 各机器只写自己带后缀的文件，合并不会冲突
            const merge = await git(["merge", "--no-edit", "-q", "origin/main"])
            if (merge.code !== 0) {
              log("WARN", `合并远端失败，已中止（本轮只推不拉）: ${merge.err.slice(0, 200)}`)
              await git(["merge", "--abort"])
            }
          }
        }
      } else {
        log("WARN", `fetch 失败: ${fetch.err.slice(0, 200)}`)
      }
    }

    /* ---------- 5. 推送 ---------- */
    phase("推送")
    if (opts.push !== false) {
      const push = await git(["push", "origin", "main"])
      if (push.code === 0) {
        const head = await git(["rev-parse", "HEAD"])
        const remote = await git(["rev-parse", "origin/main"])
        result.pushed = head.out.trim() === remote.out.trim()
      } else {
        log("ERROR", `push 失败: ${push.err.slice(0, 300)}`)
      }
    }

    /* ---------- 6. 导入远端更新的会话 ---------- */
    phase("导入")
    if (opts.pull !== false) {
      const merged = readAllIdx()
      for (const [sid, entry] of Object.entries<any>(merged)) {
        const localS = localMap.get(sid)
        try {
          if (!entry.file) {
            result.skipped++ // 超出体积上限的会话没有快照文件
            continue
          }
          if (entry.deleted) {
            if (localS && (entry.deletedAt || 0) >= (localS?.time?.updated || 0)) {
              await backupLocal(sid)
              await deleteSession(sid)
              result.deleted++
              log("INFO", `删除本地会话(远端已删除): ${sid}`)
            } else {
              result.skipped++
            }
            continue
          }
          if (!localS) {
            const payload = readSnapshot(entry.file)
            const dir = resolveDirectory(entry.directory, cfg)
            const r = await importSession(payload, dir)
            if (r.status === 200) {
              result.imported++
              log("INFO", `导入会话 ${sid} -> ${dir}`)
            } else if (r.status === 409) {
              result.skipped++
            } else {
              result.failed++
              log("WARN", `导入失败 ${sid}: ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`)
            }
          } else if (cfg.onConflict === "replace") {
            if ((entry.timeUpdated || 0) > (localS?.time?.updated || 0)) {
              const outcome = await replaceLocal(sid, entry, cfg)
              if (outcome === "replaced") result.replaced++
              else if (outcome === "failed") result.failed++
              else result.skipped++
            } else {
              result.skipped++
            }
          } else {
            result.skipped++
          }
        } catch (e: any) {
          result.failed++
          log("ERROR", `处理会话 ${sid} 出错: ${e?.message}`)
        }
      }
    }

    const state = readJSON(STATE_FILE, {})
    state.lastSyncAt = Date.now()
    state.lastResult = result
    writeJSON(STATE_FILE, state)
    result.message = `导出 ${result.exported}，导入 ${result.imported}，替换 ${result.replaced}，删除 ${result.deleted}，跳过 ${result.skipped}，失败 ${result.failed}${result.pushed ? "，已推送" : ""}`
    const cur = readState()
    const status = cur.status === "needs-auth" || cur.status === "needs-setup" ? cur.status : "ok"
    writeState({ status, lastSyncAt: state.lastSyncAt, lastResult: result.message, error: null })
    log("INFO", result.message)
    return result
  } finally {
    SYNC_STATE.active = false
    releaseLock()
  }
}

async function backupLocal(sid: string): Promise<boolean> {
  try {
    const r = await exportSession(sid)
    if (r.status !== 200) return false
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(BACKUP_DIR, `${sid}.json.gz`),
      zlib.gzipSync(Buffer.from(JSON.stringify(r.data), "utf8"), { level: 6 }),
    )
    return true
  } catch {
    return false
  }
}

/** 用远端版本替换本地会话：备份 -> 删除 -> 导入 -> 校验 -> 失败回滚 */
async function replaceLocal(sid: string, entry: any, cfg: any): Promise<"replaced" | "failed" | "skipped"> {
  if (!(await backupLocal(sid))) {
    log("WARN", `替换 ${sid} 失败：无法备份本地版本，已放弃`)
    return "skipped"
  }
  try {
    await deleteSession(sid)
    const payload = readSnapshot(entry.file)
    const dir = resolveDirectory(entry.directory, cfg)
    const r = await importSession(payload, dir)
    if (r.status !== 200) {
      log("WARN", `替换 ${sid} 导入失败(${r.status})，回滚`)
      await rollbackLocal(sid, cfg)
      return "failed"
    }
    const check = await exportSession(sid)
    if (!(check.status === 200 && check.data?.messages?.length === payload.messages.length)) {
      log("WARN", `替换 ${sid} 校验不一致，回滚`)
      await rollbackLocal(sid, cfg)
      return "failed"
    }
    log("INFO", `本地会话 ${sid} 已替换为远端版本`)
    return "replaced"
  } catch (e: any) {
    log("ERROR", `替换 ${sid} 出错: ${e?.message}`)
    await rollbackLocal(sid, cfg)
    return "failed"
  }
}

async function rollbackLocal(sid: string, cfg: any): Promise<boolean> {
  const f = path.join(BACKUP_DIR, `${sid}.json.gz`)
  if (!fs.existsSync(f)) return false
  try {
    const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"))
    const dir = resolveDirectory(payload?.info?.location?.directory || "", cfg)
    const r = await importSession(payload, dir)
    return r.status === 200
  } catch {
    return false
  }
}

/* --------------------------------------------------------------- 其它命令 */
async function status(): Promise<string> {
  const cfg = readConfig()
  const state = readJSON(STATE_FILE, {})
  const machine = machineId()
  const idx = readJSON(idxPath(machine), { sessions: {} })
  const merged = readAllIdx()
  let localCount = 0
  let pending = 0
  try {
    const local = await listSessions()
    localCount = local.length
    const localMap = new Map<string, any>(local.map((s: any) => [s.id, s]))
    for (const s of local) {
      const prev = idx.sessions?.[s.id]
      if (!prev || prev.timeUpdated !== (s?.time?.updated || 0)) pending++
    }
    for (const sid of Object.keys(idx.sessions || {})) if (!localMap.has(sid)) pending++
  } catch {}
  let dirSize = 0
  try {
    for (const f of fs.readdirSync(SNAP_DIR)) dirSize += fs.statSync(path.join(SNAP_DIR, f)).size
  } catch {}
  return [
    `仓库      : ${cfg.owner ? `${cfg.owner}/${cfg.repoName}` : "(未配置)"}`,
    `本机标识  : ${machine}`,
    `本地会话  : ${localCount}`,
    `快照会话  : ${Object.keys(merged).length}（本机索引 ${Object.keys(idx.sessions || {}).length}）`,
    `待同步    : ${pending}`,
    `快照体积  : ${(dirSize / 1048576).toFixed(1)} MB`,
    `上次同步  : ${state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : "从未"}`,
    `上次结果  : ${state.lastResult?.message ?? "-"}`,
    `日志      : ${LOG_FILE}`,
  ].join("\n")
}

async function gc(cfg: any, days: number, squash: boolean): Promise<string> {
  const cutoff = Date.now() - days * 86400_000
  const merged = readAllIdx()
  const machine = machineId()
  const idx = readJSON(idxPath(machine), { v: 1, machine, sessions: {} })
  idx.sessions = idx.sessions || {}
  let removed = 0
  let freed = 0
  for (const [sid, entry] of Object.entries<any>(merged)) {
    if (entry.machine === machine) continue
    const own = idx.sessions[sid]
    if (!own) continue
    if ((own.timeUpdated || 0) > (entry.timeUpdated || 0)) continue
    const p = path.join(SYNC_DIR, own.file)
    if (fs.existsSync(p)) {
      freed += fs.statSync(p).size
      fs.unlinkSync(p)
    }
    delete idx.sessions[sid]
    removed++
  }
  for (const [sid, entry] of Object.entries<any>(merged)) {
    if (entry.machine !== machine) continue
    if ((entry.timeUpdated || 0) > cutoff) continue
    const own = idx.sessions[sid]
    if (!own) continue
    const p = path.join(SYNC_DIR, own.file)
    if (fs.existsSync(p)) {
      freed += fs.statSync(p).size
      fs.unlinkSync(p)
    }
    delete idx.sessions[sid]
    removed++
  }
  writeJSON(idxPath(machine), idx)

  let squashed = false
  if (squash) {
    await git(["checkout", "--orphan", "clean"])
    await git(["add", "-A"])
    await git(["commit", "-q", "-m", "squash: 仅保留当前快照状态"])
    await git(["push", "--force", "origin", "clean:main"])
    await git(["checkout", "-q", "main"])
    squashed = true
  }
  await git(["add", "-A"])
  await git(["commit", "-q", "-m", `gc: 清理 ${removed} 个过期快照`])
  await git(["push", "origin", "main"])
  return `清理 ${removed} 个快照，释放 ${(freed / 1048576).toFixed(1)} MB${squashed ? "，已重写历史" : ""}`
}

async function doctor(): Promise<string> {
  const cfg = readConfig()
  const auth = await ghToken()
  const lines = [
    `配置文件  : ${CONFIG_FILE} ${fs.existsSync(CONFIG_FILE) ? "存在" : "缺失(用默认值)"}`,
    `gh 登录   : ${auth ? auth.login : "未登录"}`,
    `钥匙串    : ${keychainGet(cfg.owner || auth?.login || "") ? "有 token" : "无 token"}`,
    `快照目录  : ${SYNC_DIR}`,
    `git 仓库  : ${fs.existsSync(path.join(SYNC_DIR, ".git")) ? "已初始化" : "未初始化"}`,
    `后台服务  : ${readJSON(SERVICE_FILE, null)?.url || "未运行(standalone?)"}`,
  ]
  try {
    lines.push(`本地会话  : ${(await listSessions()).length}`)
  } catch (e: any) {
    lines.push(`本地会话  : 读取失败 ${e?.message}`)
  }
  lines.push(`日志      : ${LOG_FILE}`)
  return lines.join("\n")
}

/* ------------------------------------------------------------------ 配置 */
function readConfig(): any {
  return { ...DEFAULT_CONFIG, ...readJSON(CONFIG_FILE, {}) }
}
function writeConfig(cfg: any) {
  writeJSON(CONFIG_FILE, cfg)
}

/* ------------------------------------------------------------------ 入口 */
export default Plugin.define({
  id: "session-sync",
  async setup(ctx: any) {
    const cfg = readConfig()
    if (cfg.enabled === false) return

    const controller = new AbortController()
    let timer: any = null
    let debounceTimer: any = null
    let running = false

    const run = async (why: string) => {
      if (running) return
      running = true
      try {
        const r = await syncRound(readConfig())
        log("INFO", `[${why}] ${r.message}`)
      } catch (e: any) {
        log("ERROR", `[${why}] 同步失败: ${e?.message}`)
      } finally {
        running = false
      }
    }

    // 命令：/session-sync [status|now|setup|gc|doctor]
    try {
      await ctx.command.transform((editor: any) => {
        editor.add({
          name: "session-sync",
          description: "会话跨机同步：status 状态 / now 立即同步 / setup 引导登录 GitHub / gc 清理 / doctor 自检",
          execute: async (input: any) => {
            const sessionID = input?.sessionID
            const raw = String(input?.prompt?.text ?? "").trim()
            const arg = raw.replace(/^\/?session-sync\s*/i, "").trim() || "status"
            const c = readConfig()
            let text = ""
            try {
              if (arg.startsWith("now") || arg.startsWith("sync")) {
                const r = await syncRound(c, { force: true })
                text = "同步完成：" + r.message
              } else if (arg.startsWith("setup")) {
                const auth = await ensureAuth(c)
                if (!auth) {
                  const st = readState()
                  if (st.authRequest) {
                    text = [
                      "请在浏览器打开下面的地址，用 GitHub 账号授权：",
                      st.authRequest.url,
                      `验证码: ${st.authRequest.code}`,
                      "授权完成后会自动开始同步。",
                    ].join("\n")
                  } else {
                    text = [
                      "未能登录 GitHub，请任选一种方式后重试 /session-sync setup：",
                      "1) brew install gh && gh auth login（最简单）",
                      "2) 在 session-sync.json 填 deviceFlowClientId（GitHub OAuth App 的 client id），插件会引导浏览器授权",
                      "3) 配置 SSH key，并把 transport 改成 ssh",
                    ].join("\n")
                  }
                } else {
                  writeConfig({ ...c, owner: c.owner || auth.login })
                  const repo = await ensureRepo(auth, readConfig())
                  text = repo
                    ? `已登录 ${auth.login}，私有仓库 ${repo.full} 就绪，同步已自动开启。`
                    : `仓库创建失败，详见 ${LOG_FILE}`
                }
              } else if (arg.startsWith("gc")) {
                const days = Number(arg.split(/\s+/)[1]) || c.gcDays || 90
                text = await gc(c, days, arg.includes("--squash"))
              } else if (arg.startsWith("doctor")) {
                text = await doctor()
              } else {
                text = await status()
              }
            } catch (e: any) {
              text = `执行出错: ${e?.message}`
            }
            try {
              await ctx.session.synthetic({ sessionID, text })
            } catch {}
          },
        })
      })
    } catch (e: any) {
      log("ERROR", `注册命令失败: ${e?.message}`)
    }

    // 事件 -> 防抖 -> 同步
    try {
      void (async () => {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          const t = String((ev as any)?.type || "")
          if (!t.startsWith("session.")) continue
          if (!/idle|updated|deleted|created/.test(t)) continue
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => void run("事件 " + t), Math.max(5, cfg.debounce || 15) * 1000)
        }
      })()
    } catch (e: any) {
      log("ERROR", `事件订阅失败: ${e?.message}`)
    }

    // 定时同步
    timer = setInterval(() => void run("定时"), Math.max(30, cfg.interval || 120) * 1000)
    timer.unref?.()

    // 处理 TUI 发来的动作请求
    const reqTimer = setInterval(() => void handleRequests(), 3000)
    reqTimer.unref?.()

    // 启动即同步
    setTimeout(() => void run("启动"), 2000)

    return () => {
      controller.abort()
      if (timer) clearInterval(timer)
      if (reqTimer) clearInterval(reqTimer)
      if (debounceTimer) clearTimeout(debounceTimer)
      log("INFO", "插件卸载")
    }
  },
})
