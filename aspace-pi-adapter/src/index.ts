/**
 * @aspace/pi-adapter — the only A'Space code in this fork (D-N051 F8, pas 2).
 *
 * The upstream pi runtime is never modified (byte-identical to the frozen
 * commit). Every A'Space adaptation lives here, behind this stable surface.
 * The adapter does NOT boot the runtime and does NOT wrap inference: its job
 * is the H-P2 contract — the durable surface pinned on the gel (D2), the
 * single-spelling modelPool (D4), the NOOP telemetry contract (D5), the
 * crash counter bounded at 3 (D9) — plus pinning the exact upstream surface
 * it depends on, so a drift is a named design event, not a silent break.
 *
 * Pinned surface (upstream code this adapter depends on, gel 6e2222a, 1.5.0):
 * - `createSession()` from `packages/durable/src/session/session.ts`
 *   (exported `packages/durable/src/index.ts:139`).
 * - `Harness.resume()` from `packages/durable/src/harness/harness.ts:304`
 *   (`this.#tasks.resume()` — starts the task scheduler; work interrupted
 *   by a crash stays pending until resumed).
 * - `ConversationHandle.submit(draft, context)` with `requestId` — the
 *   exactly-once contract (README:129-134: a retried submission with the
 *   same `requestId` returns the existing submission instead of submitting
 *   twice); lookup `submissionByRequest(conversationId, requestId)` in
 *   `packages/durable/src/types.ts:1013` (implemented
 *   `src/session/session.ts:2040`, key `req:<conversationId>:<requestId>`
 *   in `src/session/keys.ts:61`).
 * - `defineTask()` from `packages/durable/src/tasks.ts:4`.
 * - `MemoryStorage` (`packages/durable/src/storage/memory.ts:239`) and the
 *   storage backends (`openNodeSqliteStorage`,
 *   `packages/durable/src/storage/sqlite/node.ts:15`; JSONL
 *   `packages/durable/src/storage/jsonl/`; IndexedDB).
 * - `NOOP_TELEMETRY_CONTEXT` from `packages/telemetry/src/noop.ts`
 *   (re-exported `packages/telemetry/src/index.ts:130`); the durable
 *   harness defaults to it (`packages/durable/src/harness/harness.ts:220`,
 *   `scheduler.ts:410`, `submissions.ts:50`). `DURABLE_TELEMETRY_SCHEMA`
 *   (`packages/durable/src/harness/telemetry.ts`, exported
 *   `packages/durable/src/index.ts:60`) is content-free (IDs only).
 * - `onWake` host callback (`packages/durable/src/harness/types.ts:750`):
 *   the host arms its own wakeup and calls `resume()` when it fires.
 * - Extension interface (V5, `.pi/extensions/aspace-factory.ts`): tool
 *   `subagents` (actions `agents`/`status`/`run`/`chain`/`send`/`resume`),
 *   imports `ExtensionAPI` from `@earendil-works/pi-coding-agent` and
 *   `Type` from `@earendil-works/pi-ai` — names preserved verbatim (D8).
 *
 * Telemetry contract (H-P2-8, see `pi-TELEMETRY-AUDIT.md`):
 * - Zero telemetry SDKs in the dependency tree; `packages/telemetry` is a
 *   contract of callbacks only (no exporter, no `fetch` anywhere in
 *   `packages/telemetry/src/` nor in `packages/durable/src/`).
 * - The adapter enforces the contract at runtime: `installOutboundGuard()`
 *   wraps the global `fetch` and denies every non-loopback host unless it
 *   is explicitly allow-listed for this run; known telemetry/analytics
 *   hosts are denied even when allow-listed.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** Adapter version (semver of the adapted module, D4). */
export const ADAPTER_VERSION = '0.1.0'

/** Frozen upstream commit this adapter is built against, short form (D1). */
export const PINNED_PI_COMMIT = '6e2222a'

/** Frozen upstream commit, full 40-hex SHA (D1). */
export const PINNED_PI_COMMIT_FULL =
  '6e2222a8dda06e3d69fad46d630f152f5873567a'

/** Frozen upstream version (D1 — the gel is 1.5.0, not the live 1.5.2). */
export const PINNED_PI_VERSION = '1.5.0'

/** Upstream repository this fork tracks. */
export const PINNED_UPSTREAM_REPO = 'earendil-works/pi'

/** The pinned upstream surface, as names — a drift here is a design event. */
export const PINNED_SURFACE = [
  'createSession() from packages/durable/src/session/session.ts (exported src/index.ts:139)',
  'Harness.resume() from packages/durable/src/harness/harness.ts:304 (this.#tasks.resume())',
  'ConversationHandle.submit(draft, context) with requestId (README:129-134, exactly-once)',
  'submissionByRequest(conversationId, requestId) from packages/durable/src/types.ts:1013 (session.ts:2040, key req:<conversationId>:<requestId> in session/keys.ts:61)',
  'defineTask() from packages/durable/src/tasks.ts:4',
  'MemoryStorage from packages/durable/src/storage/memory.ts:239; openNodeSqliteStorage from packages/durable/src/storage/sqlite/node.ts:15',
  'NOOP_TELEMETRY_CONTEXT from packages/telemetry/src/noop.ts (re-exported src/index.ts:130); defaults in durable harness.ts:220, scheduler.ts:410, submissions.ts:50',
  'DURABLE_TELEMETRY_SCHEMA from packages/durable/src/harness/telemetry.ts (exported src/index.ts:60) — content-free (IDs only)',
  'onWake host callback from packages/durable/src/harness/types.ts:750 (host arms its own wakeup, calls resume())',
  'Extension interface (V5 .pi/extensions/aspace-factory.ts): tool subagents, actions agents/status/run/chain/send/resume; imports @earendil-works/pi-coding-agent + @earendil-works/pi-ai (names preserved, D8)',
] as const

/** Host substrings that are ALWAYS denied, even when allow-listed. */
export const TELEMETRY_BLOCKLIST = [
  'posthog',
  'sentry.io',
  'ingest.sentry',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'amplitude.com',
  'datadoghq',
  'newrelic.com',
  'nr-data.net',
  'google-analytics.com',
  'googletagmanager.com',
  'hotjar.com',
  'fullstory.com',
  'heap.io',
  'telemetry',
] as const

/** Loopback hosts: the only hosts allowed by default. */
export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'] as const

/**
 * The `modelPool` chain, single canonical spelling (D4): the bare names as
 * stored once in `02_Factory/config.json` (D-N049 D7). The chain is NEVER
 * stored a second time — every consumer reads it from `config.json` and
 * prefixes the provider at call time (see `resolveModelCall`).
 */
export const MODEL_POOL_PROVIDER = 'freellmapi'

/** Read the canonical chain from a V5 `config.json` (bare names, D4). */
export function readModelPoolChain(configPath: string): string[] {
  const raw = readFileSync(configPath, 'utf-8')
  const parsed: unknown = JSON.parse(raw)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('modelPool' in parsed) ||
    typeof (parsed as { modelPool: unknown }).modelPool !== 'object' ||
    (parsed as { modelPool: { chain?: unknown } }).modelPool === null ||
    !Array.isArray(
      (parsed as { modelPool: { chain?: unknown } }).modelPool.chain,
    )
  ) {
    throw new Error(
      `modelPool.chain not found in ${configPath} (expected config.json with modelPool.chain)`,
    )
  }
  const chain = (parsed as { modelPool: { chain: unknown[] } }).modelPool
    .chain
  if (chain.some((m) => typeof m !== 'string' || m.length === 0)) {
    throw new Error(`modelPool.chain in ${configPath} contains a non-string entry`)
  }
  return [...(chain as string[])]
}

/**
 * Resolve one link of the chain to the model string used at call time (D4):
 * the provider is prefixed here, never stored. A link already prefixed
 * (e.g. `freellmapi/auto`) is returned as-is; a bare name
 * (e.g. `claude-sonnet-4-5`) becomes `freellmapi/claude-sonnet-4-5`.
 */
export function resolveModelCall(chain: readonly string[], index: number): string {
  if (index < 0 || index >= chain.length) {
    throw new Error(`modelPool index ${index} out of range (chain length ${chain.length})`)
  }
  const link = chain[index] as string
  if (link.includes('/')) return link
  return `${MODEL_POOL_PROVIDER}/${link}`
}

/** Crash bound (D9): 3 consecutive crashes before a checkpoint. */
export const CRASH_LIMIT = 3

/**
 * DDL fragment for the crash counter (D9), to live in the spine's
 * `factory.sqlite` next to `durable_workflows` / `durable_steps`. The
 * adapter itself keeps its counter in memory (see `CrashCounter`); the
 * spine persists it with this table, keyed by `requestId`.
 */
export const CRASH_COUNT_DDL = `CREATE TABLE IF NOT EXISTS crash_counts (
  request_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  last_crash_ts TEXT,
  reported INTEGER NOT NULL DEFAULT 0
);`

export interface CrashState {
  count: number
  reported: boolean
}

/**
 * Crash counter per task (D9). A checkpoint resets the consecutive count
 * (a crash AFTER a checkpoint starts a new streak). At `CRASH_LIMIT`
 * consecutive crashes before a checkpoint the task is reported (pulsed as
 * an anomaly to Rick and Yaz, with its `requestId` and the counter) and
 * its resume is disabled until a Doctor decides.
 */
export class CrashCounter {
  private readonly states = new Map<string, CrashState>()

  recordCrash(requestId: string): CrashState {
    const prev = this.states.get(requestId) ?? { count: 0, reported: false }
    const next: CrashState = { count: prev.count + 1, reported: prev.reported }
    if (next.count >= CRASH_LIMIT) next.reported = true
    this.states.set(requestId, next)
    return { ...next }
  }

  recordCheckpoint(requestId: string): void {
    const prev = this.states.get(requestId)
    if (prev) this.states.set(requestId, { count: 0, reported: prev.reported })
  }

  state(requestId: string): CrashState {
    return { ...(this.states.get(requestId) ?? { count: 0, reported: false }) }
  }

  shouldReport(requestId: string): boolean {
    return (this.states.get(requestId)?.count ?? 0) >= CRASH_LIMIT
  }

  isResumeDisabled(requestId: string): boolean {
    return this.states.get(requestId)?.reported === true
  }
}

export interface SubmissionRecord {
  requestId: string
  submissionId: number
}

/**
 * Exactly-once submission registry (H-P2-2, the adapter-side form of the
 * durable contract): submitting twice with the same `requestId` returns
 * the existing submission instead of submitting twice. The producer is
 * invoked at most once per `requestId`.
 */
export class ExactlyOnceRegistry {
  private readonly byRequest = new Map<string, SubmissionRecord>()
  private nextId = 1

  submit(
    requestId: string,
    produce: () => Omit<SubmissionRecord, 'requestId'>,
  ): { record: SubmissionRecord; duplicate: boolean } {
    const existing = this.byRequest.get(requestId)
    if (existing) return { record: { ...existing }, duplicate: true }
    const record: SubmissionRecord = { requestId, ...produce() }
    this.byRequest.set(requestId, record)
    return { record: { ...record }, duplicate: false }
  }

  lookup(requestId: string): SubmissionRecord | undefined {
    const found = this.byRequest.get(requestId)
    return found ? { ...found } : undefined
  }

  size(): number {
    return this.byRequest.size
  }
}

/**
 * The `subagents` tool interface, pinned verbatim from V5
 * `.pi/extensions/aspace-factory.ts` (D6, H-P2-9). The interface — name,
 * actions, parameters — is preserved verbatim; a drift is a design event.
 */
export const SUBAGENTS_TOOL = {
  name: 'subagents',
  label: 'Durable Subagents (Pi Durable + DeepSeek Superagent + Herdr/Orca)',
  actions: ['agents', 'status', 'run', 'chain', 'send', 'resume'],
  parameters: [
    'action',
    'agent',
    'harness',
    'task',
    'chain',
    'wid',
    'to',
    'kind',
    'message',
    'requestId',
    'writer',
    'tail',
    'grep',
  ],
} as const

/** The telemetry contract (D5): NOOP context, zero exporters, ever. */
export const ASPACE_TELEMETRY_CONTRACT = {
  context: 'NOOP_TELEMETRY_CONTEXT',
  exporters: [],
} as const

export class AspaceOutboundBlockedError extends Error {
  readonly url: string
  constructor(url: string, reason: string) {
    super(`A'Space outbound guard blocked ${url}: ${reason}`)
    this.name = 'AspaceOutboundBlocked'
    this.url = url
  }
}

function hostnameOf(url: string | URL): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

function isBlocklisted(hostname: string): boolean {
  return TELEMETRY_BLOCKLIST.some((bad) => hostname.includes(bad))
}

/**
 * Pure policy check: is an outbound `fetch` to `url` allowed?
 * - Blocklisted telemetry/analytics hosts: never.
 * - Loopback hosts: always (local inference: Ollama, FreeLLMAPI, LFM3).
 * - Any other host: only when explicitly listed in `extraHosts`.
 * Non-http(s) URLs and unparseable URLs are denied (fail closed).
 */
export function isOutboundAllowed(
  url: string | URL,
  extraHosts: readonly string[] = [],
): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const hostname = parsed.hostname.toLowerCase()
  if (isBlocklisted(hostname)) return false
  if ((LOCAL_HOSTS as readonly string[]).includes(hostname)) return true
  const allowed = extraHosts.map((h) => h.toLowerCase())
  return allowed.includes(hostname)
}

/**
 * Install the outbound guard on the global `fetch`. Every http(s) fetch to a
 * host that is not loopback and not explicitly allow-listed throws
 * `AspaceOutboundBlockedError` BEFORE any network is touched; blocklisted
 * hosts throw even when allow-listed. Returns a restore function that puts
 * the original `fetch` back. The guard is idempotent per process: installing
 * twice restores to the previous wrapper, never to a stale original.
 */
export function installOutboundGuard(
  options: { allowHosts?: readonly string[] } = {},
): () => void {
  const originalFetch = globalThis.fetch
  const allowHosts = options.allowHosts ?? []
  const guarded = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    if (!isOutboundAllowed(url, allowHosts)) {
      const hostname = hostnameOf(url) ?? url
      const reason = hostname && isBlocklisted(hostname)
        ? 'telemetry/analytics host (blocklist)'
        : 'host not in the allow-list (default: loopback only)'
      throw new AspaceOutboundBlockedError(url, reason)
    }
    return originalFetch(input, init)
  }
  globalThis.fetch = guarded as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

/** Local repo info at the frozen commit, via plain git reads. */
export function getFrozenRepoInfo(): {
  branch: string
  headHash: string
  headMessage: string
} {
  return {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    headHash: git(['rev-parse', '--short', 'HEAD']),
    headMessage: git(['log', '-1', '--format=%s']),
  }
}

/** True when this checkout sits exactly on the frozen commit (D1). */
export function verifyFrozenCommit(): { ok: boolean; head: string } {
  const info = getFrozenRepoInfo()
  const ok =
    info.headHash.length >= 7 &&
    PINNED_PI_COMMIT_FULL.startsWith(info.headHash)
  return { ok, head: info.headHash }
}

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf-8',
    timeout: 15_000,
  }).trim()
}

/**
 * Lineage check (D1 + H-P2-1, local form): the frozen commit is an ancestor
 * of HEAD, and every file that differs between the gel and HEAD lives
 * inside `aspace-pi-adapter/`. True both at the gel (ahead 0, no diff) and
 * after the adapter commit(s) (ahead >= 1, adapter files only). Any
 * upstream file in the diff fails the check.
 */
export function verifyFrozenLineage(): {
  ok: boolean
  head: string
  headFull: string
  gelAncestor: boolean
  ahead: number
  nonAdapterFiles: string[]
} {
  const info = getFrozenRepoInfo()
  const headFull = git(['rev-parse', 'HEAD'])
  let gelAncestor = false
  try {
    execFileSync(
      'git',
      ['merge-base', '--is-ancestor', PINNED_PI_COMMIT_FULL, 'HEAD'],
      { cwd: process.cwd(), timeout: 15_000 },
    )
    gelAncestor = true
  } catch {
    gelAncestor = false
  }
  let ahead = -1
  try {
    ahead = Number(
      git(['rev-list', '--count', `${PINNED_PI_COMMIT_FULL}..HEAD`]),
    )
  } catch {
    ahead = -1
  }
  let nonAdapterFiles: string[] = []
  try {
    const diff = git([
      'diff',
      '--name-only',
      `${PINNED_PI_COMMIT_FULL}..HEAD`,
    ])
    nonAdapterFiles = diff
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0 && !f.startsWith('aspace-pi-adapter/'))
  } catch {
    nonAdapterFiles = ['<git diff failed>']
  }
  return {
    ok: gelAncestor && ahead >= 0 && nonAdapterFiles.length === 0,
    head: info.headHash,
    headFull,
    gelAncestor,
    ahead,
    nonAdapterFiles,
  }
}

export default {
  ADAPTER_VERSION,
  PINNED_PI_COMMIT,
  PINNED_PI_COMMIT_FULL,
  PINNED_PI_VERSION,
  PINNED_SURFACE,
  TELEMETRY_BLOCKLIST,
  LOCAL_HOSTS,
  MODEL_POOL_PROVIDER,
  CRASH_LIMIT,
  CRASH_COUNT_DDL,
  ASPACE_TELEMETRY_CONTRACT,
  SUBAGENTS_TOOL,
  readModelPoolChain,
  resolveModelCall,
  CrashCounter,
  ExactlyOnceRegistry,
  isOutboundAllowed,
  installOutboundGuard,
  getFrozenRepoInfo,
  verifyFrozenCommit,
  verifyFrozenLineage,
}
