/**
 * Terminal subagents: a child that runs interactively in a Herdr-managed tab
 * instead of as a headless JSON-mode process, so a human can watch it, answer its
 * prompts, or type at it while the parent waits.
 *
 * Herdr already knows how to start every supported harness in a pane and how to
 * tell idle from working from blocked, so this runner never opens a pty of its own:
 * it drives the `herdr` CLI. One tab per run, created without focus in the parent's
 * workspace; `agent start --kind <harness>` with the runner's interactive flags;
 * `agent prompt --wait` with a short pointer to a written brief; the report comes
 * back through a file the child is asked to write, because a TUI's alternate
 * screen leaves nothing readable in scrollback. A run that finished cleanly closes
 * its tab; one that ended blocked, stalled or timed out keeps it, since the tab is
 * where a human can now pick the child up.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { AgentConfig } from './agents.js'
import type { HarnessLaunch, HarnessRunner } from './harness.js'

/** Herdr injects these into every pane it manages; their absence means the parent
 * is not itself inside Herdr, and a tab cannot be created from outside. */
export function herdrContext(env: NodeJS.ProcessEnv = process.env): { workspaceId: string } | { error: string } {
  if (env.HERDR_ENV !== '1') return { error: 'terminal: herdr needs the parent pi to run inside a Herdr pane (HERDR_ENV=1 is not set).' }
  const workspaceId = env.HERDR_WORKSPACE_ID?.trim()
  if (!workspaceId) return { error: 'terminal: herdr needs HERDR_WORKSPACE_ID, which Herdr sets in every managed pane; it is missing.' }
  return { workspaceId }
}

/** Herdr agent names: `[a-z][a-z0-9_-]{0,31}`, unique among live agents. The agent's
 * own name is folded to that alphabet and suffixed so two runs of one agent never
 * collide. */
export function herdrAgentName(agentName: string, suffix: string = randomUUID().slice(0, 4)): string {
  const folded = agentName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
  const stem = (folded || 'agent').slice(0, 32 - suffix.length - 1)
  return `${stem}-${suffix}`
}

/** The one-line prompt the child receives. The brief holds the task; the report path
 * is where the child's answer must land, so the parent reads a file rather than a
 * terminal. */
export function herdrPromptText(briefPath: string, reportPath: string): string {
  return `Read ${briefPath} and carry out the task it describes. When you are finished, write your complete final report as Markdown to ${reportPath} and reply with only that path.`
}

export interface HerdrCliResult {
  ok: boolean
  code?: string
  message?: string
  result?: Record<string, unknown>
  /** Raw stdout, for the commands that print text rather than JSON (agent read). */
  stdout: string
}

export type HerdrExec = (args: string[]) => Promise<HerdrCliResult>

/** Run one `herdr` command. Control commands answer JSON on stdout; failures are
 * `{"error":{"code","message"}}` on stderr with exit 1, syntax errors exit 2. */
export const execHerdr: HerdrExec = (args) =>
  new Promise((resolve) => {
    execFile('herdr', args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = String(stdout ?? '')
      const err = String(stderr ?? '')
      if (!error) {
        let parsed: Record<string, unknown> | undefined
        try {
          parsed = JSON.parse(out) as Record<string, unknown>
        } catch {
          parsed = undefined
        }
        resolve({ ok: true, result: parsed?.result as Record<string, unknown> | undefined, stdout: out })
        return
      }
      let code: string | undefined
      let message: string | undefined
      for (const text of [err, out]) {
        try {
          const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
          if (parsed?.error) {
            code = parsed.error.code
            message = parsed.error.message
            break
          }
        } catch {
          /* not JSON */
        }
      }
      resolve({ ok: false, code: code ?? (error as NodeJS.ErrnoException).code ?? 'herdr_failed', message: message ?? err.trim() ?? error.message, stdout: out })
    })
  })

export type HerdrRunState = 'done' | 'blocked' | 'stalled' | 'timeout' | 'failed' | 'aborted'

export interface HerdrRun {
  /** The Herdr agent name; also the handle the parent uses to resume or cancel. */
  name: string
  agent: string
  harness: string
  tabId: string
  paneId: string
  dir: string
  state: 'running' | HerdrRunState
  /** True while the tab is still open. */
  tabOpen: boolean
}

const runs = new Map<string, HerdrRun>()

export function herdrRuns(): HerdrRun[] {
  return [...runs.values()]
}

export function herdrRun(name: string): HerdrRun | undefined {
  return runs.get(name)
}

/** Reset the registry (tests). */
export function resetHerdrRuns(): void {
  runs.clear()
}

export interface HerdrRunOutcome {
  state: HerdrRunState
  /** The child's report: the report file when it wrote one, else what the pane shows. */
  report: string
  run: HerdrRun
  /** Why the run did not end `done`, in Herdr's words. */
  reason?: string
}

export interface HerdrStartOptions {
  agent: AgentConfig
  runner: HarnessRunner
  launch: HarnessLaunch
  cwd: string
  /** How long `agent prompt --wait` may take before the run is reported `timeout`
   * and its tab kept. */
  timeoutMs: number
  signal?: AbortSignal
  exec?: HerdrExec
  env?: NodeJS.ProcessEnv
  /** Test seam for the shell-readiness retry delay. */
  sleep?: (ms: number) => Promise<void>
}

const START_TIMEOUT_MS = 60_000

/** A new tab's shell takes a moment to reach its prompt, and `agent start` refuses a
 * pane that is not yet an available shell. Retried on that one refusal, bounded. */
const SHELL_READY_ATTEMPTS = 20
const SHELL_READY_DELAY_MS = 500

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function isShellNotReady(result: HerdrCliResult): boolean {
  return !result.ok && result.code !== 'agent_not_ready' && /not an available shell/i.test(result.message ?? '')
}

function readReport(reportPath: string): string | undefined {
  try {
    const text = fs.readFileSync(reportPath, 'utf-8')
    return text.trim() ? text : undefined
  } catch {
    return undefined
  }
}

async function paneText(exec: HerdrExec, name: string): Promise<string> {
  const read = await exec(['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', '200'])
  return read.stdout.trim()
}

async function closeTab(exec: HerdrExec, run: HerdrRun): Promise<void> {
  if (!run.tabOpen) return
  await exec(['tab', 'close', run.tabId])
  run.tabOpen = false
  fs.rmSync(run.dir, { recursive: true, force: true })
}

/** Start a terminal run and wait for its first settled state. */
export async function runInHerdr(options: HerdrStartOptions): Promise<HerdrRunOutcome | { error: string }> {
  const exec = options.exec ?? execHerdr
  const context = herdrContext(options.env)
  if ('error' in context) return context
  const { agent, runner, launch, cwd } = options

  const name = herdrAgentName(agent.name)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-subagent-herdr-'))
  const briefPath = path.join(dir, 'brief.md')
  const reportPath = path.join(dir, 'report.md')
  fs.writeFileSync(briefPath, launch.task, { mode: 0o600 })
  // The system prompt lives beside the brief for as long as the tab does: the child
  // reads it at boot, and a human restarting a kept tab by hand may want it again.
  let launchWithPrompt = launch
  if (launch.systemPromptBody?.trim()) {
    const systemPromptPath = path.join(dir, 'system-prompt.md')
    fs.writeFileSync(systemPromptPath, launch.systemPromptBody, { mode: 0o600 })
    launchWithPrompt = { ...launch, systemPromptPath }
  }

  // PI_CODE_SUBAGENT rides the tab env so a pi child refuses to nest further, the
  // same marker the headless path sets.
  const created = await exec(['tab', 'create', '--workspace', context.workspaceId, '--cwd', cwd, '--label', name, '--env', 'PI_CODE_SUBAGENT=1', '--no-focus'])
  const tab = created.result?.tab as { tab_id?: string } | undefined
  const rootPane = created.result?.root_pane as { pane_id?: string } | undefined
  if (!created.ok || !tab?.tab_id || !rootPane?.pane_id) {
    fs.rmSync(dir, { recursive: true, force: true })
    return { error: `herdr tab create failed: ${created.message ?? 'no tab in the response'}` }
  }
  const run: HerdrRun = { name, agent: agent.name, harness: runner.kind, tabId: tab.tab_id, paneId: rootPane.pane_id, dir, state: 'running', tabOpen: true }
  runs.set(name, run)

  const startArgs = ['agent', 'start', name, '--kind', runner.kind, '--pane', run.paneId, '--timeout', String(START_TIMEOUT_MS), '--', ...runner.interactive(launchWithPrompt)]
  const sleep = options.sleep ?? defaultSleep
  let started = await exec(startArgs)
  for (let attempt = 1; attempt < SHELL_READY_ATTEMPTS && isShellNotReady(started); attempt++) {
    await sleep(SHELL_READY_DELAY_MS)
    started = await exec(startArgs)
  }
  if (!started.ok && started.code !== 'agent_not_ready') {
    run.state = 'failed'
    await closeTab(exec, run)
    runs.delete(name)
    return { error: `herdr agent start (${runner.kind}) failed: ${started.message ?? started.code}` }
  }
  if (!started.ok) {
    // Blocked during startup (a trust prompt, a login): the pane is the human's now.
    run.state = 'blocked'
    return { state: 'blocked', report: await paneText(exec, name), run, reason: started.message }
  }

  return promptAndWait(exec, run, herdrPromptText(briefPath, reportPath), reportPath, options.timeoutMs, options.signal)
}

/** Send a follow-up to a kept run and wait for it to settle again. */
export async function resumeInHerdr(name: string, task: string, timeoutMs: number, exec: HerdrExec = execHerdr, signal?: AbortSignal): Promise<HerdrRunOutcome | { error: string }> {
  // A run leaves the registry the moment its tab closes, so a registered run
  // always has a live tab to prompt.
  const run = runs.get(name)
  if (!run) return { error: `Unknown terminal run: ${name}.` }
  const briefPath = path.join(run.dir, `brief-${Date.now()}.md`)
  const reportPath = path.join(run.dir, `report-${Date.now()}.md`)
  fs.writeFileSync(briefPath, task, { mode: 0o600 })
  run.state = 'running'
  return promptAndWait(exec, run, herdrPromptText(briefPath, reportPath), reportPath, timeoutMs, signal)
}

/** Interrupt a kept run and close its tab. */
export async function cancelInHerdr(name: string, exec: HerdrExec = execHerdr): Promise<'cancelled' | 'unknown'> {
  const run = runs.get(name)
  if (!run) return 'unknown'
  if (run.tabOpen) {
    await exec(['agent', 'send-keys', name, 'ctrl+c'])
    await closeTab(exec, run)
  }
  run.state = 'aborted'
  runs.delete(name)
  return 'cancelled'
}

async function promptAndWait(exec: HerdrExec, run: HerdrRun, prompt: string, reportPath: string, timeoutMs: number, signal?: AbortSignal): Promise<HerdrRunOutcome> {
  let aborted = false
  const onAbort = (): void => {
    aborted = true
    void cancelInHerdr(run.name, exec)
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })

  const prompted = await exec(['agent', 'prompt', run.name, prompt, '--wait', '--timeout', String(timeoutMs)])
  signal?.removeEventListener('abort', onAbort)
  if (aborted) return { state: 'aborted', report: '', run, reason: 'Subagent was aborted' }

  const agentInfo = prompted.result?.agent as { agent_status?: string } | undefined
  const status = agentInfo?.agent_status
  if (prompted.ok && (status === 'idle' || status === 'done')) {
    run.state = 'done'
    const report = readReport(reportPath) ?? (await paneText(exec, run.name))
    await closeTab(exec, run)
    runs.delete(run.name)
    return { state: 'done', report, run }
  }
  // Every other ending keeps the tab: it is now the place a human finishes the job.
  const state: HerdrRunState = prompted.ok && status === 'blocked' ? 'blocked' : prompted.code === 'agent_blocked' ? 'blocked' : prompted.code === 'agent_prompt_stalled' ? 'stalled' : prompted.code === 'timeout' ? 'timeout' : 'failed'
  run.state = state
  return { state, report: readReport(reportPath) ?? (await paneText(exec, run.name)), run, reason: prompted.message ?? (status ? `agent status ${status}` : undefined) }
}

/** The text the parent model reads for a terminal run's outcome. */
export function herdrOutcomeText(outcome: HerdrRunOutcome): string {
  const { run } = outcome
  if (outcome.state === 'done') return outcome.report || '(no output)'
  const where = `Herdr tab ${run.tabId} (agent ${run.name}, ${run.harness}) is kept open`
  const follow = `{resume: "${run.name}", task: "..."}`
  const next = outcome.state === 'blocked' ? `The child is waiting on an approval or question a human must answer in that tab; then continue it with ${follow}.` : `Continue it with ${follow} or close it with {cancel: "${run.name}"}.`
  const reason = outcome.reason ? ` (${outcome.reason})` : ''
  return `Terminal subagent ${outcome.state}${reason}. ${where}. ${next}\n\nPane shows:\n${outcome.report || '(nothing readable)'}`
}
