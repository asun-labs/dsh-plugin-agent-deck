import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as pty from 'node-pty'

export const providers = ['claude', 'codex', 'codewhale', 'deepseek', 'kimi', 'opencode'] as const
export type Provider = typeof providers[number]
export type DeckEvent = { type: 'output'; data: string } | { type: 'exit'; code: number } | { type: 'error'; message: string }
export interface DeckFrame { id: number; event: DeckEvent }

const providerCommands: Record<Provider, readonly string[]> = {
  claude: ['claude'], codex: ['codex'], codewhale: ['codewhale'],
  deepseek: ['codewhale', 'deepseek', 'deepseek-tui'], kimi: ['claude'], opencode: ['opencode'],
}

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && providers.some(provider => provider === value)
}

export function commandExists(command: string): boolean {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
    windowsHide: true, timeout: 3_000, stdio: 'ignore',
  })
  return result.status === 0
}

export interface ProviderStatus {
  provider: Provider
  label: string
  available: boolean
  targetCommand: string
  status: string
}

export function providerStatuses(hasAgentSwitch = commandExists('agent-switch')): ProviderStatus[] {
  const labels: Record<Provider, string> = {
    claude: 'Claude', codex: 'Codex', codewhale: 'CodeWhale',
    deepseek: 'DeepSeek', kimi: 'Kimi', opencode: 'OpenCode',
  }
  return providers.map(provider => {
    const targetCommand = providerCommands[provider].find(commandExists)
    return {
      provider,
      label: labels[provider],
      available: hasAgentSwitch && targetCommand !== undefined,
      targetCommand: targetCommand ?? providerCommands[provider][0]!,
      status: !hasAgentSwitch ? 'agent-switch missing' : targetCommand ? 'ready' : 'target CLI missing',
    }
  })
}

export async function workspaceDirectory(configured: string): Promise<string> {
  const path = resolve(configured || process.cwd())
  if (!(await stat(path)).isDirectory()) throw new Error('Agent Deck workspace must be a directory')
  return path
}

export interface DeckSession {
  id: string
  provider: Provider
  cwd: string
  command: string
  exited: boolean
  exitCode: number | null
}

interface ManagedSession extends DeckSession {
  terminal: pty.IPty
  history: DeckFrame[]
  historyChars: number
  sequence: number
  listeners: Set<(frame: DeckFrame) => void>
  expiry?: ReturnType<typeof setTimeout>
}

const MAX_BUFFER = 200_000
const EXIT_TTL_MS = 5 * 60_000

function dimensions(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('Invalid terminal dimensions')
  return Math.max(min, Math.min(max, value))
}

function publicSession(session: ManagedSession): DeckSession {
  return { id: session.id, provider: session.provider, cwd: session.cwd, command: session.command,
    exited: session.exited, exitCode: session.exitCode }
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>()

  constructor(readonly cwd: string, readonly maxSessions: number) {}

  get size(): number { return this.sessions.size }

  get(id: string): DeckSession | undefined {
    const session = this.sessions.get(id)
    return session && publicSession(session)
  }

  create(provider: Provider, cols: number, rows: number): DeckSession {
    if (this.sessions.size >= this.maxSessions) throw new Error('Session limit reached')
    if (!commandExists('agent-switch')) throw new Error('agent-switch is not installed')
    const status = providerStatuses(true).find(item => item.provider === provider)
    if (!status?.available) throw new Error(`${status?.targetCommand ?? provider} is not installed`)
    const command = `agent-switch ${provider}`
    // Windows npm shims are .cmd files and need cmd.exe; provider is a fixed allowlisted token.
    const executable = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'agent-switch'
    const args = process.platform === 'win32' ? ['/d', '/c', command] : [provider]
    const terminal = pty.spawn(executable, args, {
      name: 'xterm-256color', cols: dimensions(cols, 20, 240), rows: dimensions(rows, 8, 80),
      cwd: this.cwd, env: { ...process.env, TERM: 'xterm-256color' },
    })
    const session: ManagedSession = {
      id: randomUUID(), provider, cwd: this.cwd, command, terminal, exited: false, exitCode: null,
      history: [], historyChars: 0, sequence: 0, listeners: new Set(),
    }
    this.sessions.set(session.id, session)
    terminal.onData(data => {
      this.emit(session, { type: 'output', data })
    })
    terminal.onExit(({ exitCode }) => {
      if (!this.sessions.has(session.id)) return
      session.exited = true
      session.exitCode = exitCode
      this.emit(session, { type: 'exit', code: exitCode })
      session.expiry = setTimeout(() => this.close(session.id), EXIT_TTL_MS)
      session.expiry.unref?.()
    })
    return publicSession(session)
  }

  subscribe(id: string, after: number, listener: (frame: DeckFrame) => void): (() => void) | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined
    for (const frame of session.history) if (frame.id > after) listener(frame)
    session.listeners.add(listener)
    return () => session.listeners.delete(listener)
  }

  input(id: string, value: string): boolean {
    const session = this.sessions.get(id)
    if (!session || session.exited) return false
    if (value.length > 64_000) throw new Error('Terminal input is too large')
    session.terminal.write(value)
    return true
  }

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id)
    if (!session || session.exited) return false
    session.terminal.resize(dimensions(cols, 20, 240), dimensions(rows, 8, 80))
    return true
  }

  close(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    this.sessions.delete(id)
    if (session.expiry) clearTimeout(session.expiry)
    session.listeners.clear()
    try { session.terminal.kill() } catch { /* The PTY may already have exited. */ }
    return true
  }

  dispose(): void {
    for (const id of this.sessions.keys()) this.close(id)
  }

  private emit(session: ManagedSession, event: DeckEvent): void {
    const frame = { id: ++session.sequence, event }
    session.history.push(frame)
    session.historyChars += event.type === 'output' ? event.data.length : 0
    while (session.historyChars > MAX_BUFFER || session.history.length > 2_000) {
      const removed = session.history.shift()
      if (removed?.event.type === 'output') session.historyChars -= removed.event.data.length
    }
    for (const listener of session.listeners) listener(frame)
  }
}
