import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { commandExists, workspaceDirectory } from './sessions.ts'

export interface DeckSettings {
  workspace: string
  maxSessions: number
  defaultModel: string
  codexProfile: string
  codexAccountId: string
  historyDays: number
}

export interface CodexAccountSummary { id: string; label: string; email: string | null; authMode: string | null }

export interface DelegateTask { label: string; prompt: string }
export interface DelegatedChild {
  id: string
  label: string
  provider: 'codex'
  model: string
  state: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: number
  endedAt: number | null
  exitCode: number | null
}
export interface RunGroup {
  callId: string
  sessionId: string
  createdAt: number
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  children: DelegatedChild[]
}

const SAFE_OPTION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const MAX_OUTPUT_CHARS = 200_000

function groupKey(callId: string): string {
  return createHash('sha256').update(callId).digest('hex')
}

function snapshot(group: RunGroup): RunGroup {
  return { ...group, children: group.children.map(child => ({ ...child })) }
}

export function validateSettings(value: DeckSettings): DeckSettings {
  if (typeof value.workspace !== 'string' || value.workspace.length === 0) throw new Error('workspace must be a directory path')
  if (!Number.isSafeInteger(value.maxSessions) || value.maxSessions < 1 || value.maxSessions > 32) throw new Error('maxSessions must be 1–32')
  if (!Number.isSafeInteger(value.historyDays) || value.historyDays < 1 || value.historyDays > 365) throw new Error('historyDays must be 1–365')
  for (const [name, field] of [['defaultModel', value.defaultModel], ['codexProfile', value.codexProfile], ['codexAccountId', value.codexAccountId]] as const) {
    if (typeof field !== 'string' || field !== '' && !SAFE_OPTION.test(field)) throw new Error(`${name} contains unsupported characters`)
  }
  return { ...value }
}

export function dataDirectory(): string {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'agent-deck')
}

interface ActiveGroup {
  group: RunGroup
  output: Map<string, string>
  processes: Set<ChildProcessWithoutNullStreams>
  writes: Promise<void>
}

export class RunGroupStore {
  private readonly active = new Map<string, ActiveGroup>()
  private readonly recordWrites = new Map<string, Promise<void>>()
  private settings: DeckSettings

  constructor(readonly root: string, initial: DeckSettings) {
    this.settings = validateSettings(initial)
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
    try {
      const persisted = JSON.parse(await readFile(join(this.root, 'settings.json'), 'utf8')) as DeckSettings
      this.settings = validateSettings({ ...this.settings, ...persisted,
        workspace: this.settings.workspace, maxSessions: this.settings.maxSessions })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw error
    }
  }

  getSettings(): DeckSettings { return { ...this.settings } }

  async codexProfiles(): Promise<string[]> {
    try {
      const base = process.env.AGENT_SWITCH_PROFILE_HOME || join(homedir(), '.agent-switch', 'profiles')
      const entries = await readdir(join(base, 'codex'), { withFileTypes: true })
      return entries.filter(entry => entry.isDirectory() && SAFE_OPTION.test(entry.name)).map(entry => entry.name).sort()
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
  }

  async codexAccounts(): Promise<CodexAccountSummary[]> {
    const base = process.env.AGENT_SWITCH_PROFILE_HOME || join(homedir(), '.agent-switch', 'profiles')
    try {
      const index = JSON.parse(await readFile(join(base, 'codex', '.accounts', 'index.json'), 'utf8')) as { accounts?: unknown }
      const accounts = Array.isArray(index.accounts) ? index.accounts as unknown[] : []
      return accounts.filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).id === 'string')
        .map(item => ({ id: String(item.id), label: typeof item.label === 'string' ? item.label : String(item.id),
          email: typeof item.email === 'string' ? item.email : null, authMode: typeof item.authMode === 'string' ? item.authMode : null }))
        .filter(item => SAFE_OPTION.test(item.id))
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
  }

  async setSettings(value: DeckSettings): Promise<DeckSettings> {
    const next = validateSettings({ ...value, workspace: this.settings.workspace, maxSessions: this.settings.maxSessions })
    if (next.codexProfile && next.codexAccountId && !(await this.codexAccounts()).some(account => account.id === next.codexAccountId)) {
      throw new Error('Selected Codex account is no longer saved in agent-switch')
    }
    await writeFile(join(this.root, 'settings.json'), JSON.stringify(next, null, 2), 'utf8')
    this.settings = next
    return this.getSettings()
  }

  async get(callId: string): Promise<RunGroup | undefined> {
    const live = this.active.get(callId)
    if (live) return snapshot(live.group)
    try {
      const stored = JSON.parse(await readFile(join(this.root, groupKey(callId), 'group.json'), 'utf8')) as RunGroup
      if (stored.callId !== callId) return undefined
      if (stored.state === 'running') {
        stored.state = 'interrupted'
        stored.children = stored.children.map(child => child.state === 'running' || child.state === 'starting'
          ? { ...child, state: 'interrupted', endedAt: Date.now() } : child)
        await this.persist(stored)
      }
      return snapshot(stored)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  async list(sessionId: string): Promise<RunGroup[]> {
    return (await this.listAll()).filter(group => group.sessionId === sessionId)
  }

  async listAll(): Promise<RunGroup[]> {
    const cutoff = Date.now() - this.settings.historyDays * 86_400_000
    const directories = await readdir(this.root, { withFileTypes: true })
    const groups = await Promise.all(directories.filter(item => item.isDirectory()).map(async item => {
      try {
        const stored = JSON.parse(await readFile(join(this.root, item.name, 'group.json'), 'utf8')) as RunGroup
        return stored.createdAt >= cutoff ? await this.get(stored.callId) : undefined
      } catch { return undefined }
    }))
    return groups.filter((group): group is RunGroup => group !== undefined)
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  async output(callId: string, childId: string): Promise<string | undefined> {
    const group = await this.get(callId)
    if (!group?.children.some(child => child.id === childId)) return undefined
    const live = this.active.get(callId)?.output.get(childId)
    if (live !== undefined) return live.slice(-MAX_OUTPUT_CHARS)
    try { return (await readFile(join(this.root, groupKey(callId), `${childId}.log`), 'utf8')).slice(-MAX_OUTPUT_CHARS) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
      throw error
    }
  }

  async execute(callId: string, sessionId: string, tasks: readonly DelegateTask[], signal: AbortSignal, workspace?: string): Promise<RunGroup> {
    const settings = this.getSettings()
    settings.workspace = await workspaceDirectory(workspace || settings.workspace)
    if (callId.length === 0 || callId.length > 160) throw new Error('Invalid tool call id')
    if (tasks.length < 1 || tasks.length > settings.maxSessions) throw new Error(`Expected 1–${settings.maxSessions} tasks`)
    if (settings.codexProfile && !settings.codexAccountId) {
      throw new Error('Select a saved Codex account for this agent-switch profile in Agent Deck settings')
    }
    const running = [...this.active.values()].reduce((count, item) =>
      count + item.group.children.filter(child => child.state === 'starting' || child.state === 'running').length, 0)
    if (running + tasks.length > settings.maxSessions) throw new Error('Agent Deck parallel task limit reached')
    if (!commandExists('agent-switch') || !commandExists('codex')) throw new Error('agent-switch and codex must be installed')
    const children: DelegatedChild[] = tasks.map(task => {
      if (typeof task.label !== 'string' || task.label.trim().length < 1 || task.label.length > 100) throw new Error('Task label must be 1–100 characters')
      if (typeof task.prompt !== 'string' || task.prompt.trim().length < 1 || task.prompt.length > 20_000) throw new Error('Task prompt must be 1–20000 characters')
      return { id: randomUUID(), label: task.label.trim(), provider: 'codex' as const,
        model: settings.defaultModel, state: 'starting' as const, startedAt: Date.now(), endedAt: null, exitCode: null }
    })
    const group: RunGroup = { callId, sessionId, createdAt: Date.now(), state: 'running', children }
    const runtime: ActiveGroup = { group, output: new Map(children.map(child => [child.id, ''])), processes: new Set(), writes: Promise.resolve() }
    this.active.set(callId, runtime)
    await mkdir(join(this.root, groupKey(callId)), { recursive: true })
    await this.persist(group)
    try {
      await Promise.all(children.map((child, index) => this.runChild(runtime, child, tasks[index]!.prompt, settings, signal)))
      group.state = signal.aborted ? 'cancelled' : children.some(child => child.state === 'failed') ? 'failed' : 'completed'
      await runtime.writes
      await this.persist(group)
      return snapshot(group)
    } catch (error) {
      group.state = signal.aborted ? 'cancelled' : 'failed'
      for (const process of runtime.processes) this.terminate(process)
      await this.persist(group)
      throw error
    } finally {
      this.active.delete(callId)
    }
  }

  dispose(): void {
    for (const runtime of this.active.values()) for (const process of runtime.processes) this.terminate(process)
  }

  private terminate(child: ChildProcessWithoutNullStreams): void {
    if (process.platform === 'win32' && child.pid) {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) }
      catch { child.kill() }
    } else child.kill()
  }

  private async runChild(runtime: ActiveGroup, child: DelegatedChild, prompt: string, settings: DeckSettings, signal: AbortSignal): Promise<void> {
    // A delegated workspace is whatever the parent session works in, which is often not a
    // Git repository; without this flag Codex refuses to start outside one.
    const args = ['codex', ...(settings.codexProfile ? ['--profile', settings.codexProfile] : []),
      'exec', '--skip-git-repo-check', '--color', 'always', ...(settings.defaultModel ? ['--model', settings.defaultModel] : []), '-']
    const executable = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'agent-switch'
    const commandArgs = process.platform === 'win32' ? ['/d', '/c', `agent-switch ${args.join(' ')}`] : args
    let processHandle: ChildProcessWithoutNullStreams
    try {
      processHandle = spawn(executable, commandArgs, {
        cwd: settings.workspace,
        env: settings.codexProfile
          ? { ...process.env, AGENT_SWITCH_CODEX_AUTH_CHOICE: settings.codexAccountId }
          : process.env,
        windowsHide: true, stdio: 'pipe',
      })
    } catch (error) {
      child.state = 'failed'
      child.endedAt = Date.now()
      await this.persist(runtime.group)
      throw error
    }
    runtime.processes.add(processHandle)
    child.state = 'running'
    await this.persist(runtime.group)
    const append = (chunk: Buffer) => {
      const value = chunk.toString('utf8')
      runtime.output.set(child.id, ((runtime.output.get(child.id) || '') + value).slice(-MAX_OUTPUT_CHARS))
      runtime.writes = runtime.writes.then(() => appendFile(join(this.root, groupKey(runtime.group.callId), `${child.id}.log`), value, 'utf8'))
    }
    processHandle.stdout.on('data', append)
    processHandle.stderr.on('data', append)
    processHandle.stdin.end(prompt)
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (code: number | null, failed = false) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', cancel)
        runtime.processes.delete(processHandle)
        child.exitCode = code
        child.endedAt = Date.now()
        child.state = signal.aborted ? 'cancelled' : failed || code !== 0 ? 'failed' : 'completed'
        void runtime.writes.then(() => this.persist(runtime.group)).then(resolve, reject)
      }
      const cancel = () => this.terminate(processHandle)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      processHandle.once('error', error => { append(Buffer.from(`\r\n[${error.message}]\r\n`)); finish(null, true) })
      processHandle.once('close', code => finish(code))
    })
  }

  private persist(group: RunGroup): Promise<void> {
    const previous = this.recordWrites.get(group.callId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      const directory = join(this.root, groupKey(group.callId))
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'group.json'), JSON.stringify(snapshot(group)), 'utf8')
    })
    this.recordWrites.set(group.callId, next)
    void next.then(() => { if (this.recordWrites.get(group.callId) === next) this.recordWrites.delete(group.callId) },
      () => { if (this.recordWrites.get(group.callId) === next) this.recordWrites.delete(group.callId) })
    return next
  }
}
