# Agent Deck for DeepSeek Harness

`@asun-labs/dsh-plugin-agent-deck` connects Codex child tasks to a DeepSeek Harness conversation. A model-facing tool launches parallel Codex CLI processes through `agent-switch`, renders a live task card in the conversation, and opens their terminal output in the native right sidebar. The original manual multi-CLI terminal drawer remains available.

## Features

- Interactive terminals for Claude Code, Codex, CodeWhale, the DeepSeek compatibility alias, Kimi, and OpenCode
- Tabs and grid layouts with independent terminal sessions
- A custom conversation card for `agent_deck_delegate` with one child card per Codex task
- A native DSH right-sidebar tab with live output and saved output replay for completed tasks
- An Agent Deck settings section for the Codex account profile, default model, and history display window
- Runtime availability and error messages, resize handling, exit status, and session cleanup
- DSH-authenticated local API and bounded output replay after a temporary connection loss
- Configurable working directory and concurrent session limit

## Requirements

- Node.js `^22.19.0` or `>=24.0.0`
- A DeepSeek Harness build with the `0.1.5` or `0.1.7` client slot and connection APIs
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

For a conversation card, ask the Seal Harness/DSH assistant to delegate one or more tasks to Codex through the `agent_deck_delegate` tool. The assistant must actually call this tool; merely opening a Codex terminal does not insert a tool card into the conversation. Click a child card to open the corresponding terminal output in the native right sidebar. The right sidebar's guide also opens Agent Deck's recent task groups for history playback.

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
  defaultModel: ''   # empty uses the Codex CLI default
  codexProfile: ''   # empty uses the current Codex account
  codexAccountId: '' # saved agent-switch account id when a profile is selected
  historyDays: 30   # show groups from the last 1–365 days
```

Manual terminals use the Host plugin's configured working directory. Delegated Codex tasks use their parent DSH session's workspace when available, falling back to that Host directory. Browser requests cannot choose an arbitrary working directory or command; only the six fixed provider names are accepted. The settings page saves the Codex profile, selected saved-account ID, and model for new delegated tasks. It lists account labels from Agent Switch's local index but does not read or display authentication secrets. An independent Codex profile needs a saved account selected before it can run unattended.

## Architecture

`src/index.ts` registers the model-facing tool and authenticated Host routes through DSH Connection. `src/delegation.ts` keys each task group by the DSH tool call ID and stores its metadata and terminal output under `$DSH_HOME/agent-deck/`; completed output remains viewable after restart. `src/client-extras.tsx` contributes the settings section, keyed tool card, and native right-sidebar tab. The original `src/client.tsx` manual launcher and `src/sessions.ts` interactive PTYs remain available.

The shell's output and captured model conversations can contain sensitive material. Agent Switch stores captures in its normal local store; Agent Deck also keeps delegated terminal output locally for history playback. It does not upload logs or add telemetry. A Host restart ends running processes; saved output can be reviewed, but the original PTY process cannot be resumed.

## Origin and license

This plugin adapts the panel behavior from [OpenAgentSeal](https://github.com/ASunYC/OpenAgentSeal). See [NOTICE](NOTICE) and [LICENSE](LICENSE). The terminal stylesheet comes from xterm.js under the MIT License.
