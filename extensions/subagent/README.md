# Subagent Extension

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate process: `pi` by default, or `claude` / `codex` when the agent (or the call) names that harness
- **Any harness, any model**: `harness`, `model` and `effort` on an agent file or on the call pick the CLI and model the child runs on; the child's event stream is normalized back into pi messages, so rendering and usage look the same whoever did the work
- **Terminal runs**: `{terminal: true}` (or `terminal: herdr` in the agent file) runs the child interactively in a new Herdr tab a human can watch, answer or type at; the parent waits for it to settle and reads its report
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Background runs**: `{background: true}` returns a run id and notifies on completion; `{status: true}` lists runs, `{cancel: "<id>"}` stops one (signalling its process group), and `{resume: "<id>", task: "..."}` continues a finished run under its own session, so the child keeps everything it already saw; max 8 running at once
- **Bounded fan-out**: A subagent refuses to spawn subagents of its own (an env marker the tool honors: steering, not a sandbox)
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension: tool schema, dispatch, session hooks
├── agents.ts            # Agent discovery and frontmatter
├── child.ts             # How a child is configured before it is spawned
├── harness.ts           # Which CLI a child runs on (pi, claude, codex): flags and event normalizers
├── herdr.ts             # Terminal runs: a child in a Herdr tab, driven through the herdr CLI
├── run.ts               # Spawning one child and parsing its event stream
├── modes.ts             # Single, parallel, chain, background, terminal, and the project-agent gate
├── background.ts        # Background run registry and spawning
├── worktree.ts          # isolation: worktree setup and teardown
├── params.ts            # The tool schema and the types derived from it
├── types.ts             # Result shapes shared by the tool and its renderers
├── concurrency.ts       # Parallel-run caps and the bounded worker pool
├── registry-text.ts     # Text for /tasks, /agents and completion notices
├── render.ts            # Transcript formatting shared with the parent
├── render-result.ts     # How a call and its results are drawn
├── agents/              # Bundled builtin agents, always available (lowest precedence)
│   ├── explore.md       # Explore: fast read-only codebase exploration
│   ├── plan.md          # Plan: read-only implementation planning
│   └── general-purpose.md   # general-purpose: full capabilities
```

## Installation

Installed with pi-code (`pi install npm:pi-code`); nothing to set up separately.

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Loads the bundled builtin agents (Explore, Plan, general-purpose) plus **user-level agents** from `~/.claude/agents` and `~/.pi/agent/agents`. A user or project agent with the same name overrides a builtin. Discovered agents and their descriptions are listed in the system prompt each turn, so the model can pick one itself; project agent descriptions appear only once the project is approved.

Project-local agents (`.claude/agents`, `.pi/agents`) load once the project is approved: a default call resolves `agentScope` to `"both"` for an approved project and `"user"` otherwise, and an explicit `agentScope` still narrows or widens it. Every invocation passes the project-agent gate either way.

When running interactively, the tool prompts for confirmation before running project-local agents. `confirmProjectAgents: false` skips that prompt for a project you have already approved; an unapproved project is still asked about.

## Usage

### Single agent
```
Use Explore to find all authentication code
```

### Parallel execution
```
Run 2 Explore agents in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have Explore find the read tool, then have Plan suggest improvements
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
disallowedTools: write, edit
model: gpt-oss:20b
effort: high
---

System prompt for the agent goes here.
```

Claude Code fields map onto pi where a sensible seam exists: `tools` and
`disallowedTools` (comma string or YAML list) become pi's `--tools` /
`--exclude-tools`; `effort` becomes the `:thinking` suffix on a pinned model, or
`--thinking` when no model is pinned;
`permissionMode: plan` selects a read-only toolset unless `tools` is set. Model
aliases (`sonnet`, `opus`, `haiku`, `fable`) resolve against the models this machine
is authenticated for, falling back to the session's default model when that tier is
unavailable; `inherit` is the session model by definition. `skills` names skills to preload: their bodies are inlined into the child's
prompt, since a child pi process does not inherit the parent's skill discovery, and
a name that resolves to nothing is reported in the prompt rather than dropped.
Fields with no pi seam are ignored, each verified against pi's CLI rather than
assumed: `mcpServers` (a child reads MCP config from files, and writing config
into the workspace to fake it would be worse than the gap). `maxTurns` and
`memory` are honored (turn cap enforced at the turn boundary; per-agent memory
directories injected into the child's prompt). `isolation: worktree` is honored:
the child runs in a temporary git worktree branched from the repository's default
branch, removed afterwards when the agent made no changes and reported in the
run's output when kept; a run that cannot get its worktree fails rather than
touching the real checkout, and an unrecognized `isolation` value rejects the
definition. Divergence: pi sets the child's working directory into the worktree
but does not police commands that navigate back out, which Claude additionally
enforces per call.

### Harnesses

`harness: pi | claude | codex` picks the coding-agent CLI the child runs on; absent
means pi, and any other value rejects the definition (a misspelling would silently
run the work on another vendor's model). The same three fields are accepted on every
call that names an agent (`agent`, each `tasks[]` and `chain[]` item) as `harness`,
`model` and `effort`, and win over the file's, so an orchestrator can staff one task
onto codex and the next onto claude from the same agent definition.

| | pi | claude | codex |
|---|---|---|---|
| Headless launch | `pi --mode json -p --no-session` | `claude -p --output-format stream-json --verbose` | `codex exec --json --skip-git-repo-check -s <sandbox> -` |
| Task | last argument | stdin | stdin |
| System prompt | `--system-prompt <file>` | `--system-prompt-file <file>` | `-c developer_instructions=<toml string>` |
| Model | `--model <id[:effort]>` (tier aliases resolved against pi's models) | `--model <id or alias>` (`haiku`, `sonnet`, `opus` pass through) | `-m <id>` (concrete ids only) |
| Effort | `:effort` suffix or `--thinking` | `--effort` | `-c model_reasoning_effort=` (`low`..`max`; `off`/`minimal` are refused) |
| Tools | `--tools` / `--exclude-tools` | `--allowedTools` / `--disallowedTools` in Claude's spellings; MCP names via the parent's roster | not applicable |
| Permissions | pi's own | `--permission-mode <permissionMode or acceptEdits>`: prompts cannot be answered in print mode, so edits are accepted and Bash keeps the user's allowlist | `-s read-only` for `permissionMode: plan`, else `workspace-write`; exec never asks |
| maxTurns | killed at the turn boundary, output marked partial | `--max-turns`, `error_max_turns` marked partial | no turn cap in exec mode; not enforced |
| Background runs | yes (resume via `--session-id`) | refused: run in the foreground or in a terminal | refused: same |

Each external stream is read back into pi messages: an assistant message per turn
(claude's per-block events are coalesced by message id), a tool call plus a tool
result per tool use (`command_execution` becomes `bash`, `file_change` becomes
`edit`, `mcp_tool_call` becomes `<server>_<tool>`), cost and tokens from the run's
final accounting. The binaries are found on `PATH`.

### Terminal runs (Herdr)

`terminal: herdr` in the agent file, or `terminal: true` on a single-mode call, runs
the child in a Herdr tab instead of headless. The parent pi must itself be inside
Herdr (`HERDR_ENV=1`, `HERDR_WORKSPACE_ID` set). The run creates one tab in the
parent's workspace without taking focus, starts the harness there with the same
model, effort, prompt and tool flags an interactive session takes (`herdr agent
start --kind <harness>`), and sends one prompt: read the brief file, do the work,
write the final report to a report file, reply with its path. The parent waits
(`herdr agent prompt --wait`, 30 minutes) and returns the report; a child that wrote
no report is read from its pane instead. A run that ends `idle`/`done` closes its
tab. One that ends `blocked` (an approval or question a human must answer), stalled,
timed out or failed keeps the tab and returns its name: `{resume: "<name>", task:
"..."}` sends a follow-up into that tab, `{cancel: "<name>"}` interrupts it and
closes the tab, and `{status: true}` lists kept tabs beside background runs.
Aborting the tool call interrupts the child and closes its tab.

**Locations:**
- `~/.claude/agents/*.md`, `~/.pi/agent/agents/*.md` - User-level (always loaded; `~/.pi` wins a name conflict)
- `.claude/agents/*.md`, `.pi/agents/*.md` - Project-level (an approved project, or an explicit `agentScope` of `"project"`/`"both"`; `.pi` wins a name conflict)

Project agents override user agents with the same name when both scopes are in play.

## Builtin Agents

| Agent | Purpose | Tools |
|-------|---------|-------|
| `Explore` | Fast read-only codebase exploration | read, grep, find, ls |
| `Plan` | Read-only implementation planning | read, grep, find, ls |
| `general-purpose` | Full capabilities, isolated context | (all default) |

No model is pinned: each runs on the session's default model.

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
