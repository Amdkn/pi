/**
 * Smoke test for @aspace/pi-adapter (D-N051 F8, pas 2).
 * Standalone, no test framework:
 *   node --experimental-strip-types aspace-pi-adapter/smoke_test.ts
 * Exit 0 = all checks green; exit 1 = at least one check red (named).
 * Also runnable with the network namespace removed (`unshare -n ...`):
 * every check is local (git reads, file reads, pure functions, a fetch
 * guard that throws before any network is touched), so the smoke passes
 * with zero interfaces at all.
 * The V5 config is read from $V5_CONFIG or, by default, the sibling
 * v5-repo checkout (../v5-repo/02_Factory/config.json).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ADAPTER_VERSION,
  ASPACE_TELEMETRY_CONTRACT,
  AspaceOutboundBlockedError,
  CRASH_LIMIT,
  CrashCounter,
  ExactlyOnceRegistry,
  MODEL_POOL_PROVIDER,
  PINNED_PI_COMMIT,
  PINNED_PI_COMMIT_FULL,
  PINNED_PI_VERSION,
  PINNED_SURFACE,
  SUBAGENTS_TOOL,
  TELEMETRY_BLOCKLIST,
  installOutboundGuard,
  isOutboundAllowed,
  readModelPoolChain,
  resolveModelCall,
  verifyFrozenCommit,
  verifyFrozenLineage,
} from './src/index.ts'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const EXPECTED_CHAIN = [
  'freellmapi/auto',
  'claude-sonnet-4-5',
  'qwen3.8-max',
  'gemini-3.8-flash',
  'deepseek-v4-flash',
]

async function main(): Promise<void> {
  console.log('@aspace/pi-adapter — smoke test')

  // 1. Pins (D1, D2).
  check('pins frozen commit short', PINNED_PI_COMMIT === '6e2222a')
  check(
    'pins frozen commit full SHA',
    PINNED_PI_COMMIT_FULL ===
      '6e2222a8dda06e3d69fad46d630f152f5873567a',
  )
  check('pins frozen version 1.5.0', PINNED_PI_VERSION === '1.5.0')
  check('adapter version 0.1.0', ADAPTER_VERSION === '0.1.0')
  check(
    'pinned surface names Harness.resume()',
    PINNED_SURFACE.some((s) => s.includes('Harness.resume()')),
  )
  check(
    'pinned surface names submit() with requestId',
    PINNED_SURFACE.some((s) => s.includes('submit(draft, context)')),
  )
  check(
    'pinned surface names NOOP_TELEMETRY_CONTEXT',
    PINNED_SURFACE.some((s) => s.includes('NOOP_TELEMETRY_CONTEXT')),
  )
  check(
    'pinned surface names extension subagents',
    PINNED_SURFACE.some((s) => s.includes('subagents')),
  )
  check('telemetry blocklist non-empty', TELEMETRY_BLOCKLIST.length >= 10)

  // 2. Lineage: the gel is an ancestor of HEAD and the only files that
  // differ from the gel live inside the adapter dir (D1 + H-P2-1, local
  // form). True at the gel and after the adapter commit(s).
  const lineage = verifyFrozenLineage()
  check('lineage: gel is ancestor of HEAD', lineage.gelAncestor)
  check(
    'lineage: diff is adapter-only',
    lineage.nonAdapterFiles.length === 0,
    lineage.nonAdapterFiles.join(', '),
  )
  check('lineage: ahead >= 0', lineage.ahead >= 0, `ahead=${lineage.ahead}`)
  const frozen = verifyFrozenCommit()
  console.log(
    `  info frozen commit check: ok=${frozen.ok} head=${frozen.head} (ok=false is expected after the adapter commit; lineage is the authoritative check)`,
  )

  // 3. modelPool, single spelling (D4, H-P2-5 spelling part).
  const v5Config =
    process.env.V5_CONFIG ??
    fileURLToPath(
      new URL('../../v5-repo/02_Factory/config.json', import.meta.url),
    )
  const chain = readModelPoolChain(v5Config)
  check(
    'modelPool: chain read from config.json has 5 links',
    chain.length === 5,
    `got ${chain.length}`,
  )
  check(
    'modelPool: chain is exactly the canonical bare names',
    JSON.stringify(chain) === JSON.stringify(EXPECTED_CHAIN),
    JSON.stringify(chain),
  )
  check(
    'modelPool: provider is freellmapi',
    MODEL_POOL_PROVIDER === 'freellmapi',
  )
  check(
    'modelPool: link 0 already prefixed, returned as-is',
    resolveModelCall(chain, 0) === 'freellmapi/auto',
  )
  check(
    'modelPool: bare link prefixed at call time',
    resolveModelCall(chain, 1) === 'freellmapi/claude-sonnet-4-5' &&
      resolveModelCall(chain, 2) === 'freellmapi/qwen3.8-max' &&
      resolveModelCall(chain, 3) === 'freellmapi/gemini-3.8-flash' &&
      resolveModelCall(chain, 4) === 'freellmapi/deepseek-v4-flash',
  )
  let outOfRange = false
  try {
    resolveModelCall(chain, 5)
  } catch {
    outOfRange = true
  }
  check('modelPool: index out of range throws', outOfRange)

  // 4. Exactly-once (H-P2-2, adapter-side form).
  const registry = new ExactlyOnceRegistry()
  let produceCalls = 0
  const first = registry.submit('greeting-1', () => {
    produceCalls++
    return { submissionId: 1 }
  })
  const second = registry.submit('greeting-1', () => {
    produceCalls++
    return { submissionId: 2 }
  })
  check('exactly-once: first submit is not a duplicate', !first.duplicate)
  check(
    'exactly-once: retry returns the existing submission',
    second.duplicate && second.record.submissionId === 1,
  )
  check(
    'exactly-once: producer invoked once for the same requestId',
    produceCalls === 1,
    `produceCalls=${produceCalls}`,
  )
  check(
    'exactly-once: a different requestId submits anew',
    !registry.submit('greeting-2', () => ({ submissionId: 3 })).duplicate,
  )
  check(
    'exactly-once: lookup finds the stored submission',
    registry.lookup('greeting-1')?.submissionId === 1,
  )

  // 5. Crash counter (D9, H-P2-11 logic, local form).
  const counter = new CrashCounter()
  check('crash limit is 3', CRASH_LIMIT === 3)
  counter.recordCrash('req-1')
  counter.recordCrash('req-1')
  check(
    'crash counter: 2 crashes, no report, resume allowed',
    !counter.shouldReport('req-1') && !counter.isResumeDisabled('req-1'),
  )
  counter.recordCrash('req-1')
  check(
    'crash counter: 3rd crash reports and disables resume',
    counter.shouldReport('req-1') && counter.isResumeDisabled('req-1'),
  )
  check(
    'crash counter: 4th crash stays reported, count keeps growing',
    counter.recordCrash('req-1').count === 4 &&
      counter.isResumeDisabled('req-1'),
  )
  counter.recordCheckpoint('req-1')
  check(
    'crash counter: a checkpoint resets the consecutive count',
    counter.state('req-1').count === 0,
  )
  check(
    'crash counter: reported flag survives the checkpoint (Doctor decides)',
    counter.isResumeDisabled('req-1'),
  )
  const other = new CrashCounter()
  other.recordCrash('req-2')
  check(
    'crash counter: counters are per requestId',
    other.state('req-2').count === 1 && other.state('req-1').count === 0,
  )

  // 6. Telemetry contract (D5, H-P2-8 file part).
  check(
    'telemetry contract: context is NOOP_TELEMETRY_CONTEXT',
    ASPACE_TELEMETRY_CONTRACT.context === 'NOOP_TELEMETRY_CONTEXT',
  )
  check(
    'telemetry contract: zero exporters',
    ASPACE_TELEMETRY_CONTRACT.exporters.length === 0,
  )
  const harnessSrc = readFileSync(
    fileURLToPath(
      new URL(
        '../packages/durable/src/harness/harness.ts',
        import.meta.url,
      ),
    ),
    'utf-8',
  )
  check(
    'telemetry: durable harness defaults to NOOP_TELEMETRY_CONTEXT',
    harnessSrc.includes('options.telemetry ?? NOOP_TELEMETRY_CONTEXT'),
  )

  // 7. Outbound guard (D5, execution part).
  check(
    'guard: loopback allowed',
    isOutboundAllowed('http://127.0.0.1:31415/v1/models'),
  )
  check(
    'guard: unknown host denied by default',
    !isOutboundAllowed('https://api.example.com/v1/chat'),
  )
  check(
    'guard: unknown host allowed when explicitly listed',
    isOutboundAllowed('https://api.example.com/v1/chat', ['api.example.com']),
  )
  check(
    'guard: blocklisted host denied even when allow-listed',
    !isOutboundAllowed('https://ingest.sentry.io/api/1', ['ingest.sentry.io']),
  )
  check(
    'guard: non-http(s) denied',
    !isOutboundAllowed('file:///etc/passwd'),
  )
  check('guard: unparseable URL denied', !isOutboundAllowed(':::'))
  const restore = installOutboundGuard()
  let blocked = false
  try {
    await fetch('https://ingest.sentry.io/api/1')
  } catch (err) {
    blocked = err instanceof AspaceOutboundBlockedError
  }
  check('guard: fetch to a blocklisted host throws before network', blocked)
  let blockedUnknown = false
  try {
    await fetch('https://api.example.com/v1/chat')
  } catch (err) {
    blockedUnknown = err instanceof AspaceOutboundBlockedError
  }
  check('guard: fetch to an unknown host throws before network', blockedUnknown)
  let loopbackNotGuarded = false
  try {
    await fetch('http://127.0.0.1:9/nope')
  } catch (err) {
    loopbackNotGuarded = !(err instanceof AspaceOutboundBlockedError)
  }
  check(
    'guard: loopback fetch passes the guard (fails at the OS, not the guard)',
    loopbackNotGuarded,
  )
  restore()

  // 8. Extension interface pin (D6, H-P2-9 pin part).
  check('extension: tool name is subagents', SUBAGENTS_TOOL.name === 'subagents')
  check(
    'extension: 6 actions pinned',
    SUBAGENTS_TOOL.actions.length === 6 &&
      SUBAGENTS_TOOL.actions.includes('run') &&
      SUBAGENTS_TOOL.actions.includes('resume'),
  )
  check(
    'extension: 13 parameters pinned',
    SUBAGENTS_TOOL.parameters.length === 13 &&
      SUBAGENTS_TOOL.parameters.includes('requestId') &&
      SUBAGENTS_TOOL.parameters.includes('writer'),
  )

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(`failures: ${failures.join(', ')}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
