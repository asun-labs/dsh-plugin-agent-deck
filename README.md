# Agent Switch for DeepSeek Harness

Install the Agent Switch plugin as `@asun-labs/dsh-plugin-agent-switch`. Existing users can follow the [upgrade guide](MIGRATION.md); saved settings and terminal output are imported automatically on first launch.

`@asun-labs/dsh-plugin-agent-switch` connects Codex child tasks to a DeepSeek Harness conversation. A model-facing tool launches parallel Codex CLI processes through `agent-switch`, renders a live task card in the conversation, and opens their terminal output in the native right sidebar. The manual multi-CLI runtime panel is also available as a native right-sidebar tab.

## Features

- Interactive terminals for Claude Code, Codex, CodeWhale, the DeepSeek compatibility alias, Kimi, and OpenCode
- Tabs and grid layouts with independent terminal sessions
- A custom conversation card for `agent_switch_delegate` with one child card per Codex task
- A native DSH right-sidebar tab with live output and saved output replay for completed tasks
- An Agent Switch settings section for the Codex account profile, default model, and history display window
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
dsh --profile agent-switch --from-default-profile web --dump-config | Out-Null
dsh plugin --profile agent-switch add @asun-labs/dsh-plugin-agent-switch
dsh --profile agent-switch --no-open
```

`node-pty` needs to run its native install script. If DSH reports that pnpm blocked the `node-pty` build, open the Web plugin page, review the named script, and use **Allow these scripts and retry** for that profile. The permission is recorded in that profile's `allowBuilds` setting.

Open the right sidebar's **Agent Switch Panel** tab, choose a runtime, and switch between **Grid** and **Tabs** in the panel header. Switching to another right-sidebar tab keeps its CLI sessions running; close a terminal explicitly to stop it.

To use Agent Switch, ask the Seal Harness/DSH assistant: “Use Agent Switch to delegate these tasks to Codex.” It calls `agent_switch_delegate`, which creates the conversation card. Click a child card to open the corresponding terminal output in the native right sidebar. The right sidebar's guide also opens Agent Switch's recent task groups for history playback.

## Install from a local checkout

Build this package with Node 22.19+ or 24+:

```powershell
corepack pnpm install
corepack pnpm run check
```

Initialize a DSH profile if needed, then install the package by absolute path:

```powershell
dsh --profile agent-switch --from-default-profile web --dump-config | Out-Null
dsh plugin --profile agent-switch add <absolute-path-to-dsh-plugin-agent-switch>
dsh --profile agent-switch --dump-config
dsh --profile agent-switch --no-open
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

`src/index.ts` registers the model-facing tool and authenticated Host routes through DSH Connection. `src/delegation.ts` keys each task group by the DSH tool call ID and stores its metadata and terminal output under `$DSH_HOME/agent-switch/`; completed output remains viewable after restart. `src/client-extras.tsx` contributes the settings section, keyed tool card, and native right-sidebar tabs. `src/client.tsx` provides the manual runtime panel and `src/sessions.ts` manages its interactive PTYs.

The shell's output and captured model conversations can contain sensitive material. The `agent-switch` CLI stores model captures in its normal local store; this plugin also keeps delegated terminal output locally for history playback. It does not upload logs or add telemetry. A Host restart ends running processes; saved output can be reviewed, but the original PTY process cannot be resumed.

## Origin and license

This plugin adapts the panel behavior from [OpenAgentSeal](https://github.com/ASunYC/OpenAgentSeal). See [NOTICE](NOTICE) and [LICENSE](LICENSE). The terminal stylesheet comes from xterm.js under the MIT License.
