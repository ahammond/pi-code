import * as fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig } from '../extensions/subagent/agents.ts'
import { type HarnessLaunch, runnerFor } from '../extensions/subagent/harness.ts'
import { cancelInHerdr, execHerdr, type HerdrCliResult, herdrAgentName, herdrContext, herdrOutcomeText, herdrPromptText, herdrRun, herdrRuns, resetHerdrRuns, resumeInHerdr, runInHerdr } from '../extensions/subagent/herdr.ts'

const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({ name: 'Code Reviewer', description: 'd', systemPrompt: 'Review things.', source: 'user', filePath: '/tmp/r.md', ...overrides })
const launch = (overrides: Partial<HarnessLaunch> = {}): HarnessLaunch => ({ agent: agent(), task: 'Task: review', systemPromptBody: 'Review things.', ...overrides })

const ENV = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w1' }

const ok = (result: Record<string, unknown>): HerdrCliResult => ({ ok: true, result, stdout: JSON.stringify({ result }) })
const fail = (code: string, message = code): HerdrCliResult => ({ ok: false, code, message, stdout: '' })
const text = (stdout: string): HerdrCliResult => ({ ok: true, stdout })

const TAB_CREATED = ok({ type: 'tab_created', tab: { tab_id: 'w1:t9' }, root_pane: { pane_id: 'w1:p9' } })
const STARTED = ok({ type: 'agent_started', agent: { agent_status: 'idle' } })
const prompted = (status: string) => ok({ type: 'agent_prompted', agent: { agent_status: status } })

/** A scripted herdr: each call is matched by its leading words and answered from the
 * script; the full argv log is what the assertions read. */
function scriptedHerdr(answers: Record<string, HerdrCliResult | ((args: string[]) => HerdrCliResult)>) {
  const calls: string[][] = []
  const exec = async (args: string[]): Promise<HerdrCliResult> => {
    calls.push(args)
    const key = args.slice(0, 2).join(' ')
    const answer = answers[key]
    if (!answer) throw new Error(`unscripted herdr call: ${key}`)
    return typeof answer === 'function' ? answer(args) : answer
  }
  return { exec, calls }
}

afterEach(() => {
  for (const run of herdrRuns()) fs.rmSync(run.dir, { recursive: true, force: true })
  resetHerdrRuns()
})

describe('herdr preconditions and naming', () => {
  it('refuses outside Herdr and without a workspace', () => {
    expect(herdrContext({})).toMatchObject({ error: expect.stringContaining('HERDR_ENV=1') })
    expect(herdrContext({ HERDR_ENV: '1' })).toMatchObject({ error: expect.stringContaining('HERDR_WORKSPACE_ID') })
    expect(herdrContext(ENV)).toEqual({ workspaceId: 'w1' })
  })

  it("folds agent names into Herdr's alphabet with a unique suffix", () => {
    expect(herdrAgentName('Code Reviewer', 'ab12')).toBe('code-reviewer-ab12')
    expect(herdrAgentName('123 Weird!!', 'ab12')).toBe('weird-ab12')
    expect(herdrAgentName('!!!', 'ab12')).toBe('agent-ab12')
    const long = herdrAgentName('a'.repeat(50), 'ab12')
    expect(long).toHaveLength(32)
    expect(long).toMatch(/^[a-z][a-z0-9_-]{0,31}$/)
    expect(herdrAgentName('x')).toMatch(/^x-[0-9a-f]{4}$/)
  })

  it('points the child at the brief and the report file', () => {
    expect(herdrPromptText('/b.md', '/r.md')).toContain('Read /b.md')
    expect(herdrPromptText('/b.md', '/r.md')).toContain('to /r.md')
  })
})

describe('runInHerdr', () => {
  it('creates a tab, starts the harness with its interactive flags, prompts, reads the report and closes the tab', async () => {
    const { exec, calls } = scriptedHerdr({
      'tab create': TAB_CREATED,
      'agent start': STARTED,
      'agent prompt': (args) => {
        // The child writes its report where the prompt told it to.
        const reportPath = /to (\S+) and reply/.exec(args[3])?.[1]
        if (!reportPath) throw new Error('no report path in prompt')
        fs.writeFileSync(reportPath, '# Report\nall good\n')
        return prompted('done')
      },
      'tab close': ok({ type: 'ok' }),
    })
    const outcome = await runInHerdr({ agent: agent({ harness: 'claude' }), runner: runnerFor({ harness: 'claude' }), launch: launch({ model: 'haiku' }), cwd: '/work', timeoutMs: 1000, exec, env: ENV })
    if ('error' in outcome) throw new Error(outcome.error)
    expect(outcome.state).toBe('done')
    expect(outcome.report).toBe('# Report\nall good\n')
    expect(herdrOutcomeText(outcome)).toBe('# Report\nall good\n')
    expect(herdrRuns()).toEqual([])
    expect(fs.existsSync(outcome.run.dir)).toBe(false)

    const [create, start, prompt, close] = calls
    expect(create).toEqual(['tab', 'create', '--workspace', 'w1', '--cwd', '/work', '--label', outcome.run.name, '--env', 'PI_CODE_SUBAGENT=1', '--no-focus'])
    expect(start.slice(0, 8)).toEqual(['agent', 'start', outcome.run.name, '--kind', 'claude', '--pane', 'w1:p9', '--timeout'])
    const dash = start.indexOf('--')
    expect(start.slice(dash + 1)).toEqual(['--model', 'haiku', '--system-prompt-file', expect.stringMatching(/system-prompt\.md$/), '--permission-mode', 'acceptEdits'])
    expect(prompt.slice(0, 3)).toEqual(['agent', 'prompt', outcome.run.name])
    expect(prompt.slice(4)).toEqual(['--wait', '--timeout', '1000'])
    expect(close).toEqual(['tab', 'close', 'w1:t9'])
  })

  it('falls back to the pane text when the child wrote no report, and skips the prompt file when there is no system prompt', async () => {
    const { exec, calls } = scriptedHerdr({ 'tab create': TAB_CREATED, 'agent start': STARTED, 'agent prompt': prompted('idle'), 'agent read': text('pane says hi\n'), 'tab close': ok({ type: 'ok' }) })
    const outcome = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch({ systemPromptBody: undefined }), cwd: '/work', timeoutMs: 1000, exec, env: ENV })
    if ('error' in outcome) throw new Error(outcome.error)
    expect(outcome).toMatchObject({ state: 'done', report: 'pane says hi' })
    const start = calls[1]
    expect(start.slice(start.indexOf('--') + 1)).not.toContain('--system-prompt')
    expect(calls[3]).toEqual(['agent', 'read', outcome.run.name, '--source', 'recent-unwrapped', '--lines', '200'])
  })

  it('keeps the tab and registers the run when the child ends blocked, stalled or timed out', async () => {
    for (const [answer, state] of [
      [prompted('blocked'), 'blocked'],
      [fail('agent_blocked', 'already blocked'), 'blocked'],
      [fail('agent_prompt_stalled'), 'stalled'],
      [fail('timeout', 'timed out waiting for agent status'), 'timeout'],
      [fail('something_else'), 'failed'],
      [prompted('unknown'), 'failed'],
    ] as const) {
      resetHerdrRuns()
      const { exec, calls } = scriptedHerdr({ 'tab create': TAB_CREATED, 'agent start': STARTED, 'agent prompt': answer, 'agent read': text('waiting for approval') })
      const outcome = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec, env: ENV })
      if ('error' in outcome) throw new Error(outcome.error)
      expect(outcome.state).toBe(state)
      expect(outcome.report).toBe('waiting for approval')
      expect(calls.some((c) => c[0] === 'tab' && c[1] === 'close')).toBe(false)
      expect(herdrRun(outcome.run.name)).toMatchObject({ state, tabOpen: true, tabId: 'w1:t9' })
      const explained = herdrOutcomeText(outcome)
      expect(explained).toContain(`Terminal subagent ${state}`)
      expect(explained).toContain('w1:t9')
      expect(explained).toContain(`{resume: "${outcome.run.name}"`)
      if (state === 'blocked') expect(explained).toContain('human must answer')
      else expect(explained).toContain(`{cancel: "${outcome.run.name}"}`)
      fs.rmSync(outcome.run.dir, { recursive: true, force: true })
    }
  })

  it('reports a failed tab create and a failed agent start, closing the tab it opened', async () => {
    const noTab = scriptedHerdr({ 'tab create': fail('workspace_not_found', 'no such workspace') })
    expect(await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec: noTab.exec, env: ENV })).toEqual({ error: 'herdr tab create failed: no such workspace' })
    const oddTab = scriptedHerdr({ 'tab create': ok({ type: 'tab_created' }) })
    expect(await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec: oddTab.exec, env: ENV })).toEqual({ error: 'herdr tab create failed: no tab in the response' })

    const noStart = scriptedHerdr({ 'tab create': TAB_CREATED, 'agent start': fail('agent_start_failed', 'codex not on PATH'), 'tab close': ok({ type: 'ok' }) })
    expect(await runInHerdr({ agent: agent({ harness: 'codex' }), runner: runnerFor({ harness: 'codex' }), launch: launch(), cwd: '/work', timeoutMs: 5, exec: noStart.exec, env: ENV })).toEqual({ error: 'herdr agent start (codex) failed: codex not on PATH' })
    expect(noStart.calls.at(-1)).toEqual(['tab', 'close', 'w1:t9'])
    expect(herdrRuns()).toEqual([])

    // A start that blocks (a trust prompt) hands the pane to the human.
    const blockedStart = scriptedHerdr({ 'tab create': TAB_CREATED, 'agent start': fail('agent_not_ready', 'blocked during startup'), 'agent read': text('Trust this folder?') })
    const outcome = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec: blockedStart.exec, env: ENV })
    expect(outcome).toMatchObject({ state: 'blocked', report: 'Trust this folder?', reason: 'blocked during startup' })
  })

  it('refuses outside Herdr before touching anything', async () => {
    const { exec, calls } = scriptedHerdr({})
    expect(await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec, env: {} })).toMatchObject({ error: expect.stringContaining('HERDR_ENV') })
    expect(calls).toEqual([])
  })

  it('cancels on abort: interrupts the child and closes the tab', async () => {
    const controller = new AbortController()
    const { exec, calls } = scriptedHerdr({
      'tab create': TAB_CREATED,
      'agent start': STARTED,
      'agent prompt': () => {
        controller.abort()
        return fail('timeout')
      },
      'agent send-keys': ok({ type: 'ok' }),
      'tab close': ok({ type: 'ok' }),
    })
    const outcome = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec, env: ENV, signal: controller.signal })
    expect(outcome).toMatchObject({ state: 'aborted', reason: 'Subagent was aborted' })
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual(['tab create', 'agent start', 'agent prompt', 'agent send-keys', 'tab close'])
    expect(herdrRuns()).toEqual([])

    // An already-aborted signal cancels before the prompt is even sent.
    const pre = new AbortController()
    pre.abort()
    const early = scriptedHerdr({ 'tab create': TAB_CREATED, 'agent start': STARTED, 'agent prompt': fail('timeout'), 'agent send-keys': ok({}), 'tab close': ok({}) })
    expect(await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec: early.exec, env: ENV, signal: pre.signal })).toMatchObject({ state: 'aborted' })
  })
})

describe('resume and cancel', () => {
  it('resumes a kept run with a new brief and closes it once done', async () => {
    const { exec, calls } = scriptedHerdr({
      'tab create': TAB_CREATED,
      'agent start': STARTED,
      'agent prompt': (args) => {
        const reportPath = /to (\S+) and reply/.exec(args[3])?.[1]
        if (args[3].includes('brief-')) {
          if (reportPath) fs.writeFileSync(reportPath, 'second answer')
          return prompted('done')
        }
        return prompted('blocked')
      },
      'agent read': text('blocked here'),
      'tab close': ok({ type: 'ok' }),
    })
    const first = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec, env: ENV })
    if ('error' in first) throw new Error(first.error)
    expect(first.state).toBe('blocked')
    const second = await resumeInHerdr(first.run.name, 'now finish', 7, exec)
    expect(second).toMatchObject({ state: 'done', report: 'second answer' })
    expect(calls.at(-1)).toEqual(['tab', 'close', 'w1:t9'])
    expect(herdrRun(first.run.name)).toBeUndefined()
    expect(await resumeInHerdr(first.run.name, 'again', 7, exec)).toEqual({ error: `Unknown terminal run: ${first.run.name}.` })
  })

  it('cancel closes the tab of a kept run and reports unknown names', async () => {
    const { exec, calls } = scriptedHerdr({ 'tab create': TAB_CREATED, 'agent start': STARTED, 'agent prompt': fail('timeout'), 'agent read': text(''), 'agent send-keys': ok({}), 'tab close': ok({}) })
    const outcome = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec, env: ENV })
    if ('error' in outcome) throw new Error(outcome.error)
    expect(outcome.report).toBe('')
    expect(herdrOutcomeText(outcome)).toContain('(nothing readable)')
    expect(await cancelInHerdr(outcome.run.name, exec)).toBe('cancelled')
    expect(calls.slice(-2).map((c) => c.slice(0, 2).join(' '))).toEqual(['agent send-keys', 'tab close'])
    expect(herdrRuns()).toEqual([])
    expect(await cancelInHerdr('nobody', exec)).toBe('unknown')
  })
})

describe('execHerdr', () => {
  it('parses JSON stdout, JSON error stderr, and plain failures', async () => {
    const execFileMock = vi.fn()
    vi.doMock('node:child_process', async (importOriginal) => ({ ...(await importOriginal<object>()), execFile: execFileMock }))
    vi.resetModules()
    const { execHerdr: fresh } = await import('../extensions/subagent/herdr.ts')
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => cb(null, '{"id":"x","result":{"type":"ok"}}', ''))
    expect(await fresh(['tab', 'close', 'w1:t1'])).toMatchObject({ ok: true, result: { type: 'ok' } })
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => cb(null, 'plain pane text', ''))
    expect(await fresh(['agent', 'read', 'a'])).toMatchObject({ ok: true, result: undefined, stdout: 'plain pane text' })
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => cb(Object.assign(new Error('exit 1'), { code: 1 }), '', '{"error":{"code":"timeout","message":"timed out"},"id":"cli:agent:prompt"}'))
    expect(await fresh(['agent', 'prompt', 'a', 'x'])).toMatchObject({ ok: false, code: 'timeout', message: 'timed out' })
    execFileMock.mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => cb(Object.assign(new Error('spawn herdr ENOENT'), { code: 'ENOENT' }), '', ''))
    expect(await fresh(['agent', 'list'])).toMatchObject({ ok: false, code: 'ENOENT' })
    vi.doUnmock('node:child_process')
    expect(typeof execHerdr).toBe('function')
  })
})
