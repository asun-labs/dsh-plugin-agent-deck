import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { xtermCss } from './xterm-css.generated.ts'

const BASE = 'api/agent-deck/'
const TAB_KIND = 'agent-deck'
const TAB_ID = '@asun-labs/dsh-plugin-agent-deck'
const PANEL_KIND = 'agent-deck-panel'
const PANEL_ID = '@asun-labs/dsh-plugin-agent-deck/panel'

interface Child {
  id: string
  label: string
  provider: 'codex'
  model: string
  state: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: number
  endedAt: number | null
  exitCode: number | null
}
interface Group {
  callId: string
  sessionId: string
  createdAt: number
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  children: Child[]
}
interface Settings { workspace: string; maxSessions: number; defaultModel: string; codexProfile: string; codexAccountId: string; historyDays: number }
interface CodexAccount { id: string; label: string; email: string | null; authMode: string | null }
interface Selection { callId: string; childId: string }

function url(path: string): string { return new URL(BASE + path, document.baseURI).toString() }
async function get<T>(path: string): Promise<T> {
  const response = await fetch(url(path), { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Agent Deck request failed (${response.status})`)
  return await response.json() as T
}
async function post<T>(path: string, value: unknown): Promise<T> {
  const response = await fetch(url(path), { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) })
  const data = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(data.error || `Agent Deck request failed (${response.status})`)
  return data
}

function useGroup(callId: string): Group | null {
  const [group, setGroup] = useState<Group | null>(null)
  const settled = group !== null && group.callId === callId && group.state !== 'running'
  useEffect(() => {
    if (!callId) { setGroup(null); return }
    let active = true
    const refresh = () => { void get<Group>(`groups?id=${encodeURIComponent(callId)}`).then(next => {
      if (active) setGroup(next)
    }).catch(() => undefined) }
    refresh()
    if (settled) return () => { active = false }
    const timer = window.setInterval(refresh, 1_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [callId, settled])
  return group?.callId === callId ? group : null
}

function childState(child: Child, zh: boolean): string {
  const labels = zh ? { starting: '启动中', running: '运行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
    : { starting: 'Starting', running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' }
  return labels[child.state]
}

function elapsed(start: number, end: number | null): string {
  return `${Math.max(0, Math.round(((end ?? Date.now()) - start) / 1_000))}s`
}

function Card({ callId, failed, select }: { callId: string; failed: boolean; select: (callId: string, childId: string) => void }) {
  const group = useGroup(callId)
  const zh = document.documentElement.lang.toLowerCase().startsWith('zh')
  const children = group?.children ?? []
  const completed = children.filter(child => child.state === 'completed').length
  return <section className="ad-card" aria-label="Agent Deck delegation">
    <style>{cardCss}</style>
    <header><span>♧ {zh ? 'Agent Deck 子任务' : 'Agent Deck tasks'}</span><small>{children.length ? `${completed}/${children.length}` : (zh ? '正在启动' : 'Starting')} · {group ? elapsed(group.createdAt, group.state === 'running' ? null : Math.max(...children.map(child => child.endedAt ?? group.createdAt))) : '0s'}</small></header>
    <div className="ad-card-tree">
      <div className="ad-card-parent"><b>◎　{zh ? '主 Agent' : 'Main Agent'}</b><small>{zh ? `协调 ${children.length} 个任务` : `Coordinating ${children.length} tasks`}</small></div>
      <div className="ad-card-line" aria-hidden="true" />
      <div className="ad-card-children">{children.length ? children.map(child => <button key={child.id} type="button" onClick={() => select(callId, child.id)}>
        <span className="ad-card-icon">▣</span><span className="ad-card-copy"><b>{child.label}</b><small>Codex {child.model || ''} · {childState(child, zh)}</small></span><span className="ad-card-time">{elapsed(child.startedAt, child.endedAt)}</span>
      </button>) : <div className="ad-card-loading">{failed ? (zh ? '工具调用失败；请查看错误详情。' : 'Tool call failed; inspect its error.') : (zh ? '正在创建 Codex 子任务…' : 'Creating Codex tasks…')}</div>}</div>
    </div>
  </section>
}

function OutputPane({ groupId, child, visible }: { groupId: string; child: Child; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const length = useRef(0)
  useEffect(() => {
    if (!host.current) return
    const instance = new Terminal({ convertEol: true, cursorBlink: child.state === 'running', scrollback: 8_000,
      fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 12,
      theme: { background: '#0b1020', foreground: '#d9e2f2', cursor: '#7aa2ff' } })
    const addon = new FitAddon()
    terminal.current = instance
    fit.current = addon
    instance.loadAddon(addon)
    instance.open(host.current)
    let active = true
    const refresh = () => { void get<{ output: string }>(`group-output?id=${encodeURIComponent(groupId)}&child=${encodeURIComponent(child.id)}`).then(value => {
      if (!active) return
      if (value.output.length < length.current) { instance.clear(); length.current = 0 }
      instance.write(value.output.slice(length.current))
      length.current = value.output.length
    }).catch(() => undefined) }
    refresh()
    const timer = window.setInterval(refresh, 1_000)
    const observer = new ResizeObserver(() => { try { addon.fit() } catch { /* Hidden tab. */ } })
    observer.observe(host.current)
    return () => { active = false; window.clearInterval(timer); observer.disconnect(); instance.dispose(); terminal.current = null }
  }, [groupId, child.id])
  useEffect(() => {
    if (!visible) return
    const frame = window.requestAnimationFrame(() => { try { fit.current?.fit() } catch { /* No geometry yet. */ } })
    return () => window.cancelAnimationFrame(frame)
  }, [visible])
  return <div ref={host} className="ad-output" />
}

function useRecentGroups(enabled: boolean): Group[] {
  const [groups, setGroups] = useState<Group[]>([])
  useEffect(() => { if (enabled) void get<Group[]>('groups').then(setGroups).catch(() => undefined) }, [enabled])
  return groups
}

function RunPanel({ selection, select }: { selection: Selection; select: (callId: string, childId: string) => void }) {
  const group = useGroup(selection.callId)
  const recent = useRecentGroups(!selection.callId)
  const [active, setActive] = useState(selection.childId)
  const [layout, setLayout] = useState<'tabs' | 'grid'>('tabs')
  useEffect(() => setActive(selection.childId), [selection.childId])
  if (!selection.callId) return <section className="ad-panel-history"><style>{panelCss}</style><h3>Agent Deck 最近任务</h3>
    {recent.length ? recent.map(item => <button key={item.callId} onClick={() => select(item.callId, item.children[0]?.id || '')}>
      <b>{item.children.map(child => child.label).join('、')}</b><span>{item.children.length} 个子任务 · {new Date(item.createdAt).toLocaleString()}</span>
    </button>) : <p>暂无历史任务。让主会话调用 agent_deck_delegate，或点击会话中的子卡片。</p>}
  </section>
  if (!group) return <div className="ad-panel-empty">正在加载任务组…</div>
  return <section className="ad-panel">
    <style>{xtermCss + panelCss}</style>
    <header className="ad-panel-header"><b>Agent Deck</b><span>{group.children.length} 个 Codex 子任务</span><button onClick={() => select('', '')}>历史</button><button onClick={() => setLayout(layout === 'tabs' ? 'grid' : 'tabs')}>{layout === 'tabs' ? '网格' : '页签'}</button></header>
    {layout === 'tabs' && <nav className="ad-panel-tabs">{group.children.map(child => <button key={child.id} className={active === child.id ? 'active' : ''} onClick={() => setActive(child.id)}>{child.label} · {childState(child, true)}</button>)}</nav>}
    <div className={`ad-panel-outputs ${layout}`}>{group.children.map(child => <article key={child.id} className={layout === 'tabs' && child.id !== active ? 'hidden' : ''}>
      {layout === 'grid' && <header onClick={() => setActive(child.id)}>{child.label} · {childState(child, true)}</header>}
      <OutputPane groupId={group.callId} child={child} visible={layout === 'grid' || child.id === active} />
    </article>)}</div>
  </section>
}

function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [profiles, setProfiles] = useState<string[]>([])
  const [accounts, setAccounts] = useState<CodexAccount[]>([])
  const [notice, setNotice] = useState('')
  useEffect(() => {
    void get<Settings>('settings').then(setSettings).catch(error => setNotice(String(error)))
    void get<string[]>('profiles').then(setProfiles).catch(() => undefined)
    void get<CodexAccount[]>('accounts').then(setAccounts).catch(() => undefined)
  }, [])
  if (!settings) return <p>{notice || '正在读取 Agent Deck 配置…'}</p>
  const update = (patch: Partial<Settings>) => setSettings({ ...settings, ...patch })
  const save = () => {
    if (settings.codexProfile && !settings.codexAccountId) { setNotice('使用独立 Codex profile 时，请选择已保存的账号。'); return }
    void post<Settings>('settings', settings).then(next => {
    setSettings(next); setNotice('配置已保存，新启动的 Codex 子任务将使用这些设置。')
    }).catch(error => setNotice(String(error)))
  }
  return <section className="ad-settings"><style>{settingsCss}</style><h2>Agent Deck</h2>
    <p>为通过 agent-switch 启动的 Codex 子任务选择账号配置与默认模型。认证信息由 Codex / agent-switch 保存，本页不会显示密钥。</p>
    <label>Codex 账号配置名称<input list="agent-deck-codex-profiles" value={settings.codexProfile} onChange={event => update({ codexProfile: event.target.value })} placeholder="留空使用当前默认账号" /><datalist id="agent-deck-codex-profiles">{profiles.map(name => <option key={name} value={name} />)}</datalist></label>
    <label>已保存的 Codex 账号<select value={settings.codexAccountId} disabled={!settings.codexProfile} onChange={event => update({ codexAccountId: event.target.value })}><option value="">选择账号</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.label}{account.email ? ` · ${account.email}` : ''}</option>)}</select></label>
    <label>默认模型<input value={settings.defaultModel} onChange={event => update({ defaultModel: event.target.value })} placeholder="留空使用 Codex 默认模型" /></label>
    <label>历史显示天数<input type="number" min={1} max={365} value={settings.historyDays} onChange={event => update({ historyDays: Number(event.target.value) })} /></label>
    <p>工作目录：{settings.workspace}　·　最多并行 {settings.maxSessions} 个子任务</p>
    <button type="button" onClick={save}>保存配置</button>{notice && <p role="status">{notice}</p>}
  </section>
}

export function installExtras(ctx: Context, panel: React.ComponentType): void {
  let selected: Selection = { callId: '', childId: '' }
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const getSelection = () => selected
  const select = (callId: string, childId: string) => {
    selected = { callId, childId }
    for (const listener of listeners) listener()
    ctx.sidebarRight.openTab(TAB_KIND)
  }
  function ToolCard(props: ToolCallViewProps) {
    const failed = 'kind' in props.block && props.block.kind === 'tool-result' && props.block.isError
    return <Card callId={props.callId} failed={failed} select={select} />
  }
  function RightbarTab() { return <RunPanel selection={useSyncExternalStore(subscribe, getSelection)} select={select} /> }
  const guideEntry = { id: 'agent-deck', order: 100, title: () => 'Agent Deck', description: () => 'Codex 子任务终端与历史输出' }
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: TAB_ID, kind: TAB_KIND, title: () => 'Agent Deck',
    guide: [guideEntry],
  }), 'agent-deck: rightbar tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, RightbarTab))
  const panelGuide = { id: 'agent-deck-panel', order: 110, title: () => 'Agent Deck Panel', description: () => '运行时终端：启动并切换 AI CLI 终端' }
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: PANEL_ID, kind: PANEL_KIND, title: () => 'Agent Deck Panel',
    guide: [panelGuide],
  }), 'agent-deck: runtime panel tab type')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: PANEL_ID }, panel))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'agent_deck_delegate' }, ToolCard))
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'agent-deck', order: 110, label: () => 'Agent Deck' }, SettingsPage))
}

const cardCss = `.ad-card{background:#1c1c1e;color:#e9e9eb;border-radius:16px;padding:16px;font:12px system-ui;max-width:720px}.ad-card>header{display:flex;justify-content:space-between;color:#bcbcc0}.ad-card small{color:#a9a9af}.ad-card-tree{display:grid;grid-template-columns:180px 28px minmax(0,1fr);align-items:center;margin-top:20px}.ad-card-parent{display:flex;flex-direction:column;background:#29292b;border-radius:13px;padding:16px}.ad-card-line{height:2px;background:#424246}.ad-card-children{display:grid;gap:10px;border-left:2px solid #424246;padding-left:12px}.ad-card-children button{display:flex;align-items:center;gap:10px;text-align:left;background:#28282a;border:1px solid #303034;border-radius:13px;padding:13px;color:inherit;cursor:pointer;min-height:62px}.ad-card-children button:hover{border-color:#8b9ecb}.ad-card-icon{border-radius:50%;background:#38383a;padding:8px}.ad-card-copy{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1}.ad-card-copy b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ad-card-time{color:#aaa}.ad-card-loading{color:#aaa;padding:18px}@media(max-width:650px){.ad-card-tree{grid-template-columns:1fr}.ad-card-line{display:none}.ad-card-children{border:0;padding:12px 0 0}}`
const panelCss = `.ad-panel{height:100%;min-height:0;display:flex;flex-direction:column;background:#0b1020;color:#e4ebf7;font:12px system-ui}.ad-panel-header{display:flex;align-items:center;gap:8px;padding:10px;border-bottom:1px solid #354159}.ad-panel-header span{color:#93a1b8}.ad-panel-header button{background:#26334b;border:1px solid #42516b;border-radius:7px;color:inherit;padding:5px 9px;cursor:pointer}.ad-panel-header button:first-of-type{margin-left:auto}.ad-panel-tabs{display:flex;gap:6px;overflow:auto;padding:7px}.ad-panel-tabs button{white-space:nowrap;background:#1c2840;border:1px solid #354159;border-radius:7px;color:inherit;padding:6px;cursor:pointer}.ad-panel-tabs button.active{border-color:#7aa2ff}.ad-panel-outputs{flex:1;min-height:0}.ad-panel-outputs.tabs{position:relative}.ad-panel-outputs.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:8px;overflow:auto;padding:8px}.ad-panel-outputs article{display:flex;flex-direction:column;min-height:0}.ad-panel-outputs.tabs article{position:absolute;inset:0}.ad-panel-outputs article.hidden{display:none}.ad-panel-outputs.grid article{min-height:220px;border:1px solid #354159;border-radius:9px}.ad-panel-outputs article header{padding:6px 9px}.ad-output{flex:1;min-height:0;padding:8px}.ad-output .xterm{height:100%}.ad-panel-history{height:100%;overflow:auto;padding:16px;background:#0b1020;color:#e4ebf7;font:12px system-ui}.ad-panel-history h3{font-size:14px}.ad-panel-history>button{width:100%;display:flex;flex-direction:column;gap:5px;text-align:left;border:1px solid #354159;border-radius:10px;background:#1c2840;color:inherit;padding:12px;margin:8px 0;cursor:pointer}.ad-panel-history>button:hover{border-color:#7aa2ff}.ad-panel-history>button span,.ad-panel-history p{color:#93a1b8}.ad-panel-empty{padding:22px;color:#8894a9}`
const settingsCss = `.ad-settings{display:flex;flex-direction:column;gap:16px;padding:22px;max-width:700px;color:var(--dsw-alias-label-primary,#e4e4e7);font:14px system-ui}.ad-settings h2{margin:0}.ad-settings p{color:var(--dsw-alias-label-secondary,#a1a1aa);line-height:1.5}.ad-settings label{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #6664;padding:10px 0}.ad-settings input,.ad-settings select{min-width:210px;max-width:350px;width:45%;background:#7772;color:inherit;border:1px solid #8885;border-radius:9px;padding:9px}.ad-settings button{align-self:flex-start;border:0;border-radius:9px;background:#4e79c9;color:white;padding:9px 18px;cursor:pointer}`
