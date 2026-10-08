import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn(() => ({ status: 0 })),
}))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import * as pty from 'node-pty'
import { apply } from '../src/index.ts'

it('registers authenticated API routes and replays PTY output through SSE', async () => {
  const previousHome = process.env.DSH_HOME
  const isolatedHome = await mkdtemp(join(tmpdir(), 'agent-deck-test-'))
  process.env.DSH_HOME = isolatedHome
  let output: (data: string) => void = () => {}
  const killed = vi.fn()
  vi.mocked(pty.spawn).mockReturnValue({
    onData: (callback: (data: string) => void) => { output = callback; return { dispose() {} } },
    onExit: () => ({ dispose() {} }),
    write() {}, resize() {}, kill: killed,
  } as unknown as pty.IPty)
  const routes = new Map<string, ConnectionFetchRoute>()
  const cleanups: Array<() => void | Promise<void>> = []
  const ctx = {
    effect: (factory: () => () => void | Promise<void>) => { cleanups.push(factory()) },
    tools: { register() { return () => {} } },
    connection: { fetch: { register: (route: ConnectionFetchRoute) => {
      routes.set(route.path, route)
      return async () => { routes.delete(route.path) }
    } } },
  } as unknown as Context
  await apply(ctx, { workspace: process.cwd(), maxSessions: 1, defaultModel: '', codexProfile: '', codexAccountId: '', historyDays: 30 })
  const status = routes.get('/api/agent-deck/status')!
  const payload = await (await status.fetch(new Request('http://localhost/api/agent-deck/status'))).json()
  expect(payload).toMatchObject({ agentSwitchAvailable: true, maxSessions: 1 })

  const create = routes.get('/api/agent-deck/sessions')!
  const bad = await create.fetch(new Request('http://localhost/api/agent-deck/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'bad; echo unsafe' }),
  }))
  expect(bad.status).toBe(400)
  expect(pty.spawn).not.toHaveBeenCalled()

  const started = await create.fetch(new Request('http://localhost/api/agent-deck/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'codex', cols: 100, rows: 30 }),
  }))
  expect(started.status).toBe(201)
  const session = await started.json() as { id: string }
  output('ready')
  const controller = new AbortController()
  const events = routes.get('/api/agent-deck/events')!
  const response = await events.fetch(new Request(`http://localhost/api/agent-deck/events?id=${session.id}`, { signal: controller.signal }))
  expect(response.status).toBe(200)
  const reader = response.body!.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain('"data":"ready"')
  controller.abort()
  await reader.cancel().catch(() => undefined)
  const close = routes.get('/api/agent-deck/close')!
  await close.fetch(new Request('http://localhost/api/agent-deck/close', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: session.id }),
  }))
  expect(killed).toHaveBeenCalledOnce()
  for (const cleanup of cleanups) await cleanup()
  expect(routes.size).toBe(0)
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(isolatedHome, { recursive: true, force: true })
})
