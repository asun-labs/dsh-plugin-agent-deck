# Agent Switch

This repository implements the **Agent Switch** plugin for Seal Harness / DeepSeek Harness.

- npm: `@asun-labs/dsh-plugin-agent-switch`.
- Repository: `https://github.com/asun-labs/dsh-plugin-agent-switch`.
- Model-facing tool: `agent_switch_delegate`; its description routes requests mentioning Agent Switch to this plugin.
- Host API: `/api/agent-switch/`.
- Persisted plugin data: `$DSH_HOME/agent-switch/`.
- Public UI, documentation, and new technical identifiers use Agent Switch naming.
- Previous identities exist only in `src/compatibility.ts` and the upgrade guide, for saved-data and conversation compatibility.
- Release checks: `pnpm run check`. Version tags trigger `.github/workflows/publish.yml`.
