# Upgrade to Agent Switch

The new package is `@asun-labs/dsh-plugin-agent-switch`. Remove the earlier plugin from the same Harness profile before installing it, so two copies cannot start the same tools and terminal services:

```powershell
dsh plugin --profile web remove @asun-labs/dsh-plugin-agent-deck
dsh plugin --profile web add @asun-labs/dsh-plugin-agent-switch
```

Restart the Host after replacing the package. Replace `web` with your active profile name.

On the first start, when `$DSH_HOME/agent-switch/` does not yet exist, the plugin copies settings and saved CLI output from `$DSH_HOME/agent-deck/`. The earlier directory is kept intact, and existing new-package data is never overwritten.

New conversations use `agent_switch_delegate`. Existing `agent_deck_delegate` conversation cards and earlier sidebar tab records remain readable through compatibility registrations, with the Agent Switch display name. Running CLI processes are not transferred across a Host restart.
