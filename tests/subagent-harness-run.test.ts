import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig } from '../extensions/subagent/agents.ts'
import subagentExtension from '../extensions/subagent/index.ts'
import { runSingleAgent } from '../extensions/subagent/run.ts'
import type { SingleResult } from '../extensions/subagent/types.ts'

const spawnMock = vi.hoisted(() => vi.fn())
const discoverAgentsMock = vi.hoisted(() => vi.fn())
const herdrMock = vi.hoisted(() => ({
  runInHerdr: vi.fn(),
  resumeInHerdr: vi.fn(),
  cancelInHerdr: vi.fn(),
  herdrRun: vi.fn(),
  herdrRuns: vi.fn((): unknown[] => []),
}))

vi.mock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<object>()), spawn: spawnMock }))
vi.mock('../extensions/subagent/agents.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../extensions/subagent/agents.js')>()), discoverAgents: discoverAgentsMock }))
vi.mock('../extensions/subagent/herdr.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../extensions/subagent/herdr.js')>()), ...herdrMock }))

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  kill = vi.fn()
  pid = 4242
}

interface SpawnCall {
  command: string
  args: string[]
  options: { cwd?: string; stdio?: unknown; env?: Record<string, string> }
  child: FakeChild
}

let spawnCalls: SpawnCall[] = []
let nextScript: { stdout: string[]; exitCode?: number } = { stdout: [] }

const agent = (over: Partial<AgentConfig> = {}): AgentConfig => ({ name: 'scout', description: 'a scout', systemPrompt: 'You scout.', source: 'user', filePath: '/agents/scout.md', ...over })

const makeDetails = (results: SingleResult[]) => ({ mode: 'single' as const, agentScope: 'user' as const, projectAgentsDir: null, results })

const claudeLines = [
  { type: 'assistant', message: { id: 'm1', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt', is_error: false }] } },
  { type: 'assistant', message: { id: 'm2', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'one file' }], usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 } } },
  { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, stop_reason: 'end_turn' },
].map((event) => `${JSON.stringify(event)}\n`)

const codexLines = [
  { type: 'thread.started', thread_id: 't' },
  { type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'ls', aggregated_output: 'a.txt\n', exit_code: 0, status: 'completed' } },
  { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'one file' } },
  { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 9 } },
].map((event) => `${JSON.stringify(event)}\n`)

beforeEach(() => {
  spawnCalls = []
  nextScript = { stdout: [] }
  spawnMock.mockReset()
  spawnMock.mockImplementation((command: string, args: string[], options: SpawnCall['options']) => {
    const child = new FakeChild()
    spawnCalls.push({ command, args, options, child })
    const script = nextScript
    setTimeout(() => {
      for (const chunk of script.stdout) child.stdout.emit('data', Buffer.from(chunk))
      child.emit('close', script.exitCode ?? 0)
    }, 0)
    return child
  })
  herdrMock.runInHerdr.mockReset()
  herdrMock.resumeInHerdr.mockReset()
  herdrMock.cancelInHerdr.mockReset()
  herdrMock.herdrRun.mockReset()
  herdrMock.herdrRuns.mockReset()
  herdrMock.herdrRuns.mockReturnValue([])
  discoverAgentsMock.mockReturnValue({ agents: [agent()], projectAgentsDir: null })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runSingleAgent on external harnesses', () => {
  it('runs a claude agent through `claude -p`, feeding the task on stdin and normalizing the stream', async () => {
    nextScript = { stdout: [claudeLines.join('')] }
    const result = await runSingleAgent({ defaultCwd: '/repo', agents: [agent({ harness: 'claude', modelAlias: 'haiku', tools: ['bash'] })], agentName: 'scout', task: 'list files', makeDetails })
    const call = spawnCalls[0]
    expect(call.command).toBe('claude')
    expect(call.args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose'])
    expect(call.args).toEqual(expect.arrayContaining(['--model', 'haiku', '--tools=Bash', '--system-prompt-file']))
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(call.child.stdin.end).toHaveBeenCalledWith('Task: list files')
    expect(call.options.env?.PI_CODE_SUBAGENT).toBe('1')
    // The prompt file existed at spawn time and is gone after the run.
    const promptPath = call.args[call.args.indexOf('--system-prompt-file') + 1]
    expect(fs.existsSync(promptPath)).toBe(false)

    expect(result.exitCode).toBe(0)
    expect(result.messages.map((m) => m.role)).toEqual(['assistant', 'toolResult', 'assistant'])
    expect(result.usage).toMatchObject({ turns: 2, input: 13, output: 24, cacheRead: 35, cacheWrite: 2, cost: 0.01 })
    expect(result.model).toBe('haiku')
    expect(result.stopReason).toBe('stop')
    expect(result.errorMessage).toBeUndefined()
  })

  it('runs a codex agent through `codex exec --json` with the prompt inline and sums turn usage', async () => {
    nextScript = { stdout: [codexLines.join('')] }
    const result = await runSingleAgent({ defaultCwd: '/repo', agents: [agent({ harness: 'codex', model: 'gpt-5.6-sol', effort: 'high' })], agentName: 'scout', task: 'list files', makeDetails })
    const call = spawnCalls[0]
    expect(call.command).toBe('codex')
    expect(call.args.slice(0, 3)).toEqual(['exec', '--json', '-s'])
    expect(call.args).toEqual(expect.arrayContaining(['-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="high"', '-c', 'developer_instructions="You scout."', '-']))
    expect(call.child.stdin.end).toHaveBeenCalledWith('Task: list files')
    expect(result.messages.map((m) => m.role)).toEqual(['assistant', 'toolResult', 'assistant'])
    expect(result.usage).toMatchObject({ turns: 2, input: 60, cacheRead: 40, output: 9, contextTokens: 109 })
    expect(result.model).toBe('gpt-5.6-sol')
    expect(result.stopReason).toBe('stop')
  })

  it('applies per-call overrides and refuses a launch the harness cannot take', async () => {
    nextScript = { stdout: [codexLines.join('')] }
    await runSingleAgent({ defaultCwd: '/repo', agents: [agent()], agentName: 'scout', task: 'go', makeDetails, overrides: { harness: 'codex', model: 'gpt-5.6-luna', effort: 'low' } })
    expect(spawnCalls[0].command).toBe('codex')
    expect(spawnCalls[0].args).toEqual(expect.arrayContaining(['-m', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="low"']))

    const refused = await runSingleAgent({ defaultCwd: '/repo', agents: [agent({ harness: 'codex', effort: 'minimal' })], agentName: 'scout', task: 'go', makeDetails })
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain('cannot run on harness codex')
    expect(refused.stderr).toContain('minimal')
    expect(spawnCalls).toHaveLength(1)
  })

  it('does not kill a claude child at maxTurns (the CLI caps itself) but still marks the capped run partial', async () => {
    const capped = [claudeLines[2], `${JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'capped' })}\n`]
    nextScript = { stdout: capped }
    const result = await runSingleAgent({ defaultCwd: '/repo', agents: [agent({ harness: 'claude', maxTurns: 1 })], agentName: 'scout', task: 'go', makeDetails })
    expect(spawnCalls[0].args).toEqual(expect.arrayContaining(['--max-turns', '1']))
    expect(spawnCalls[0].child.kill).not.toHaveBeenCalled()
    expect(result.partial).toBe(true)
    expect(result.stopReason).toBe('stop')
    expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: expect.arrayContaining([{ type: 'text', text: '[Output is partial: the subagent stopped at its maxTurns limit.]' }]) })
  })

  it('surfaces a codex failure as an error result', async () => {
    nextScript = { stdout: [`${JSON.stringify({ type: 'turn.failed', error: { message: 'model requires a newer Codex' } })}\n`], exitCode: 1 }
    const result = await runSingleAgent({ defaultCwd: '/repo', agents: [agent({ harness: 'codex' })], agentName: 'scout', task: 'go', makeDetails })
    expect(result.exitCode).toBe(1)
    expect(result.stopReason).toBe('error')
    expect(result.errorMessage).toBe('model requires a newer Codex')
  })
})

type Execute = (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>

function getExecute(): Execute {
  let execute: Execute | undefined
  subagentExtension({
    registerTool: (t: { name: string; execute: Execute }) => {
      if (t.name === 'subagent') execute = t.execute
    },
    registerCommand: () => {},
    sendMessage: vi.fn(),
    events: { emit: vi.fn(), on: () => () => {} },
    on: () => {},
  } as never)
  if (!execute) throw new Error('tool not registered')
  return execute
}

const ctx = { cwd: '/repo', hasUI: false, isProjectTrusted: () => true, ui: { confirm: vi.fn(async () => true) } }
const textOf = (r: Awaited<ReturnType<Execute>>): string => r.content[0]?.text ?? ''

describe('subagent tool dispatch for harnesses and terminals', () => {
  it('routes a terminal request to Herdr and returns its outcome text', async () => {
    herdrMock.runInHerdr.mockResolvedValue({ state: 'done', report: 'tab report', run: { name: 'scout-ab12', tabId: 'w1:t2', harness: 'pi' } })
    const execute = getExecute()
    const result = await execute('1', { agent: 'scout', task: 'go', terminal: true, model: 'claude-sonnet-5' }, undefined, undefined, ctx)
    expect(textOf(result)).toBe('tab report')
    const call = herdrMock.runInHerdr.mock.calls[0][0]
    expect(call.runner.kind).toBe('pi')
    expect(call.launch.model).toBeUndefined()
    expect(call.launch.agent.model).toBe('claude-sonnet-5')
    expect(call.launch.systemPromptBody).toBe('You scout.')
    expect(call.launch.task).toBe('Task: go')
    expect(call.cwd).toBe('/repo')
    // An unrestricted agent keeps its full toolset.
    expect(call.launch.agent.tools).toBeUndefined()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('widens a restricted terminal child with write so it can file its report', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agent({ tools: ['read', 'grep'] }), agent({ name: 'writer', tools: ['read', 'write'] })], projectAgentsDir: null })
    herdrMock.runInHerdr.mockResolvedValue({ state: 'done', report: 'ok', run: { name: 'n', tabId: 't', harness: 'pi' } })
    const execute = getExecute()
    await execute('1', { agent: 'scout', task: 'go', terminal: true }, undefined, undefined, ctx)
    expect(herdrMock.runInHerdr.mock.calls[0][0].launch.agent.tools).toEqual(['read', 'grep', 'write'])
    await execute('2', { agent: 'writer', task: 'go', terminal: true }, undefined, undefined, ctx)
    expect(herdrMock.runInHerdr.mock.calls[1][0].launch.agent.tools).toEqual(['read', 'write'])
  })

  it("honors the agent file's terminal: herdr, reports Herdr errors, and needs single mode", async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agent({ terminal: 'herdr', harness: 'claude', modelAlias: 'opus' })], projectAgentsDir: null })
    herdrMock.runInHerdr.mockResolvedValue({ error: 'herdr tab create failed: nope' })
    const execute = getExecute()
    expect(textOf(await execute('1', { agent: 'scout', task: 'go' }, undefined, undefined, ctx))).toBe('herdr tab create failed: nope')
    expect(herdrMock.runInHerdr.mock.calls[0][0].runner.kind).toBe('claude')
    expect(herdrMock.runInHerdr.mock.calls[0][0].launch.model).toBe('opus')
    expect(textOf(await execute('2', { agent: 'ghost', task: 'go', terminal: true }, undefined, undefined, ctx))).toContain('Unknown agent: "ghost"')
    expect(textOf(await execute('3', { tasks: [{ agent: 'scout', task: 'go' }], terminal: true }, undefined, undefined, ctx))).not.toContain('Herdr')
  })

  it('refuses a terminal launch its harness cannot take, without opening a tab', async () => {
    const execute = getExecute()
    const result = await execute('1', { agent: 'scout', task: 'go', terminal: true, harness: 'codex', effort: 'minimal' }, undefined, undefined, ctx)
    expect(textOf(result)).toContain('cannot run on harness codex')
    expect(herdrMock.runInHerdr).not.toHaveBeenCalled()
  })

  it('refuses background runs on non-pi harnesses', async () => {
    const execute = getExecute()
    const result = await execute('1', { agent: 'scout', task: 'go', background: true, harness: 'claude' }, undefined, undefined, ctx)
    expect(textOf(result)).toContain('background: true runs on the pi harness only')
    expect(textOf(result)).toContain('terminal: true')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('resumes, cancels and lists kept terminal runs', async () => {
    herdrMock.herdrRun.mockImplementation((name: string) => (name === 'scout-ab12' ? { name } : undefined))
    herdrMock.resumeInHerdr.mockResolvedValue({ state: 'done', report: 'finished', run: { name: 'scout-ab12', tabId: 'w1:t2', harness: 'pi' } })
    herdrMock.cancelInHerdr.mockResolvedValue({ outcome: 'cancelled', note: '[isolation: worktree kept at /wt]' })
    herdrMock.herdrRuns.mockReturnValue([{ name: 'scout-ab12', agent: 'scout', harness: 'pi', state: 'blocked', tabId: 'w1:t2' }])
    const execute = getExecute()
    expect(textOf(await execute('1', { resume: 'scout-ab12' }, undefined, undefined, ctx))).toContain('Pass task with resume')
    expect(textOf(await execute('2', { resume: 'scout-ab12', task: 'finish' }, undefined, undefined, ctx))).toBe('finished')
    expect(herdrMock.resumeInHerdr).toHaveBeenCalledWith('scout-ab12', 'finish', expect.any(Number), undefined, undefined)
    herdrMock.resumeInHerdr.mockResolvedValue({ error: 'Unknown terminal run: scout-ab12.' })
    expect(textOf(await execute('3', { resume: 'scout-ab12', task: 'finish' }, undefined, undefined, ctx))).toBe('Unknown terminal run: scout-ab12.')
    const cancelled = textOf(await execute('4', { cancel: 'scout-ab12' }, undefined, undefined, ctx))
    expect(cancelled).toContain('Closed terminal run scout-ab12')
    expect(cancelled).toContain('[isolation: worktree kept at /wt]')
    expect(herdrMock.cancelInHerdr).toHaveBeenCalledWith('scout-ab12')
    // A resumed run's report is capped like a fresh one's.
    herdrMock.resumeInHerdr.mockResolvedValue({ state: 'done', report: 'y'.repeat(200_000), run: { name: 'scout-ab12', tabId: 'w1:t2', harness: 'pi' } })
    expect(textOf(await execute('6', { resume: 'scout-ab12', task: 'more' }, undefined, undefined, ctx)).length).toBeLessThan(120_000)
    const status = textOf(await execute('5', { status: true }, undefined, undefined, ctx))
    expect(status).toContain('Terminal runs (Herdr tabs):')
    expect(status).toContain('scout-ab12 scout (pi): blocked, tab w1:t2')
  })

  it('cuts an isolation worktree for a terminal run and hands it, with the hooks env, to Herdr', async () => {
    const worktree = await vi.importActual<typeof import('../extensions/subagent/worktree.ts')>('../extensions/subagent/worktree.ts')
    const create = vi.spyOn(worktree, 'createAgentWorktree').mockResolvedValue({ dir: '/wt/scout', branch: 'scout/x', baseSha: 'abc' })
    discoverAgentsMock.mockReturnValue({ agents: [agent({ isolation: 'worktree', hooks: { Stop: [{ hooks: [] }] } })], projectAgentsDir: null })
    herdrMock.runInHerdr.mockResolvedValue({ state: 'done', report: 'ok', run: { name: 'n', tabId: 't', harness: 'pi', tabOpen: false } })
    const execute = getExecute()
    expect(textOf(await execute('1', { agent: 'scout', task: 'go', terminal: true }, undefined, undefined, ctx))).toBe('ok')
    expect(create).toHaveBeenCalledWith('/repo', 'scout')
    const call = herdrMock.runInHerdr.mock.calls[0][0]
    expect(call.cwd).toBe('/wt/scout')
    expect(call.worktree).toEqual({ dir: '/wt/scout', branch: 'scout/x', baseSha: 'abc', root: '/repo' })
    expect(call.extraEnv).toHaveProperty('PI_CODE_AGENT_HOOKS')
    expect(JSON.parse(call.extraEnv.PI_CODE_AGENT_HOOKS).hooks).toHaveProperty('SubagentStop')
    // No worktree, no run: the boundary the agent declared is never silently dropped.
    create.mockResolvedValue({ error: 'not a git repository' })
    expect(textOf(await execute('2', { agent: 'scout', task: 'go', terminal: true }, undefined, undefined, ctx))).toContain('isolation: worktree could not be created for scout: not a git repository')
    expect(herdrMock.runInHerdr).toHaveBeenCalledTimes(1)
  })

  it('names the real way out when a background: true agent sits on a non-pi harness', async () => {
    discoverAgentsMock.mockReturnValue({ agents: [agent({ background: true, harness: 'codex' })], projectAgentsDir: null })
    const execute = getExecute()
    const result = textOf(await execute('1', { agent: 'scout', task: 'go' }, undefined, undefined, ctx))
    expect(result).toContain("Its file's background: true keeps it out of the foreground")
    expect(result).not.toContain('Run it in the foreground')
  })

  it('passes per-call overrides through single, parallel and chain modes', async () => {
    const execute = getExecute()
    nextScript = { stdout: [codexLines.join('')] }
    await execute('1', { agent: 'scout', task: 'go', harness: 'codex', model: 'gpt-5.6-sol' }, undefined, undefined, ctx)
    expect(spawnCalls[0].command).toBe('codex')
    expect(spawnCalls[0].args).toEqual(expect.arrayContaining(['-m', 'gpt-5.6-sol']))
    await execute('2', { tasks: [{ agent: 'scout', task: 'a', harness: 'claude', model: 'haiku' }] }, undefined, undefined, ctx)
    expect(spawnCalls[1].command).toBe('claude')
    expect(spawnCalls[1].args).toEqual(expect.arrayContaining(['--model', 'haiku']))
    await execute('3', { chain: [{ agent: 'scout', task: 'a', effort: 'low' }] }, undefined, undefined, ctx)
    expect(spawnCalls[2].args).toEqual(expect.arrayContaining(['--thinking', 'low']))
  })
})

describe('frontmatter', () => {
  it('reads harness, terminal and permissionMode, rejecting unknown values', async () => {
    const real = await vi.importActual<typeof import('../extensions/subagent/agents.ts')>('../extensions/subagent/agents.ts')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agents-'))
    const dir = `${root}/.pi/agents`
    fs.mkdirSync(dir, { recursive: true })
    const write = (name: string, frontmatter: string) => fs.writeFileSync(`${dir}/${name}.md`, `---\nname: ${name}\ndescription: d\n${frontmatter}\n---\nbody\n`)
    write('on-codex', 'harness: Codex\npermissionMode: plan')
    write('in-herdr', 'terminal: HERDR')
    write('bad-harness', 'harness: gemini')
    write('bad-terminal', 'terminal: tmux')
    write('bypass', 'permissionMode: bypassPermissions')
    write('dontask', 'permissionMode: dontAsk')
    write('blank-mode', 'permissionMode: "  "')
    write('plain', 'model: sonnet')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const byName = new Map(real.discoverAgents(root, 'project').agents.map((a) => [a.name, a]))
      expect(byName.get('on-codex')).toMatchObject({ harness: 'codex', permissionMode: 'plan' })
      expect(byName.get('in-herdr')).toMatchObject({ terminal: 'herdr' })
      expect(byName.get('plain')?.harness).toBeUndefined()
      expect(byName.get('plain')?.terminal).toBeUndefined()
      expect(byName.has('bad-harness')).toBe(false)
      expect(byName.has('bad-terminal')).toBe(false)
      // Claude's permission-disabling modes never reach a child; an empty mode is absent.
      expect(byName.has('bypass')).toBe(false)
      expect(byName.has('dontask')).toBe(false)
      expect(byName.get('blank-mode')?.permissionMode).toBeUndefined()
      expect(warn.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining([expect.stringContaining('harness value "gemini"'), expect.stringContaining('terminal value "tmux"'), expect.stringContaining('permissionMode value "bypassPermissions"'), expect.stringContaining('permissionMode value "dontAsk"')]))
    } finally {
      warn.mockRestore()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
