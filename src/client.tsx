import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { xtermCss } from './xterm-css.generated.ts'

export const inject = ['slots']

type Provider = 'claude' | 'codex' | 'codewhale' | 'deepseek' | 'kimi' | 'opencode'
type Layout = 'tabs' | 'grid'
interface ProviderStatus { provider: Provider; label: string; available: boolean; status: string; targetCommand: string }
interface Status { agentSwitchAvailable: boolean; workspace: string; maxSessions: number; providers: ProviderStatus[] }
interface Session { id: string; provider: Provider; cwd: string; command: string; exited: boolean; exitCode: number | null }
interface Tab { key: string; provider: Provider; session?: Session; state: 'starting' | 'running' | 'exited' | 'error' }
type Event = { type: 'output'; data: string } | { type: 'exit'; code: number } | { type: 'error'; message: string }

const BASE = 'api/agent-deck/'

function endpoint(path: string): string { return new URL(BASE + path, document.baseURI).toString() }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(endpoint(path), { credentials: 'same-origin', ...options })
  const value: unknown = await response.json()
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value ? String(value.error) : `Request failed (${response.status})`
    throw new Error(message)
  }
  return value as T
}

function post<T>(path: string, value: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
}

function TerminalPane({ tab, visible, zh, onState, onFocus }: {
  tab: Tab; visible: boolean; zh: boolean; onState: (key: string, patch: Partial<Tab>) => void; onFocus: (key: string) => void
}) {
  const element = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const sessionId = useRef<string | null>(null)
  const queue = useRef(Promise.resolve())
  const onStateRef = useRef(onState)
  onStateRef.current = onState

  useEffect(() => {
    const target = element.current
    if (!target) return
    const instance = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: 'Cascadia Mono, Consolas, monospace',
      fontSize: 13, scrollback: 5_000, theme: { background: '#0b1020', foreground: '#d9e2f2', cursor: '#7aa2ff', selectionBackground: '#2f4f88' } })
    const addon = new FitAddon()
    terminal.current = instance
    fit.current = addon
    instance.loadAddon(addon)
    instance.open(target)
    instance.writeln(`Agent Deck · agent-switch ${tab.provider}`)
    instance.writeln('')
    try { addon.fit() } catch { /* Hidden until the drawer opens. */ }
    let stopped = false
    let events: EventSource | undefined
    const key = tab.key
    const input = instance.onData(data => {
      const id = sessionId.current
      if (!id) return
      queue.current = queue.current.then(() => post('input', { id, data })).then(() => undefined).catch(error => {
        if (!stopped) instance.writeln(`\r\n[Input failed: ${String(error)}]`)
      })
    })
    void (async () => {
      try {
        const session = await post<Session>('sessions', { provider: tab.provider, cols: instance.cols || 100, rows: instance.rows || 30 })
        if (stopped) {
          await post('close', { id: session.id })
          return
        }
        sessionId.current = session.id
        onStateRef.current(key, { session, state: 'running' })
        instance.writeln(`cwd: ${session.cwd}`)
        instance.writeln('')
        events = new EventSource(endpoint(`events?id=${encodeURIComponent(session.id)}`))
        events.onmessage = message => {
          try {
            const event = JSON.parse(message.data) as Event
            if (event.type === 'output') instance.write(event.data)
            if (event.type === 'exit') {
              onStateRef.current(key, { state: 'exited' })
              instance.writeln(`\r\n[${zh ? '进程已退出' : 'Process exited'}: ${event.code}]`)
              events?.close()
            }
            if (event.type === 'error') instance.writeln(`\r\n[${event.message}]`)
          } catch { instance.writeln('\r\n[Invalid terminal event]') }
        }
        events.onerror = () => {
          if (!stopped && events?.readyState === EventSource.CLOSED) instance.writeln('\r\n[Terminal connection closed]')
        }
      } catch (error) {
        if (!stopped) {
          onStateRef.current(key, { state: 'error' })
          instance.writeln(`\r\n[${error instanceof Error ? error.message : String(error)}]`)
        }
      }
    })()
    const observer = new ResizeObserver(() => {
      try {
        addon.fit()
        const id = sessionId.current
        if (id) void post('resize', { id, cols: instance.cols, rows: instance.rows }).catch(() => undefined)
      } catch { /* The tab may be hidden. */ }
    })
    observer.observe(target)
    return () => {
      stopped = true
      observer.disconnect()
      events?.close()
      input.dispose()
      instance.dispose()
      terminal.current = null
      fit.current = null
      if (sessionId.current) void post('close', { id: sessionId.current }).catch(() => undefined)
    }
  }, [tab.key, tab.provider])

  useEffect(() => {
    if (!visible) return
    const timer = window.requestAnimationFrame(() => { try { fit.current?.fit(); terminal.current?.refresh(0, terminal.current.rows - 1) } catch { /* No geometry yet. */ } })
    return () => window.cancelAnimationFrame(timer)
  }, [visible])

  return <div ref={element} className="agent-deck-terminal" onClick={() => onFocus(tab.key)} />
}

function DeckOverlay() {
  const zh = document.documentElement.lang.toLowerCase().startsWith('zh')
  const t = (chinese: string, english: string) => zh ? chinese : english
  const [open, setOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [width, setWidth] = useState(700)
  const [layout, setLayout] = useState<Layout>('tabs')
  const [status, setStatus] = useState<Status | null>(null)
  const [statusError, setStatusError] = useState('')
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeKey, setActiveKey] = useState('')
  const [busy, setBusy] = useState(false)

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    const move = (next: PointerEvent) => setWidth(Math.round(Math.max(360, Math.min(1200, window.innerWidth - next.clientX))))
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
    window.addEventListener('pointercancel', stop, { once: true })
  }

  const refresh = useCallback(async () => {
    setBusy(true)
    try { setStatus(await request<Status>('status')); setStatusError('') }
    catch (error) { setStatusError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const updateTab = useCallback((key: string, patch: Partial<Tab>) => {
    setTabs(current => current.map(tab => tab.key === key ? { ...tab, ...patch } : tab))
  }, [])
  const addTab = (provider: Provider) => {
    if (!status?.agentSwitchAvailable || tabs.length >= status.maxSessions) return
    const key = globalThis.crypto?.randomUUID?.() || `deck-${Date.now()}-${Math.random().toString(36).slice(2)}`
    setTabs(current => [...current, { key, provider, state: 'starting' }])
    setActiveKey(key)
    setOpen(true)
  }
  const closeTab = (key: string) => {
    const index = tabs.findIndex(tab => tab.key === key)
    const remaining = tabs.filter(tab => tab.key !== key)
    setTabs(remaining)
    if (activeKey === key) setActiveKey(remaining[Math.min(index, remaining.length - 1)]?.key || '')
  }

  return <>
    <style>{xtermCss + deckCss}</style>
    {!open && <button className="agent-deck-launch" onClick={() => setOpen(true)} title={t('打开 Agent Deck', 'Open Agent Deck')}>⌘ <span>Agent Deck</span></button>}
    <section className={`agent-deck-drawer ${open ? 'is-open' : ''} ${fullscreen ? 'fullscreen' : ''}`}
      style={fullscreen ? undefined : { width: Math.min(width, window.innerWidth - 16) }} aria-label="Agent Deck" aria-hidden={!open}>
      {!fullscreen && <button className="agent-deck-resizer" onPointerDown={startResize} onDoubleClick={() => setWidth(700)} aria-label={t('调整 Agent Deck 宽度', 'Resize Agent Deck')} title={t('拖动调整宽度，双击重置', 'Drag to resize; double-click to reset')}><span /></button>}
      <header className="agent-deck-header">
        <div><strong>Agent Deck</strong><small>{status?.workspace || t('多智能体终端', 'Multi-agent terminals')}</small></div>
        <div className="agent-deck-header-actions">
          <button onClick={() => setLayout(value => value === 'tabs' ? 'grid' : 'tabs')} title={t('切换布局', 'Switch layout')}>{layout === 'tabs' ? t('▦ 网格', '▦ Grid') : t('▤ 页签', '▤ Tabs')}</button>
          <button onClick={() => setFullscreen(value => !value)} title={fullscreen ? t('退出全屏', 'Exit fullscreen') : t('最大化面板', 'Maximize panel')}>{fullscreen ? '❐' : '□'}</button>
          <button onClick={() => void refresh()} disabled={busy} title={t('刷新运行时', 'Refresh runtimes')}>↻</button>
          <button onClick={() => setOpen(false)} title={t('隐藏面板', 'Hide panel')}>×</button>
        </div>
      </header>
      <div className="agent-deck-providers">
        {(status?.providers || []).map(provider => <button key={provider.provider} disabled={!status?.agentSwitchAvailable || tabs.length >= status.maxSessions}
          className={provider.available ? 'available' : ''} title={`${provider.status === 'ready' ? t('就绪', 'ready') : provider.status === 'target CLI missing' ? t('目标 CLI 未安装', 'target CLI missing') : t('agent-switch 未安装', 'agent-switch missing')} · agent-switch ${provider.provider}`}
          onClick={() => addTab(provider.provider)}><i />{provider.label}</button>)}
      </div>
      {statusError && <p className="agent-deck-message error">{statusError}</p>}
      {status && !status.agentSwitchAvailable && <p className="agent-deck-message">{t('未找到 agent-switch。请先安装 agent-switch-skill。', 'Install agent-switch-skill to enable these terminals.')}</p>}
      {status?.agentSwitchAvailable && status.providers.every(provider => !provider.available) && <p className="agent-deck-message">{t('未找到受支持的 AI CLI。安装后请刷新。', 'No supported AI CLI was found. Install a CLI, then refresh.')}</p>}
      {tabs.length > 0 ? <>
        {layout === 'tabs' && <nav className="agent-deck-tabs" aria-label={t('终端页签', 'Terminal tabs')}>{tabs.map(tab => <div key={tab.key} className={activeKey === tab.key ? 'active' : ''}>
          <button onClick={() => setActiveKey(tab.key)}><span>{tab.provider}</span><small>{stateLabel(tab.state, zh)}</small></button>
          <button aria-label={t(`关闭 ${tab.provider} 终端`, `Close ${tab.provider} terminal`)} onClick={() => closeTab(tab.key)}>×</button>
        </div>)}</nav>}
        <div className={`agent-deck-stack ${layout}`}>
          {tabs.map(tab => <article key={tab.key} className={`agent-deck-card ${layout === 'tabs' && tab.key !== activeKey ? 'hidden' : ''} ${tab.key === activeKey ? 'active' : ''}`}>
            {layout === 'grid' && <header onClick={() => setActiveKey(tab.key)}><strong>{tab.provider}</strong><small>{stateLabel(tab.state, zh)}</small><button aria-label={t(`关闭 ${tab.provider} 终端`, `Close ${tab.provider} terminal`)} onClick={() => closeTab(tab.key)}>×</button></header>}
            <TerminalPane tab={tab} visible={open && (layout === 'grid' || tab.key === activeKey)} zh={zh} onState={updateTab} onFocus={setActiveKey} />
          </article>)}
        </div>
      </> : <div className="agent-deck-empty"><span>⌘</span><strong>{t('选择一个 AI 运行时', 'Choose an AI runtime')}</strong><p>{t('每个运行时都有独立的交互终端，可随时切换页签和网格布局。', 'Each runtime opens in an interactive terminal. Switch between tabs and a grid at any time.')}</p></div>}
      <footer className="agent-deck-footer">{tabs.length}/{status?.maxSessions || 9} {t('个终端 · 本地工作区 · agent-switch 捕获', 'terminals · local workspace · agent-switch capture')}</footer>
    </section>
  </>
}

function stateLabel(state: Tab['state'], zh: boolean): string {
  const labels = zh ? { starting: '启动中', running: '运行中', exited: '已退出', error: '错误' }
    : { starting: 'starting', running: 'running', exited: 'exited', error: 'error' }
  return labels[state]
}

export function apply(ctx: Context): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-agent-deck', order: 30 }, DeckOverlay))
}

const deckCss = `
.agent-deck-launch,.agent-deck-drawer{pointer-events:auto;font-family:Inter,system-ui,sans-serif}
.agent-deck-launch{position:fixed;right:12px;top:45%;z-index:1000;border:1px solid #52617a;border-radius:12px 0 0 12px;background:#101827;color:#e4ebf7;padding:12px 10px;cursor:pointer;box-shadow:0 8px 28px #0004;writing-mode:vertical-rl}
.agent-deck-launch span{font-size:12px;font-weight:700;letter-spacing:.04em}
.agent-deck-drawer{position:fixed;right:0;top:0;bottom:0;z-index:1001;min-width:0;display:none;flex-direction:column;background:#101827;color:#e4ebf7;border-left:1px solid #344157;box-shadow:-12px 0 48px #0006}
.agent-deck-drawer.is-open{display:flex}
.agent-deck-drawer.fullscreen{left:0;width:100vw;border-left:0}
.agent-deck-drawer button{color:inherit;cursor:pointer}
.agent-deck-resizer{position:absolute;left:0;top:0;bottom:0;z-index:2;width:9px;border:0;background:transparent;cursor:col-resize;touch-action:none;display:flex;align-items:center;justify-content:center}.agent-deck-resizer span{width:3px;height:64px;border-radius:9px;background:#52617a}.agent-deck-resizer:hover span{background:#7aa2ff;height:100%}
.agent-deck-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid #293750}
.agent-deck-header>div:first-child{display:flex;flex-direction:column;min-width:0;gap:3px}.agent-deck-header strong{font-size:15px}.agent-deck-header small{font-size:11px;color:#91a0b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent-deck-header-actions{display:flex;gap:6px}.agent-deck-header-actions button{border:1px solid #344157;border-radius:8px;background:#1b263a;padding:6px 10px;font-size:12px}
.agent-deck-providers{display:flex;gap:7px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid #293750}
.agent-deck-providers button{display:flex;align-items:center;gap:7px;border:1px solid #344157;border-radius:8px;background:#19263a;padding:7px 10px;font-size:12px}.agent-deck-providers button:hover{border-color:#7aa2ff}.agent-deck-providers button:disabled{opacity:.45;cursor:default}.agent-deck-providers i{display:block;width:7px;height:7px;border-radius:50%;background:#a0a8b8}.agent-deck-providers .available i{background:#22c55e}
.agent-deck-message{margin:8px 14px;padding:9px 11px;border-radius:8px;background:#283248;color:#ffd27a;font-size:12px}.agent-deck-message.error{color:#ff8f8f}
.agent-deck-tabs{display:flex;gap:6px;overflow:auto;padding:8px;border-bottom:1px solid #293750}.agent-deck-tabs>div{display:flex;align-items:center;white-space:nowrap;border:1px solid #344157;border-radius:8px;background:#19263a}.agent-deck-tabs>div.active{border-color:#7aa2ff;background:#253b65}.agent-deck-tabs button{display:flex;align-items:center;gap:8px;border:0;background:transparent;padding:6px 9px;font-size:12px}.agent-deck-tabs small,.agent-deck-card small{font-size:10px;color:#91a0b8}
.agent-deck-stack{min-height:0;flex:1;background:#0b1020}.agent-deck-stack.tabs{position:relative}.agent-deck-stack.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:9px;overflow:auto;padding:9px;align-content:stretch}
.agent-deck-card{min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:#0b1020}.agent-deck-stack.tabs .agent-deck-card{position:absolute;inset:0}.agent-deck-card.hidden{display:none}.agent-deck-stack.grid .agent-deck-card{min-height:240px;border:1px solid #344157;border-radius:10px}.agent-deck-stack.grid .agent-deck-card.active{border-color:#7aa2ff}.agent-deck-card header{display:flex;align-items:center;gap:9px;padding:7px 10px;background:#19263a;font-size:12px}.agent-deck-card header button{margin-left:auto;border:0;background:transparent;font-size:17px}
.agent-deck-terminal{min-height:0;flex:1;padding:8px}.agent-deck-terminal .xterm{height:100%}.agent-deck-empty{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#91a0b8;text-align:center;padding:24px}.agent-deck-empty span{font-size:34px;color:#7aa2ff}.agent-deck-empty strong{color:#e4ebf7}.agent-deck-empty p{max-width:320px;font-size:12px;line-height:1.5}
.agent-deck-footer{padding:7px 14px;border-top:1px solid #293750;color:#91a0b8;font-size:10px}
@media(max-width:720px){.agent-deck-drawer{width:100vw!important;min-width:0}.agent-deck-resizer{display:none}.agent-deck-stack.grid{grid-template-columns:1fr}}
`
