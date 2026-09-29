import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { SessionManager, commandExists, isProvider, providerStatuses, workspaceDirectory, type DeckFrame } from './sessions.ts'
import type {} from '@deepseek-ai/dsh-client-connection'

export const name = 'dsh-agent-deck'
export const inject = ['connection']

export interface Config {
  workspace: string
  maxSessions: number
}

export const Config: Schema<Config> = Schema.object({
  workspace: Schema.string().default(''),
  maxSessions: Schema.number().default(9),
})

const BASE = '/api/agent-deck'

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status)
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get('content-type')?.split(';')[0]?.trim()
  if (contentType !== 'application/json') throw new Error('Expected JSON')
  if (Number(request.headers.get('content-length') || 0) > 65_536) throw new Error('Request is too large')
  const value: unknown = await request.json()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
  return value as Record<string, unknown>
}

function sessionId(request: Request): string | undefined {
  const id = new URL(request.url).searchParams.get('id')
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : undefined
}

function eventStream(manager: SessionManager, id: string, signal: AbortSignal, after: number): Response {
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let cancelStream = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      let closed = false
      const send = (frame: DeckFrame) => {
        if (!closed) controller.enqueue(encoder.encode(`id: ${frame.id}\ndata: ${JSON.stringify(frame.event)}\n\n`))
      }
      const stop = (closeController: boolean) => {
        if (closed) return
        closed = true
        unsubscribe?.()
        if (heartbeat) clearInterval(heartbeat)
        signal.removeEventListener('abort', onAbort)
        if (closeController) controller.close()
      }
      const onAbort = () => stop(true)
      cancelStream = () => stop(false)
      signal.addEventListener('abort', onAbort, { once: true })
      unsubscribe = manager.subscribe(id, after, send)
      if (!unsubscribe || signal.aborted) { stop(true); return }
      heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(': keepalive\n\n')) }, 15_000)
      heartbeat.unref?.()
    },
    cancel() { cancelStream() },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store', 'x-accel-buffering': 'no' } })
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!Number.isSafeInteger(config.maxSessions) || config.maxSessions < 1 || config.maxSessions > 32) {
    throw new Error('Agent Deck maxSessions must be an integer from 1 to 32')
  }
  const manager = new SessionManager(await workspaceDirectory(config.workspace), config.maxSessions)
  ctx.effect(() => () => manager.dispose(), 'dsh-agent-deck: terminal sessions')

  const unregister: Array<() => Promise<void>> = []
  ctx.effect(() => () => Promise.all(unregister.map(dispose => dispose())).then(() => undefined), 'dsh-agent-deck: routes')
  unregister.push(ctx.connection.fetch.register({ path: `${BASE}/status`, methods: ['GET'], requestBody: 'buffered',
    fetch: async () => json({ agentSwitchAvailable: commandExists('agent-switch'),
      workspace: manager.cwd, maxSessions: manager.maxSessions, providers: providerStatuses() }) }))
  unregister.push(ctx.connection.fetch.register({ path: `${BASE}/sessions`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const value = await body(request)
        if (!isProvider(value.provider)) return error('Unsupported provider')
        const cols = typeof value.cols === 'number' ? value.cols : 100
        const rows = typeof value.rows === 'number' ? value.rows : 30
        return json(manager.create(value.provider, cols, rows), 201)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : 'Session could not start'
        return error(message, message === 'Session limit reached' ? 409 : 400)
      }
    } }))
  unregister.push(ctx.connection.fetch.register({ path: `${BASE}/close`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const value = await body(request)
        return typeof value.id === 'string' ? json({ closed: manager.close(value.id) }) : error('Invalid session id')
      } catch (cause) { return error(cause instanceof Error ? cause.message : 'Invalid session id') }
    } }))
  unregister.push(ctx.connection.fetch.register({ path: `${BASE}/input`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const value = await body(request)
        if (typeof value.id !== 'string' || typeof value.data !== 'string') return error('Invalid input')
        return manager.input(value.id, value.data) ? json({ ok: true }) : error('Session not found', 404)
      } catch (cause) { return error(cause instanceof Error ? cause.message : 'Invalid input') }
    } }))
  unregister.push(ctx.connection.fetch.register({ path: `${BASE}/resize`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const value = await body(request)
        if (typeof value.id !== 'string' || typeof value.cols !== 'number' || typeof value.rows !== 'number') return error('Invalid dimensions')
        return manager.resize(value.id, value.cols, value.rows) ? json({ ok: true }) : error('Session not found', 404)
      } catch (cause) { return error(cause instanceof Error ? cause.message : 'Invalid dimensions') }
    } }))
  unregister.push(ctx.connection.fetch.register({ path: `${BASE}/events`, methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const id = sessionId(request)
      const cursor = Number(request.headers.get('last-event-id') || 0)
      const after = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0
      return id && manager.get(id) ? eventStream(manager, id, request.signal, after) : error('Session not found', 404)
    } }))
}
