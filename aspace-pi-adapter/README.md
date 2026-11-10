# @aspace/pi-adapter

The only A'Space code in this fork (D-N051 F8, pas 2). The upstream pi
runtime is never modified — byte-identical to the frozen commit `6e2222a`
(1.5.0).

## What it does

- `readModelPoolChain(configPath)` / `resolveModelCall(chain, index)` —
  the `modelPool` chain under a single spelling (D4): the bare names are
  read once from V5 `02_Factory/config.json` and never stored a second
  time; the provider (`freellmapi`) is prefixed at call time only.
  The two mixed spellings found in the spine (`factory.ps1` line 200
  prefixed 5 links, lines 227/247 mixed 3 links) are corrected at the
  integration (Ryan) to read the chain — the adapter never stores a list.
- `CrashCounter` — one crash counter per task, keyed by `requestId` (D9).
  A checkpoint resets the consecutive count. At 3 consecutive crashes
  before a checkpoint the task is reported (pulsed as an anomaly to Rick
  and Yaz, with its `requestId` and the counter) and its resume is
  disabled until a Doctor decides. The spine persists the counter with
  `CRASH_COUNT_DDL` in `factory.sqlite`.
- `ExactlyOnceRegistry` — the adapter-side form of the durable
  exactly-once contract (H-P2-2): submitting twice with the same
  `requestId` returns the existing submission instead of submitting
  twice. The producer is invoked at most once per `requestId`.
- `SUBAGENTS_TOOL` — the `subagents` tool interface pinned verbatim from
  V5 `.pi/extensions/aspace-factory.ts` (name, 6 actions, 13 parameters).
- `ASPACE_TELEMETRY_CONTRACT` — NOOP context, zero exporters, ever (D5).
- `isOutboundAllowed(url, extraHosts?)` / `installOutboundGuard({ allowHosts })`
  — wraps the global `fetch` and throws `AspaceOutboundBlockedError`
  **before any network is touched** for every host outside the policy.
  Default allow-list is loopback only; telemetry/analytics hosts are
  denied even when allow-listed.
- `getFrozenRepoInfo()` / `verifyFrozenCommit()` / `verifyFrozenLineage()`
  — local git reads; the smoke test proves the frozen commit is an
  ancestor of HEAD and that `gel..HEAD` differs only inside the adapter
  directory (D1 + H-P2-1, local form) — true at the gel and after the
  adapter commit(s).

## Pinned surface

The upstream API this adapter depends on (a drift here is a design event):

- `createSession()` from `packages/durable/src/session/session.ts`
- `Harness.resume()` from `packages/durable/src/harness/harness.ts:304`
- `ConversationHandle.submit(draft, context)` with `requestId`
  (README:129-134, exactly-once)
- `submissionByRequest(conversationId, requestId)` from
  `packages/durable/src/types.ts:1013`
- `defineTask()` from `packages/durable/src/tasks.ts:4`
- `MemoryStorage` / `openNodeSqliteStorage` (storage backends)
- `NOOP_TELEMETRY_CONTEXT` (defaults in `harness.ts:220`,
  `scheduler.ts:410`, `submissions.ts:50`); `DURABLE_TELEMETRY_SCHEMA`
  (content-free, IDs only)
- `onWake` host callback (`packages/durable/src/harness/types.ts:750`)
- Extension interface: tool `subagents`, actions
  `agents`/`status`/`run`/`chain`/`send`/`resume`; imports
  `@earendil-works/pi-coding-agent` + `@earendil-works/pi-ai`
  (names preserved, D8)

## Smoke test

```sh
node --experimental-strip-types aspace-pi-adapter/smoke_test.ts
# also under a removed network namespace (zero interfaces, zero egress):
unshare -n node --experimental-strip-types aspace-pi-adapter/smoke_test.ts
```

## Telemetry

**Zero by contract.** See `pi-TELEMETRY-AUDIT.md` (evidence D-N051,
`p2/`): static scan (zero telemetry SDKs; `packages/telemetry` is a
callback contract with no exporter and no `fetch`; `packages/durable`
has no `fetch` at all) + dependency audit + execution audit (smoke
re-run under `unshare -n`: all checks local, zero egress possible).

## Divergence debt (owner: Buzz core, lane Clara / 12e)

- The durable API is **experimental** (« changes without notice between
  releases »): the 119+ commits of upstream drift since the gel may
  contain an incompatible change. The adapter pins the 1.5.0 signatures;
  a re-gel requires a review of the API changes (D1, D2).
- `factory.ps1` lines 200/227/247 carry two mixed spellings of the
  `modelPool` chain (prefixed 5 links; mixed 3 links). The integration
  corrects the intake to read the chain from `config.json` (D4).
- The `writerLock` cartography (`02_Factory/writerlock.md`) is owned by
  the spine, not the adapter: the adapter writes only inside its own
  directory (proven by the lineage check); the cartography itself is
  unchanged by this pas.
- The machine hold-outs (H-P2-3 checkpoint/reprise, H-P2-6
  hibernation/réveil, H-P2-11 boucle de crash) run on the PC, not here —
  see `p2/machine-holdouts-procedure.md` (evidence D-N051).
