/**
 * Harness runners: the coding-agent CLI a child runs on.
 *
 * pi's subagent has always been a CLI callout (`pi --mode json -p`); a harness is
 * the same callout aimed at a different binary. Each runner answers three questions
 * and nothing else: how to launch the CLI headless, how to launch it interactively
 * (for a Herdr tab), and how to read its event stream back into pi messages so the
 * renderers, usage accounting and chain/parallel plumbing never learn which vendor
 * did the work.
 *
 * Event shapes were captured from live runs (claude 2.1.x `--output-format
 * stream-json --verbose`, codex-cli 0.142 `exec --json`); the normalizer tests pin
 * those fixtures.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { AssistantMessage, Message, StopReason, ToolResultMessage, Usage } from '@earendil-works/pi-ai'

import { claudeToolName } from '../internal/claude-tool-names.js'
import { type AgentConfig, HARNESS_KINDS, type HarnessKind, resolveModelAlias } from './agents.js'
import { agentInvocationArgs, claudeMcpToolNames } from './child.js'

/** Per-call staffing: the caller (or a staffing advisor upstream of it) names the
 * harness, model and effort for this one run, over whatever the agent file says.
 * A model override drops the file's tier alias too: the two would otherwise
 * disagree about which model was asked for. */
export interface LaunchOverrides {
  harness?: HarnessKind
  model?: string
  effort?: string
}

export function applyLaunchOverrides(agent: AgentConfig, overrides: LaunchOverrides | undefined): AgentConfig {
  if (!overrides) return agent
  return {
    ...agent,
    ...(overrides.harness ? { harness: overrides.harness } : {}),
    ...(overrides.model ? { model: overrides.model, modelAlias: undefined } : {}),
    ...(overrides.effort ? { effort: overrides.effort } : {}),
  }
}

/** The error text for an override naming a harness this build does not have. */
export function invalidHarnessError(value: string): string {
  return `Unknown harness "${value}". Available harnesses: ${[...HARNESS_KINDS].join(', ')}.`
}

/** The model a launch asks its harness for. pi resolves a Claude tier alias against
 * the models this user can run (agentInvocationArgs adds the env fallback); claude
 * takes a concrete id or the alias verbatim (`haiku` is what `claude --model`
 * wants); codex takes only a concrete id, since the aliases name Anthropic tiers. */
export function launchModelFor(agent: AgentConfig, available: ReadonlyArray<{ id: string }>): string | undefined {
  switch (harnessKindOf(agent)) {
    case 'pi':
      return resolveModelAlias(agent.modelAlias, available)
    case 'claude':
      return claudeModelFor(agent, undefined)
    case 'codex':
      return agent.model
  }
}

/** Everything a runner needs to launch one child. Model and effort arrive already
 * resolved (frontmatter, tier alias, env, or a per-call override). */
export interface HarnessLaunch {
  agent: AgentConfig
  model?: string
  effort?: string
  /** Path of the temp file holding the child's system prompt, when it has one. */
  systemPromptPath?: string
  /** The same prompt as text, for a CLI that takes it inline rather than by path. */
  systemPromptBody?: string
  /** The task, with any SubagentStart hook context already ahead of it. */
  task: string
}

export interface HarnessInvocation {
  command: string
  args: string[]
  /** The task rides stdin rather than argv: claude's variadic `--allowedTools`
   * would swallow a trailing positional, and stdin has no argv length cap. */
  stdin?: string
}

/** One normalized happening in a child's stream. Messages arrive complete: a runner
 * whose CLI streams an assistant message in pieces coalesces them first, so every
 * assistant message the parent sees is one agentic turn. */
export type HarnessEvent =
  | { type: 'message'; message: Message }
  /** End-of-run facts the stream only reports once: cost, tokens a CLI reports per
   * turn rather than per message, the stop reason, an error. */
  | { type: 'summary'; cost?: number; usage?: Partial<Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>>; stopReason?: StopReason; errorMessage?: string; model?: string; partial?: boolean }

export interface HarnessParser {
  /** Parse one JSONL line. Unparseable or irrelevant lines yield nothing. */
  feed(line: string): HarnessEvent[]
  /** Anything still buffered when the stream closes. */
  flush(): HarnessEvent[]
}

export interface HarnessRunner {
  kind: HarnessKind
  /** The CLI binary Herdr starts for `agent start --kind`; same word as `kind`. */
  headless(launch: HarnessLaunch): HarnessInvocation
  /** Native flags for an interactive session (`herdr agent start ... -- <args>`):
   * the same model, effort, prompt and tool configuration, minus print mode. */
  interactive(launch: HarnessLaunch): string[]
  /** A fresh parser for one run; the launch is there for the one CLI whose stream
   * omits facts the parent needs (codex never echoes the model). */
  createParser(launch: HarnessLaunch): HarnessParser
  /** True when the CLI enforces `maxTurns` itself, so the parent must not also kill
   * the child at the turn boundary. */
  nativeMaxTurns: boolean
  /** A reason this launch cannot run on this harness, checked before spawning so the
   * refusal names the field instead of surfacing as a CLI boot error. */
  validate?(launch: HarnessLaunch): string | undefined
}

const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function assistant(model: string, content: AssistantMessage['content'], usage: Usage, stopReason: StopReason, extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: 'assistant', content, api: 'harness', provider: 'harness', model, usage, stopReason, timestamp: Date.now(), ...extra }
}

function toolResult(toolCallId: string, toolName: string, text: string, isError: boolean): ToolResultMessage {
  return { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError, timestamp: Date.now() }
}

/** The model a Claude child should be asked for: a concrete id, else the tier alias
 * pi dropped because pi cannot resolve it, which is exactly what `claude --model`
 * wants (`haiku`, `sonnet`, `opus`). */
export function claudeModelFor(agent: Pick<AgentConfig, 'model' | 'modelAlias'>, resolved: string | undefined): string | undefined {
  return resolved ?? agent.model ?? agent.modelAlias
}

// ---------------------------------------------------------------------------- pi

/** Exported as a test seam: the fallbacks only fire in packaged distributions
 * (bun single-file, compiled binary), which no CI run reaches naturally. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1]
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/')
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }

  const execName = path.basename(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) {
    return { command: process.execPath, args }
  }

  return { command: 'pi', args }
}

/** pi's own `-p` flags, which the interactive launch must not carry. */
const PI_PRINT_FLAGS = new Set(['--mode', '-p', '--no-session'])

function piArgsWithoutPrintMode(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!PI_PRINT_FLAGS.has(arg)) {
      out.push(arg)
      continue
    }
    if (arg === '--mode') i++ // skip its value
  }
  return out
}

function piBaseArgs(launch: HarnessLaunch): string[] {
  const args = agentInvocationArgs(launch.agent, launch.model)
  if (launch.systemPromptPath) args.push('--system-prompt', launch.systemPromptPath)
  return args
}

const piRunner: HarnessRunner = {
  kind: 'pi',
  nativeMaxTurns: false,
  headless(launch) {
    return getPiInvocation([...piBaseArgs(launch), launch.task])
  },
  interactive(launch) {
    return piArgsWithoutPrintMode(piBaseArgs(launch))
  },
  createParser() {
    return {
      feed(line) {
        const event = parseJsonLine(line)
        if (!event?.message) return []
        if (event.type === 'message_end' || event.type === 'tool_result_end') return [{ type: 'message', message: event.message as Message }]
        return []
      },
      flush: () => [],
    }
  },
}

// ------------------------------------------------------------------------ claude

/** Claude's spelling for each pi tool name in a grant list; MCP tools translate
 * through the parent's alias roster, unknown names pass through unchanged. */
export function claudeToolList(tools: string[]): string[] {
  return claudeMcpToolNames(tools).map((name) => claudeToolName(name) ?? name)
}

/** Claude's permission mode for a headless child. Prompts cannot be answered in `-p`
 * mode, so an unset mode would deny every edit; acceptEdits keeps the user's own
 * Bash allowlist in force while letting file edits through. `plan` stays plan. */
export const CLAUDE_DEFAULT_PERMISSION_MODE = 'acceptEdits'

function claudeCommonArgs(launch: HarnessLaunch): string[] {
  const { agent } = launch
  const args: string[] = []
  if (launch.model) args.push('--model', launch.model)
  if (launch.effort) args.push('--effort', launch.effort)
  if (launch.systemPromptPath) args.push('--system-prompt-file', launch.systemPromptPath)
  if (agent.tools && agent.tools.length > 0) args.push('--allowedTools', ...claudeToolList(agent.tools))
  if (agent.disallowedTools && agent.disallowedTools.length > 0) args.push('--disallowedTools', ...claudeToolList(agent.disallowedTools))
  args.push('--permission-mode', agent.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE)
  return args
}

interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface ClaudeContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface ClaudeApiMessage {
  id?: string
  model?: string
  role?: string
  content?: ClaudeContentBlock[] | string
  usage?: ClaudeUsage
  stop_reason?: string | null
}

function claudeUsage(raw: ClaudeUsage | undefined): Usage {
  const input = raw?.input_tokens ?? 0
  const output = raw?.output_tokens ?? 0
  const cacheRead = raw?.cache_read_input_tokens ?? 0
  const cacheWrite = raw?.cache_creation_input_tokens ?? 0
  return { ...EMPTY_USAGE, input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite }
}

function claudeStopReason(raw: string | null | undefined, hasToolUse: boolean): StopReason {
  if (raw === 'max_tokens') return 'length'
  if (raw === 'tool_use' || hasToolUse) return 'toolUse'
  return 'stop'
}

/** Text of a tool_result block: Claude sends a string or a list of text blocks. */
function claudeResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : undefined))
      .filter((text): text is string => text !== undefined)
      .join('\n')
  }
  return ''
}

/** Claude streams one `assistant` event per content block, all sharing the message
 * id and carrying that message's cumulative usage; the parser folds them into one
 * assistant message and releases it when the id changes, a tool result arrives, or
 * the run ends. */
function createClaudeParser(): HarnessParser {
  let pending: { id: string; message: AssistantMessage } | undefined
  const toolNames = new Map<string, string>()
  const release = (): HarnessEvent[] => {
    if (!pending) return []
    const message = pending.message
    pending = undefined
    return [{ type: 'message', message }]
  }
  return {
    feed(line) {
      const event = parseJsonLine(line)
      if (!event) return []
      if (event.type === 'assistant') {
        const msg = (event.message ?? {}) as ClaudeApiMessage
        const blocks = Array.isArray(msg.content) ? msg.content : []
        const content: AssistantMessage['content'] = []
        for (const block of blocks) {
          if (block.type === 'text' && typeof block.text === 'string') content.push({ type: 'text', text: block.text })
          else if (block.type === 'thinking') content.push({ type: 'thinking', thinking: block.thinking ?? '' })
          else if (block.type === 'tool_use' && block.id && block.name) {
            toolNames.set(block.id, block.name)
            content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: block.input ?? {} })
          }
        }
        const id = msg.id ?? ''
        const hasToolUse = content.some((part) => part.type === 'toolCall')
        const out: HarnessEvent[] = []
        if (pending && pending.id !== id) out.push(...release())
        if (pending) {
          pending.message.content.push(...content)
          pending.message.usage = claudeUsage(msg.usage)
          if (hasToolUse) pending.message.stopReason = 'toolUse'
        } else {
          pending = { id, message: assistant(msg.model ?? '', content, claudeUsage(msg.usage), claudeStopReason(msg.stop_reason, hasToolUse), { responseId: id || undefined }) }
        }
        return out
      }
      if (event.type === 'user') {
        const msg = (event.message ?? {}) as ClaudeApiMessage
        const blocks = Array.isArray(msg.content) ? msg.content : []
        const out = release()
        for (const block of blocks) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue
          out.push({ type: 'message', message: toolResult(block.tool_use_id, toolNames.get(block.tool_use_id) ?? 'tool', claudeResultText(block.content), block.is_error === true) })
        }
        return out
      }
      if (event.type === 'result') {
        const out = release()
        // Claude's own maxTurns cap ends the run with error_max_turns: output kept,
        // marked partial, not a failure (the parent path treats its cap the same).
        const capped = event.subtype === 'error_max_turns'
        const isError = !capped && (event.is_error === true || event.subtype !== 'success')
        const errorText = typeof event.result === 'string' ? event.result : undefined
        const errors = Array.isArray(event.errors) ? (event.errors as unknown[]).map(String).join('\n') : undefined
        out.push({
          type: 'summary',
          cost: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined,
          stopReason: isError ? 'error' : event.stop_reason === 'max_tokens' ? 'length' : 'stop',
          errorMessage: isError ? errors || errorText || `claude exited with ${String(event.subtype)}` : undefined,
          partial: capped || undefined,
        })
        return out
      }
      return []
    },
    flush: release,
  }
}

const claudeRunner: HarnessRunner = {
  kind: 'claude',
  nativeMaxTurns: true,
  headless(launch) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', ...claudeCommonArgs(launch)]
    if (launch.agent.maxTurns) args.push('--max-turns', String(launch.agent.maxTurns))
    return { command: 'claude', args, stdin: launch.task }
  },
  interactive(launch) {
    return claudeCommonArgs(launch)
  },
  createParser: createClaudeParser,
}

// ------------------------------------------------------------------------- codex

/** A TOML basic string for `codex -c key=value`. JSON's escapes are a subset of
 * TOML's (`\n`, `\"`, `\\`, `\uXXXX`), and JSON.stringify never emits `\/`. */
export function tomlString(value: string): string {
  return JSON.stringify(value)
}

function codexCommonArgs(launch: HarnessLaunch): string[] {
  const args: string[] = []
  if (launch.model) args.push('-m', launch.model)
  if (launch.effort) args.push('-c', `model_reasoning_effort=${tomlString(launch.effort)}`)
  if (launch.systemPromptBody?.trim()) args.push('-c', `developer_instructions=${tomlString(launch.systemPromptBody)}`)
  return args
}

/** Codex's sandbox for a headless child: `plan` agents read only, everyone else may
 * write inside the working directory. Approvals cannot be answered in exec mode. */
export function codexSandboxFor(agent: Pick<AgentConfig, 'permissionMode'>): string {
  return agent.permissionMode === 'plan' ? 'read-only' : 'workspace-write'
}

interface CodexItem {
  id?: string
  type?: string
  text?: string
  message?: string
  command?: string
  aggregated_output?: string
  exit_code?: number | null
  status?: string
  changes?: unknown
  server?: string
  tool?: string
  arguments?: unknown
  result?: unknown
  error?: unknown
  query?: string
}

interface CodexUsage {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

function codexItemMessages(item: CodexItem, model: string): Message[] {
  const id = item.id ?? `codex-${Date.now()}`
  switch (item.type) {
    case 'agent_message':
      return [assistant(model, [{ type: 'text', text: item.text ?? '' }], EMPTY_USAGE, 'stop')]
    case 'reasoning':
      return [assistant(model, [{ type: 'thinking', thinking: item.text ?? '' }], EMPTY_USAGE, 'stop')]
    case 'command_execution':
      return [assistant(model, [{ type: 'toolCall', id, name: 'bash', arguments: { command: item.command ?? '' } }], EMPTY_USAGE, 'toolUse'), toolResult(id, 'bash', item.aggregated_output ?? '', typeof item.exit_code === 'number' && item.exit_code !== 0)]
    case 'file_change':
      return [assistant(model, [{ type: 'toolCall', id, name: 'edit', arguments: { changes: item.changes ?? [] } }], EMPTY_USAGE, 'toolUse'), toolResult(id, 'edit', item.status ?? 'completed', item.status === 'failed')]
    case 'mcp_tool_call': {
      const name = [item.server, item.tool].filter(Boolean).join('_') || 'mcp'
      const args = item.arguments && typeof item.arguments === 'object' ? (item.arguments as Record<string, unknown>) : {}
      return [assistant(model, [{ type: 'toolCall', id, name, arguments: args }], EMPTY_USAGE, 'toolUse'), toolResult(id, name, item.error ? String(item.error) : JSON.stringify(item.result ?? null), Boolean(item.error))]
    }
    case 'web_search':
      return [assistant(model, [{ type: 'toolCall', id, name: 'web_search', arguments: { query: item.query ?? '' } }], EMPTY_USAGE, 'toolUse'), toolResult(id, 'web_search', item.status ?? 'completed', false)]
    default:
      return []
  }
}

/** Codex reports items as they complete and usage once per turn; `error` items and
 * `turn.failed` carry the failure text. The model is not echoed, so the launch's
 * model is stamped on every message. */
function createCodexParser(model: string): HarnessParser {
  let errorMessage: string | undefined
  return {
    feed(line) {
      const event = parseJsonLine(line)
      if (!event) return []
      if (event.type === 'item.completed') {
        const item = (event.item ?? {}) as CodexItem
        if (item.type === 'error') {
          errorMessage = item.message ?? 'codex reported an error'
          return []
        }
        return codexItemMessages(item, model).map((message) => ({ type: 'message', message }))
      }
      if (event.type === 'turn.completed') {
        const usage = (event.usage ?? {}) as CodexUsage
        const cacheRead = usage.cached_input_tokens ?? 0
        return [{ type: 'summary', usage: { input: Math.max(0, (usage.input_tokens ?? 0) - cacheRead), output: usage.output_tokens ?? 0, cacheRead, cacheWrite: 0 }, stopReason: errorMessage ? 'error' : 'stop', errorMessage, model }]
      }
      if (event.type === 'turn.failed' || event.type === 'error') {
        const error = event.error as { message?: string } | undefined
        const text = error?.message ?? (typeof event.message === 'string' ? event.message : 'codex turn failed')
        errorMessage = text
        return event.type === 'turn.failed' ? [{ type: 'summary', stopReason: 'error', errorMessage: text, model }] : []
      }
      return []
    },
    flush: () => [],
  }
}

/** codex-cli's `model_reasoning_effort` values; pi's `off` and `minimal` have no
 * codex spelling and are refused rather than silently mapped. */
const CODEX_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

const codexRunner: HarnessRunner = {
  kind: 'codex',
  validate(launch) {
    if (launch.effort && !CODEX_EFFORTS.has(launch.effort)) return `effort "${launch.effort}" is not a codex reasoning effort (one of ${[...CODEX_EFFORTS].join(', ')})`
    return undefined
  },
  // `codex exec` runs one turn to completion; there is no turn cap to enforce and
  // no boundary to kill at, so maxTurns is documented as pi/claude only.
  nativeMaxTurns: true,
  headless(launch) {
    return { command: 'codex', args: ['exec', '--json', '--skip-git-repo-check', '-s', codexSandboxFor(launch.agent), ...codexCommonArgs(launch), '-'], stdin: launch.task }
  },
  interactive(launch) {
    return codexCommonArgs(launch)
  },
  createParser(launch) {
    return createCodexParser(launch.model ?? '')
  },
}

const RUNNERS: Record<HarnessKind, HarnessRunner> = { pi: piRunner, claude: claudeRunner, codex: codexRunner }

/** The runner for an agent, with the effective harness (frontmatter, else pi). */
export function runnerFor(agent: Pick<AgentConfig, 'harness'>): HarnessRunner {
  return RUNNERS[harnessKindOf(agent)]
}

export function harnessKindOf(agent: Pick<AgentConfig, 'harness'>): HarnessKind {
  return agent.harness ?? 'pi'
}
