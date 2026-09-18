import { describe, expect, it } from 'vitest'
import type { AgentConfig } from '../extensions/subagent/agents.ts'
import { ARGV_MAX_BYTES, setKnownMcpAliases } from '../extensions/subagent/child.ts'
import { applyLaunchOverrides, CLAUDE_DEFAULT_PERMISSION_MODE, claudeModelFor, claudeToolList, codexInstructions, codexSandboxFor, type HarnessLaunch, harnessKindOf, invalidHarnessError, invalidToolNames, launchModelFor, runnerFor, tomlString } from '../extensions/subagent/harness.ts'

const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({ name: 'worker', description: 'd', systemPrompt: '', source: 'user', filePath: '/tmp/worker.md', ...overrides })

const launch = (overrides: Partial<Omit<HarnessLaunch, 'agent'>> & { agent?: Partial<AgentConfig> } = {}): HarnessLaunch => {
  const { agent: agentOverrides, ...rest } = overrides
  return { agent: agent(agentOverrides), task: 'Task: do it', ...rest }
}

/** Events captured live from `claude -p --output-format stream-json --verbose`
 * (2026-09-17): one assistant event per content block, all sharing the message id
 * and cumulative usage; tool results come back as `user` events. */
const CLAUDE_TOOL_RUN = [
  JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5-20251001' }),
  JSON.stringify({ type: 'assistant', message: { id: 'msg_1', model: 'claude-haiku-4-5-20251001', role: 'assistant', stop_reason: null, content: [{ type: 'thinking', thinking: '', signature: 'x' }], usage: { input_tokens: 10, cache_creation_input_tokens: 27203, cache_read_input_tokens: 13875, output_tokens: 3 } } }),
  JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_1', model: 'claude-haiku-4-5-20251001', role: 'assistant', stop_reason: null, content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo probe-ok' } }], usage: { input_tokens: 10, cache_creation_input_tokens: 27203, cache_read_input_tokens: 13875, output_tokens: 60 } },
  }),
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'probe-ok', is_error: false }] } }),
  JSON.stringify({ type: 'assistant', message: { id: 'msg_2', model: 'claude-haiku-4-5-20251001', role: 'assistant', stop_reason: null, content: [{ type: 'text', text: 'probe-ok' }], usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 41000, output_tokens: 4 } } }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'probe-ok', num_turns: 2, total_cost_usd: 0.0366, stop_reason: 'end_turn' }),
]

/** Events captured live from `codex exec --json` (codex-cli 0.142, 2026-09-17). */
const CODEX_TOOL_RUN = [
  JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: "/bin/zsh -lc 'echo probe-ok'", aggregated_output: '', exit_code: null, status: 'in_progress' } }),
  JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'command_execution', command: "/bin/zsh -lc 'echo probe-ok'", aggregated_output: 'probe-ok\n', exit_code: 0, status: 'completed' } }),
  JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'probe-ok' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 48130, cached_input_tokens: 33536, output_tokens: 37, reasoning_output_tokens: 0 } }),
]

function drain(kind: 'pi' | 'claude' | 'codex', lines: string[], model?: string) {
  const runner = runnerFor({ harness: kind })
  const parser = runner.createParser(launch({ model }))
  const events = lines.flatMap((line) => parser.feed(line))
  events.push(...parser.flush())
  return events
}

describe('harness selection', () => {
  it('defaults to pi and honors the frontmatter harness', () => {
    expect(harnessKindOf(agent())).toBe('pi')
    expect(runnerFor(agent()).kind).toBe('pi')
    expect(runnerFor(agent({ harness: 'claude' })).kind).toBe('claude')
    expect(runnerFor(agent({ harness: 'codex' })).kind).toBe('codex')
  })

  it('applies per-call overrides, a model override dropping the file alias', () => {
    const base = agent({ modelAlias: 'sonnet', effort: 'low' })
    expect(applyLaunchOverrides(base, undefined)).toBe(base)
    const staffed = applyLaunchOverrides(base, { harness: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
    expect(staffed).toMatchObject({ harness: 'codex', model: 'gpt-5.6-sol', effort: 'high' })
    expect(staffed.modelAlias).toBeUndefined()
    // An empty override object changes nothing.
    expect(applyLaunchOverrides(base, {})).toEqual(base)
  })

  it('names the harnesses in the unknown-harness error', () => {
    expect(invalidHarnessError('gemini')).toContain('pi, claude, codex')
  })

  it('resolves the launch model per harness', () => {
    const available = [{ id: 'claude-sonnet-5' }]
    expect(launchModelFor(agent({ modelAlias: 'sonnet' }), available)).toBe('claude-sonnet-5')
    expect(launchModelFor(agent({ harness: 'claude', modelAlias: 'haiku' }), available)).toBe('haiku')
    expect(launchModelFor(agent({ harness: 'claude', model: 'claude-opus-5', modelAlias: 'haiku' }), available)).toBe('claude-opus-5')
    expect(launchModelFor(agent({ harness: 'codex', modelAlias: 'haiku' }), available)).toBeUndefined()
    expect(launchModelFor(agent({ harness: 'codex', model: 'gpt-5.6-sol' }), available)).toBe('gpt-5.6-sol')
    expect(claudeModelFor({ model: undefined, modelAlias: undefined }, 'resolved')).toBe('resolved')
  })
})

describe('pi runner', () => {
  it('launches print mode with the task as the last argument and the prompt by path', () => {
    const inv = runnerFor(agent()).headless(launch({ systemPromptPath: '/tmp/p.md', model: 'm1', agent: { effort: 'high' } }))
    expect(inv.stdin).toBeUndefined()
    expect(inv.args.slice(-3)).toEqual(['--system-prompt', '/tmp/p.md', 'Task: do it'])
    expect(inv.args).toContain('--mode')
    expect(inv.args).toContain('-p')
    expect(inv.args.at(-1)).toBe('Task: do it')
    expect(inv.args).toContain('m1:high')
  })

  it('drops print-mode flags from the interactive launch', () => {
    const args = runnerFor(agent()).interactive(launch({ systemPromptPath: '/tmp/p.md', agent: { tools: ['read'] } }))
    expect(args).not.toContain('--mode')
    expect(args).not.toContain('json')
    expect(args).not.toContain('-p')
    expect(args).not.toContain('--no-session')
    expect(args).toEqual(expect.arrayContaining(['--tools', 'read', '--system-prompt', '/tmp/p.md']))
  })

  it('parses message_end and tool_result_end only', () => {
    const events = drain('pi', [JSON.stringify({ type: 'message_start' }), JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }), JSON.stringify({ type: 'tool_result_end', message: { role: 'toolResult' } }), 'not json', ''])
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'message', message: { role: 'assistant' } })
    expect(events[1]).toMatchObject({ type: 'message', message: { role: 'toolResult' } })
  })
})

describe('claude runner', () => {
  it('builds a print-mode launch with the task on stdin', () => {
    const inv = runnerFor(agent({ harness: 'claude' })).headless(launch({ model: 'haiku', effort: 'low', systemPromptPath: '/tmp/p.md', agent: { harness: 'claude', tools: ['read', 'bash'], disallowedTools: ['web_fetch'], maxTurns: 3 } }))
    expect(inv.command).toBe('claude')
    expect(inv.stdin).toBe('Task: do it')
    expect(inv.args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose'])
    // --tools prunes the toolset (--allowedTools would only pre-approve prompts), and
    // each list is one `--flag=a,b` token so no entry can become a flag of its own.
    expect(inv.args).toEqual(expect.arrayContaining(['--model', 'haiku', '--effort', 'low', '--system-prompt-file', '/tmp/p.md', '--tools=Read,Bash', '--disallowedTools=WebFetch', '--permission-mode', CLAUDE_DEFAULT_PERMISSION_MODE, '--max-turns', '3']))
    expect(inv.args).not.toContain('--allowedTools')
    // The task never rides argv: a variadic option would swallow it.
    expect(inv.args).not.toContain('Task: do it')
  })

  it('passes the file permissionMode through, and defaults both launches to auto mode', () => {
    const inv = runnerFor(agent({ harness: 'claude' })).headless(launch({ agent: { harness: 'claude', permissionMode: 'plan' } }))
    expect(inv.args).toEqual(['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan'])
    // A tab child stopping at every prompt never reaches the work, so auto applies there too.
    expect(CLAUDE_DEFAULT_PERMISSION_MODE).toBe('auto')
    expect(runnerFor(agent({ harness: 'claude' })).interactive(launch({ model: 'opus' }))).toEqual(['--model', 'opus', '--permission-mode', 'auto'])
    expect(runnerFor(agent({ harness: 'claude' })).interactive(launch({ agent: { harness: 'claude', permissionMode: 'plan' } }))).toEqual(['--permission-mode', 'plan'])
  })

  it('refuses a grant entry that would spell as a command-line flag', () => {
    const runner = runnerFor(agent({ harness: 'claude' }))
    expect(runner.validate?.(launch({ agent: { harness: 'claude', tools: ['read', '--dangerously-skip-permissions'] } }))).toContain('"--dangerously-skip-permissions"')
    expect(runner.validate?.(launch({ agent: { harness: 'claude', disallowedTools: ['-x'] } }))).toContain('"-x"')
    expect(runner.validate?.(launch({ agent: { harness: 'claude', tools: ['read', 'mcp__gh__list_prs', 'Bash(git log:*)', 'web.fetch'] } }))).toBeUndefined()
    expect(invalidToolNames(['ok', '', ' read', 'a b'])).toEqual(['', ' read', 'a b'])
    expect(invalidToolNames(undefined)).toEqual([])
  })

  it('translates MCP tool names through the parent roster', () => {
    setKnownMcpAliases([{ pi: 'gh_list_prs', claude: 'mcp__gh__list_prs' }])
    try {
      expect(claudeToolList(['read', 'gh_list_prs', 'mcp__other', 'unknown_tool'])).toEqual(['Read', 'mcp__gh__list_prs', 'mcp__other', 'unknown_tool'])
    } finally {
      setKnownMcpAliases([])
    }
  })

  it('coalesces streamed content blocks into whole assistant messages and maps tool results', () => {
    const events = drain('claude', CLAUDE_TOOL_RUN)
    const messages = events.filter((e) => e.type === 'message').map((e) => (e.type === 'message' ? e.message : null))
    expect(messages.map((m) => m?.role)).toEqual(['assistant', 'toolResult', 'assistant'])
    const first = messages[0]
    if (first?.role !== 'assistant') throw new Error('expected assistant')
    expect(first.content.map((part) => part.type)).toEqual(['thinking', 'toolCall'])
    expect(first.content[1]).toMatchObject({ type: 'toolCall', id: 'toolu_1', name: 'Bash', arguments: { command: 'echo probe-ok' } })
    expect(first.stopReason).toBe('toolUse')
    expect(first.model).toBe('claude-haiku-4-5-20251001')
    // Usage is the message's cumulative figure, taken once, not summed per block.
    expect(first.usage).toMatchObject({ input: 10, output: 60, cacheRead: 13875, cacheWrite: 27203 })
    expect(messages[1]).toMatchObject({ role: 'toolResult', toolCallId: 'toolu_1', toolName: 'Bash', content: [{ type: 'text', text: 'probe-ok' }], isError: false })
    const last = messages[2]
    if (last?.role !== 'assistant') throw new Error('expected assistant')
    expect(last.content).toEqual([{ type: 'text', text: 'probe-ok' }])
    expect(last.stopReason).toBe('stop')
    const summary = events.find((e) => e.type === 'summary')
    expect(summary).toMatchObject({ type: 'summary', cost: 0.0366, stopReason: 'stop' })
    expect(summary && 'errorMessage' in summary ? summary.errorMessage : undefined).toBeUndefined()
  })

  it('reads list-shaped tool results, error results and a run that failed', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'x', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'image' }], is_error: true },
            { type: 'text', text: 'ignored' },
          ],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], stop_reason: 'max_tokens' }),
    ]
    const events = drain('claude', lines)
    expect(events[1]).toMatchObject({ type: 'message', message: { role: 'toolResult', isError: true, content: [{ type: 'text', text: 'a\nb' }] } })
    expect(events.at(-1)).toMatchObject({ type: 'summary', stopReason: 'error', errorMessage: 'boom' })
  })

  it('treats error_max_turns as a partial run, not a failure, and flushes a trailing message', () => {
    const lines = [JSON.stringify({ type: 'assistant', message: { id: 'm', model: 'x', content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' } }), JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'capped', stop_reason: 'end_turn' })]
    const events = drain('claude', lines)
    expect(events[0]).toMatchObject({ type: 'message', message: { role: 'assistant', stopReason: 'length' } })
    expect(events[1]).toMatchObject({ type: 'summary', partial: true, stopReason: 'stop' })
    // A stream cut before its result still releases the buffered message.
    const cut = drain('claude', [lines[0]])
    expect(cut).toHaveLength(1)
    // Unknown result text falls back to naming the subtype; unknown tool ids get a placeholder name.
    const fallback = drain('claude', [JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'zz', content: 7 }] } }), JSON.stringify({ type: 'result', subtype: 'error_weird' }), JSON.stringify({ type: 'system' }), 'garbage'])
    expect(fallback[0]).toMatchObject({ type: 'message', message: { toolName: 'tool', content: [{ type: 'text', text: '' }] } })
    expect(fallback[1]).toMatchObject({ type: 'summary', errorMessage: 'claude exited with error_weird' })
  })

  it('releases a buffered assistant message when the next block carries a new message id', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'x', content: [{ type: 'text', text: 'first' }] } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'x', content: [{ type: 'text', text: ' and more' }] } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm2', model: 'x', content: [{ type: 'text', text: 'second' }] } }),
    ]
    const events = drain('claude', lines)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'message',
      message: {
        role: 'assistant',
        responseId: 'm1',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: ' and more' },
        ],
      },
    })
    expect(events[1]).toMatchObject({ type: 'message', message: { role: 'assistant', responseId: 'm2', content: [{ type: 'text', text: 'second' }] } })
  })

  it('leaves maxTurns to the CLI', () => {
    expect(runnerFor(agent({ harness: 'claude' })).maxTurns).toBe('cli')
    expect(runnerFor(agent({ harness: 'codex' })).maxTurns).toBe('unsupported')
    expect(runnerFor(agent()).maxTurns).toBe('parent')
  })
})

describe('codex runner', () => {
  it('builds an exec launch with model, effort and developer instructions as TOML', () => {
    const inv = runnerFor(agent({ harness: 'codex' })).headless(launch({ model: 'gpt-5.6-sol', effort: 'high', systemPromptBody: 'Be terse.\nSay "ok".', agent: { harness: 'codex' } }))
    expect(inv.command).toBe('codex')
    expect(inv.stdin).toBe('Task: do it')
    expect(inv.args).toEqual(['exec', '--json', '-s', 'workspace-write', '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="high"', '-c', 'developer_instructions="Be terse.\\nSay \\"ok\\"."', '-'])
    // The interactive launch carries the same sandbox, so a plan agent stays read-only in a tab.
    expect(runnerFor(agent({ harness: 'codex' })).interactive(launch({ model: 'gpt-5.6-sol' }))).toEqual(['-s', 'workspace-write', '-m', 'gpt-5.6-sol'])
    expect(runnerFor(agent({ harness: 'codex' })).interactive(launch({ agent: { harness: 'codex', permissionMode: 'plan' } }))).toEqual(['-s', 'read-only'])
  })

  it('reads plan and read-only agents as read-only sandboxes and refuses what codex cannot honor', () => {
    expect(codexSandboxFor({ permissionMode: 'plan' })).toBe('read-only')
    expect(codexSandboxFor({})).toBe('workspace-write')
    expect(codexSandboxFor({ tools: ['read', 'grep', 'find', 'ls'] })).toBe('read-only')
    expect(codexSandboxFor({ tools: ['read', 'Edit'] })).toBe('workspace-write')
    const runner = runnerFor(agent({ harness: 'codex' }))
    expect(runner.validate?.(launch({ effort: 'minimal' }))).toContain('minimal')
    expect(runner.validate?.(launch({ effort: 'high' }))).toBeUndefined()
    expect(runner.validate?.(launch())).toBeUndefined()
    expect(runner.validate?.(launch({ agent: { harness: 'codex', maxTurns: 2 } }))).toContain('maxTurns cannot be enforced on codex')
    expect(runner.validate?.(launch({ agent: { harness: 'codex', tools: ['--oss'] } }))).toContain('"--oss"')
    expect(tomlString('a\tb')).toBe('"a\\tb"')
  })

  it('caps the inline system prompt at the argv budget with a visible notice', () => {
    expect(codexInstructions('short')).toBe('short')
    const long = 'x'.repeat(ARGV_MAX_BYTES + 10)
    const capped = codexInstructions(long)
    expect(capped.endsWith('[truncated: too long for the child process to receive]')).toBe(true)
    expect(Buffer.byteLength(capped, 'utf-8')).toBeLessThan(ARGV_MAX_BYTES + 100)
    const instructions = runnerFor(agent({ harness: 'codex' }))
      .headless(launch({ systemPromptBody: long }))
      .args.find((arg) => arg.startsWith('developer_instructions='))
    expect(Buffer.byteLength(instructions ?? '', 'utf-8')).toBeLessThan(ARGV_MAX_BYTES + 200)
  })

  it('maps completed items to tool calls, results and text, and the turn usage to a summary', () => {
    const events = drain('codex', CODEX_TOOL_RUN, 'gpt-5.6-sol')
    const messages = events.filter((e) => e.type === 'message').map((e) => (e.type === 'message' ? e.message : null))
    expect(messages.map((m) => m?.role)).toEqual(['assistant', 'toolResult', 'assistant'])
    expect(messages[0]).toMatchObject({ role: 'assistant', model: 'gpt-5.6-sol', content: [{ type: 'toolCall', id: 'item_0', name: 'bash', arguments: { command: "/bin/zsh -lc 'echo probe-ok'" } }] })
    expect(messages[1]).toMatchObject({ role: 'toolResult', toolCallId: 'item_0', toolName: 'bash', content: [{ type: 'text', text: 'probe-ok\n' }], isError: false })
    expect(messages[2]).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'probe-ok' }] })
    expect(events.at(-1)).toMatchObject({ type: 'summary', model: 'gpt-5.6-sol', stopReason: 'stop', usage: { input: 48130 - 33536, cacheRead: 33536, output: 37, cacheWrite: 0 } })
  })

  it('covers the other item kinds and the failure shapes', () => {
    const lines = [
      JSON.stringify({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'hmm' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'f', type: 'file_change', changes: [{ path: 'a.ts' }], status: 'failed' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm', type: 'mcp_tool_call', server: 'gh', tool: 'list', arguments: { q: 1 }, result: { ok: true } } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm2', type: 'mcp_tool_call', error: 'denied', arguments: 'not-an-object' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'w', type: 'web_search', query: 'pi' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'x', type: 'todo_list' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'e', type: 'error', message: 'model missing' } }),
      JSON.stringify({ type: 'error', message: 'transport' }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'bad request' } }),
      'nope',
    ]
    const events = drain('codex', lines)
    const messages = events.filter((e) => e.type === 'message').map((e) => (e.type === 'message' ? e.message : null))
    expect(messages[0]).toMatchObject({ role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] })
    expect(messages[1]).toMatchObject({ role: 'assistant', content: [{ type: 'toolCall', name: 'edit', arguments: { changes: [{ path: 'a.ts' }] } }] })
    expect(messages[2]).toMatchObject({ role: 'toolResult', toolName: 'edit', isError: true, content: [{ type: 'text', text: 'failed' }] })
    expect(messages[3]).toMatchObject({ role: 'assistant', content: [{ type: 'toolCall', name: 'gh_list', arguments: { q: 1 } }] })
    expect(messages[4]).toMatchObject({ role: 'toolResult', toolName: 'gh_list', content: [{ type: 'text', text: '{"ok":true}' }], isError: false })
    expect(messages[5]).toMatchObject({ role: 'assistant', content: [{ type: 'toolCall', name: 'mcp', arguments: {} }] })
    expect(messages[6]).toMatchObject({ role: 'toolResult', isError: true, content: [{ type: 'text', text: 'denied' }] })
    expect(messages[7]).toMatchObject({ role: 'assistant', content: [{ type: 'toolCall', name: 'web_search', arguments: { query: 'pi' } }] })
    expect(messages[8]).toMatchObject({ role: 'toolResult', toolName: 'web_search' })
    expect(messages).toHaveLength(9)
    expect(events.at(-1)).toMatchObject({ type: 'summary', stopReason: 'error', errorMessage: 'bad request' })
    // An error item alone marks the turn failed once usage arrives.
    const erred = drain('codex', [JSON.stringify({ type: 'item.completed', item: { type: 'error', message: 'model missing' } }), JSON.stringify({ type: 'turn.completed', usage: {} })])
    expect(erred.at(-1)).toMatchObject({ type: 'summary', stopReason: 'error', errorMessage: 'model missing', usage: { input: 0, output: 0, cacheRead: 0 } })
    const bare = drain('codex', [JSON.stringify({ type: 'item.completed', item: { type: 'error' } }), JSON.stringify({ type: 'turn.failed' })])
    expect(bare.at(-1)).toMatchObject({ type: 'summary', errorMessage: 'codex turn failed' })
    expect(drain('codex', [JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } })])[1]).toMatchObject({ type: 'message', message: { isError: false, content: [{ type: 'text', text: '' }] } })
  })
})
