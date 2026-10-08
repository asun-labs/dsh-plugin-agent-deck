import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionManager, commandExists, isProvider, providerStatuses, workspaceDirectory, type DeckFrame } from './sessions.ts'
import { RunGroupStore, dataDirectory, validateSettings, type DeckSettings } from './delegation.ts'
import type {} from '@deepseek-ai/dsh-client-connection'

export const name = 'dsh-agent-deck'
export const inject = ['connection', 'tools']

export interface Config {
  workspace: string
  maxSessions: number
  defaultModel: string
  codexProfile: string
  codexAccountId: string
  historyDays: number
}

export const Config: Schema<Config> = Schema.object({
  workspace: Schema.string().default(''),
  maxSessions: Schema.number().default(9),
  defaultModel: Schema.string().default(''),
  codexProfile: Schema.string().default(''),
  codexAccountId: Schema.string().default(''),
  historyDays: Schema.number().default(30),
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
  const groups = new RunGroupStore(dataDirectory(), { ...config, workspace: manager.cwd })
  await groups.initialize()
  ctx.effect(() => () => groups.dispose(), 'dsh-agent-deck: delegated Codex processes')

  ctx.tools.register(defineTool({
    name: 'agent_deck_delegate',
    description: 'Launch 1 to 9 independent Codex CLI tasks in parallel when the user asks you to delegate work to Codex agents. Each task has a short visible label and full instructions. The tool waits for all tasks, shows a live Agent Deck card in the conversation, and preserves terminal output for later inspection.',
    parameters: {
      tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
        properties: { label: { type: 'string', required: true }, prompt: { type: 'string', required: true } } } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('Agent Deck delegation requires an active DSH conversation')
      const agent = exec.agent as typeof exec.agent & { session?: { header?: { cwd?: string } } }
      const group = await groups.execute(String(exec.callId), String(exec.agent.id), args.tasks, exec.signal, agent.session?.header?.cwd)
      return [`Agent Deck group: ${group.callId}`, ...group.children.map(child =>
        `${child.label}: ${child.state} (exit ${child.exitCode ?? 'unknown'})`)].join('\n')
    },
  }))

  const unregister: Array<() => Promise<void>> = []
  ctx.effect(() => () => Promise.all(unregister.map(dispose => dispose())).then(() => undefined), 'dsh-agent-deck: routes')
  unregister.push(ctx.connection.fetch.register({ path: `${BASE}/status`, methods: ['GET'], requestBody: 'buffered',
    fetch: async () => json({ agentSwitchAvailable: commandExists('agent-switch'),
      workspace: manager.cwd, maxSessions: manager.maxSessions, providers: providerStatuses() }) }))
  unregister.push(ctx.connection.fetch.register({ path: `${BASE}/settings`, methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.method === 'GET') return json(groups.getSettings())
      try {
        const value = await body(request)
        const current = groups.getSettings()
        const settings: DeckSettings = validateSettings({
          ...current,
          defaultModel: typeof value.defaultModel === 'string' ? value.defaultModel : current.defaultModel,
          codexProfile: typeof value.codexProfile === 'string' ? value.codexProfile : current.codexProfile,
          codexAccountId: typeof value.codexAccountId === 'string' ? value.codexAccountId : current.codexAccountId,
          historyDays: typeof value.historyDays === 'number' ? value.historyDays : current.historyDays,
        })
        return json(await groups.setSettings(settings))
      } catch (cause) { return error(cause instanceof Error ? cause.message : 'Invalid settings') }
    } }))
  unregister.push(ctx.connection.fetch.register({ path: `${BASE}/profiles`, methods: ['GET'], requestBody: 'buffered',
    async fetch() { return json(await groups.codexProfiles()) } }))
  unregister.push(ctx.connection.fetch.register({ path: `${BASE}/accounts`, methods: ['GET'], requestBody: 'buffered',
    async fetch() { return json(await groups.codexAccounts()) } }))
  unregister.push(ctx.connection.fetch.register({ path: `${BASE}/groups`, methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const query = new URL(request.url).searchParams
      const id = query.get('id')
      if (id) {
        const group = await groups.get(id)
        return group ? json(group) : error('Run group not found', 404)
      }
      const session = query.get('session')
      return json(session ? await groups.list(session) : await groups.listAll())
    } }))
  unregister.push(ctx.connection.fetch.register({ path: `${BASE}/group-output`, methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      const query = new URL(request.url).searchParams
      const id = query.get('id')
      const child = query.get('child')
      if (!id || !child) return error('Missing group or child id')
      const output = await groups.output(id, child)
      return output === undefined ? error('Output not found', 404) : json({ output })
    } }))
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
