# Agent Deck for DeepSeek Harness

`@asun-labs/dsh-plugin-agent-deck` adds a right-side multi-agent terminal panel to DeepSeek Harness. Each terminal launches a supported coding CLI through `agent-switch`, so its model traffic is captured by the user's installed Agent Switch tooling. Terminals can be shown as tabs or a responsive grid, and keep running while the panel is hidden.

## Features

- Interactive terminals for Claude Code, Codex, CodeWhale, the DeepSeek compatibility alias, Kimi, and OpenCode
- Tabs and grid layouts with independent terminal sessions
- Runtime availability and error messages, resize handling, exit status, and session cleanup
- DSH-authenticated local API and bounded output replay after a temporary connection loss
- Configurable working directory and concurrent session limit

## Requirements

- Node.js `^22.19.0` or `>=24.0.0`
- A DeepSeek Harness build with the `0.1.7` client slot and connection APIs
- `agent-switch` installed on the Host PATH (`agent-switch --help`)
- At least one target coding CLI installed on the Host PATH

The plugin includes the `node-pty` native dependency. Its install script must be allowed to run so interactive terminals work. This implementation is developed and tested on Windows; macOS and Linux use the same `node-pty` API but still need platform validation.

## Install

Initialize a DSH profile if needed, then install the npm package:

```powershell
dsh --profile agent-deck --from-default-profile web --dump-config | Out-Null
dsh plugin --profile agent-deck add @asun-labs/dsh-plugin-agent-deck
dsh --profile agent-deck --no-open
```

`node-pty` needs to run its native install script. If DSH reports that pnpm blocked the `node-pty` build, open the Web plugin page, review the named script, and use **Allow these scripts and retry** for that profile. The permission is recorded in that profile's `allowBuilds` setting.

Agent Deck appears as a small launcher on the right edge of the DSH Web UI. Click it, choose a runtime, and switch between **Grid** and **Tabs** in the panel header.

## Install from a local checkout

Build this package with Node 22.19+ or 24+:

```powershell
corepack pnpm install
corepack pnpm run check
```

Initialize a DSH profile if needed, then install the package by absolute path:

```powershell
dsh --profile agent-deck --from-default-profile web --dump-config | Out-Null
dsh plugin --profile agent-deck add <absolute-path-to-dsh-plugin-agent-deck>
dsh --profile agent-deck --dump-config
dsh --profile agent-deck --no-open
```

## Configuration

```yaml
config:
  workspace: ''     # empty uses the DSH Host working directory
  maxSessions: 9    # 1–32
```

The working directory is set by the Host plugin configuration. Browser requests cannot choose an arbitrary working directory or command; only the six fixed provider names are accepted.

## Architecture

`src/index.ts` registers authenticated Host routes through DSH Connection. `src/sessions.ts` owns the PTY processes and bounded event history. `src/client.tsx` contributes an additive `shell.overlay` right drawer, leaving DSH's built-in `rightbar` and main panels intact. The Client uses xterm for terminal rendering and EventSource for output; input, resize, start, and close use authenticated same-origin requests.

The shell's output and captured model conversations can contain sensitive material. Agent Switch stores captures in its normal local store; this plugin does not upload logs or add its own telemetry.

## Origin and license

This plugin adapts the panel behavior from [OpenAgentSeal](https://github.com/ASunYC/OpenAgentSeal). See [NOTICE](NOTICE) and [LICENSE](LICENSE). The terminal stylesheet comes from xterm.js under the MIT License.
