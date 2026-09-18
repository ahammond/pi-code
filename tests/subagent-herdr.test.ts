import * as fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig } from '../extensions/subagent/agents.ts'
import { type HarnessLaunch, runnerFor } from '../extensions/subagent/harness.ts'
import { cancelInHerdr, execHerdr, type HerdrCliResult, herdrAgentName, herdrContext, herdrOutcomeText, herdrPromptText, herdrRun, herdrRuns, MAX_TERMINAL_RUNS, resetHerdrRuns, resumeInHerdr, runInHerdr } from '../extensions/subagent/herdr.ts'
import * as worktreeModule from '../extensions/subagent/worktree.ts'

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
    expect(start.slice(dash + 1)).toEqual(['--model', 'haiku', '--system-prompt-file', expect.stringMatching(/system-prompt\.md$/), '--permission-mode', 'auto'])
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

  it("retries agent start while the new tab's shell is still coming up, and gives up after the bound", async () => {
    let starts = 0
    const sleeps: number[] = []
    const sleep = async (ms: number) => {
      sleeps.push(ms)
    }
    const slowShell = scriptedHerdr({
      'tab create': TAB_CREATED,
      'agent start': () => (++starts < 4 ? fail('invalid_target', 'agent target pane w1:p9 is not an available shell') : STARTED),
      'agent prompt': prompted('done'),
      'agent read': text('report'),
      'tab close': ok({}),
    })
    const outcome = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec: slowShell.exec, env: ENV, sleep })
    expect(outcome).toMatchObject({ state: 'done' })
    expect(starts).toBe(4)
    expect(sleeps).toEqual([500, 500, 500])

    const neverReady = scriptedHerdr({ 'tab create': TAB_CREATED, 'agent start': fail('invalid_target', 'agent target pane w1:p9 is not an available shell'), 'tab close': ok({}) })
    const gaveUp = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec: neverReady.exec, env: ENV, sleep })
    expect(gaveUp).toEqual({ error: 'herdr agent start (pi) failed: agent target pane w1:p9 is not an available shell' })
    expect(neverReady.calls.filter((c) => c[1] === 'start')).toHaveLength(20)
    expect(neverReady.calls.at(-1)).toEqual(['tab', 'close', 'w1:t9'])
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
    const aborted = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec: early.exec, env: ENV, signal: pre.signal })
    expect(aborted).toMatchObject({ state: 'aborted' })
    // The tab is gone, so the outcome text must not offer a resume handle.
    if ('error' in aborted) throw new Error(aborted.error)
    expect(herdrOutcomeText(aborted)).toBe('Terminal subagent aborted (Subagent was aborted). Its Herdr tab is closed.')
    expect(herdrOutcomeText(aborted)).not.toContain('resume')
  })

  it('carries extra env into the tab and refuses new runs past the kept-run cap', async () => {
    const { exec, calls } = scriptedHerdr({ 'tab create': TAB_CREATED, 'agent start': STARTED, 'agent prompt': fail('timeout'), 'agent read': text('') })
    const first = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec, env: ENV, extraEnv: { PI_CODE_AGENT_HOOKS: '{"a":1}' } })
    if ('error' in first) throw new Error(first.error)
    expect(calls[0]).toEqual(expect.arrayContaining(['--env', 'PI_CODE_SUBAGENT=1', '--env', 'PI_CODE_AGENT_HOOKS={"a":1}']))
    for (let i = 1; i < MAX_TERMINAL_RUNS; i++) {
      const kept = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec, env: ENV })
      if ('error' in kept) throw new Error(kept.error)
    }
    expect(herdrRuns()).toHaveLength(MAX_TERMINAL_RUNS)
    const refused = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec, env: ENV })
    expect(refused).toMatchObject({ error: expect.stringContaining(`max ${MAX_TERMINAL_RUNS}`) })
  })

  it('cleans a pristine isolation worktree with the tab and reports a kept one', async () => {
    const cleanupMock = vi.spyOn(worktreeModule, 'cleanupAgentWorktree')
    const wt = { dir: '/wt/agent', branch: 'agent/x', baseSha: 'abc123', root: '/repo' }
    // Pristine: removed silently on the done path.
    cleanupMock.mockResolvedValueOnce('removed')
    const done = scriptedHerdr({ 'tab create': TAB_CREATED, 'agent start': STARTED, 'agent prompt': prompted('done'), 'agent read': text('fine'), 'tab close': ok({}) })
    const outcome = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: wt.dir, worktree: wt, timeoutMs: 5, exec: done.exec, env: ENV })
    expect(outcome).toMatchObject({ state: 'done', report: 'fine' })
    expect(cleanupMock).toHaveBeenCalledWith('/repo', wt)
    // Changed: kept, and the report says where.
    cleanupMock.mockResolvedValueOnce('kept')
    const kept = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: wt.dir, worktree: wt, timeoutMs: 5, exec: done.exec, env: ENV })
    if ('error' in kept) throw new Error(kept.error)
    expect(kept.report).toBe("fine\n\n[isolation: worktree kept at /wt/agent (branch agent/x); the agent's changes live there]")
    // A tab that never opened still releases the worktree it was handed.
    cleanupMock.mockResolvedValueOnce('removed')
    const noTab = scriptedHerdr({ 'tab create': fail('nope') })
    await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: wt.dir, worktree: wt, timeoutMs: 5, exec: noTab.exec, env: ENV })
    expect(cleanupMock).toHaveBeenCalledTimes(3)
    // Cancel returns the kept note for the caller to show.
    cleanupMock.mockResolvedValueOnce('kept')
    const blocked = scriptedHerdr({ 'tab create': TAB_CREATED, 'agent start': STARTED, 'agent prompt': prompted('blocked'), 'agent read': text(''), 'agent send-keys': ok({}), 'tab close': ok({}) })
    const held = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: wt.dir, worktree: wt, timeoutMs: 5, exec: blocked.exec, env: ENV })
    if ('error' in held) throw new Error(held.error)
    expect(await cancelInHerdr(held.run.name, blocked.exec)).toEqual({ outcome: 'cancelled', note: expect.stringContaining('worktree kept') })
    // A cleanup that throws is treated as kept rather than crashing the close.
    cleanupMock.mockRejectedValueOnce(new Error('git gone'))
    const held2 = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: wt.dir, worktree: wt, timeoutMs: 5, exec: blocked.exec, env: ENV })
    if ('error' in held2) throw new Error(held2.error)
    expect(await cancelInHerdr(held2.run.name, blocked.exec)).toEqual({ outcome: 'cancelled', note: expect.stringContaining('worktree kept') })
  })

  it('forgets a kept run whose tab a human closed when the next prompt finds nothing', async () => {
    const { exec } = scriptedHerdr({ 'tab create': TAB_CREATED, 'agent start': STARTED, 'agent prompt': prompted('blocked'), 'agent read': text('') })
    const held = await runInHerdr({ agent: agent(), runner: runnerFor({}), launch: launch(), cwd: '/work', timeoutMs: 5, exec, env: ENV })
    if ('error' in held) throw new Error(held.error)
    const gone = scriptedHerdr({ 'agent prompt': fail('agent_not_found', 'agent target x not found') })
    const outcome = await resumeInHerdr(held.run.name, 'again', 5, gone.exec)
    expect(outcome).toMatchObject({ state: 'failed', reason: 'agent target x not found; the run has been forgotten' })
    expect(herdrRun(held.run.name)).toBeUndefined()
    expect(fs.existsSync(held.run.dir)).toBe(false)
    if ('error' in outcome) throw new Error(outcome.error)
    expect(herdrOutcomeText(outcome)).toContain('Its Herdr tab is closed.')
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
    expect(await cancelInHerdr(outcome.run.name, exec)).toEqual({ outcome: 'cancelled', note: undefined })
    expect(calls.slice(-2).map((c) => c.slice(0, 2).join(' '))).toEqual(['agent send-keys', 'tab close'])
    expect(herdrRuns()).toEqual([])
    expect(await cancelInHerdr('nobody', exec)).toEqual({ outcome: 'unknown' })
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
    // No JSON and empty stderr: the Node error is the only diagnostic, so it is the message.
    expect(await fresh(['agent', 'list'])).toMatchObject({ ok: false, code: 'ENOENT', message: 'spawn herdr ENOENT' })
    vi.doUnmock('node:child_process')
    expect(typeof execHerdr).toBe('function')
  })
})
