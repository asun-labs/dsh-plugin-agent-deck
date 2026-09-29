import { spawn } from 'node-pty'

const windows = process.platform === 'win32'
const checkAgentSwitch = process.argv.includes('--agent-switch')
const expected = checkAgentSwitch ? 'agent-switch v' : 'Agent Deck PTY smoke'
const command = checkAgentSwitch ? 'agent-switch --help' : 'echo Agent Deck PTY smoke'
const terminal = spawn(windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
  windows ? ['/d', '/c', command] : ['-c', command],
  { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env })

let output = ''
const timeout = setTimeout(() => { terminal.kill(); process.stderr.write('PTY smoke timed out\n'); process.exitCode = 1 }, 20_000)
terminal.onData(chunk => { output += chunk })
terminal.onExit(({ exitCode }) => {
  clearTimeout(timeout)
  try { terminal.kill() } catch { /* The process has already exited. */ }
  if (exitCode !== 0 || !output.includes(expected)) {
    process.stderr.write(`PTY smoke failed: exit ${exitCode}, output ${JSON.stringify(output)}\n`)
    process.exitCode = 1
  } else process.stdout.write('PTY smoke passed\n')
})
