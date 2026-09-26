# Shadowed Server Installs

Operational note about a control plane whose `node_modules` no longer matches the release it reports — because someone edited the installed files in place. Written after finding it on the `default` dev plane on 2026-09-25, where two unrelated unreleased patches had been applied directly to the live `@paperclipai/server` dist.

Pairs with [dev-plane-restart-hygiene.md](./dev-plane-restart-hygiene.md), which covers the other way a dev plane stops matching its source: restarts that kill in-flight runs.

This document is about the *installed files*. For the unit file — a different `ExecStart`, a lost `Environment=` key, a restart that skipped the preflight run-set recording — see [shadowed-service-unit.md](./shadowed-service-unit.md), which is the unit-side counterpart and ends where this one starts: by resolving the `ExecStart` target and handing off to the diff below.

## Why this matters

A packaged install is normally the ground truth we stop reasoning about. `paperclipai --version` says a version, `package.json` says a version, and `node_modules/@paperclipai/server/dist` is assumed to be that release. **Nothing verifies that**, and hand-editing the installed files breaks it while leaving every version string intact.

Three consequences, in increasing order of badness:

1. **Triage against the wrong code.** Behaviour observed on the instance cannot be reproduced from the release it claims to be, or from `master`. Every attempt to explain the observed behaviour against tagged or merged code is reasoning about the wrong artifact, and will keep producing confident, wrong root causes.
2. **An `npm install` silently deletes the work.** A reinstall, a version bump, or a rebuild restores the released files and every in-place patch with them, with no error. The instance then gets worse and the regression looks unrelated to the deploy that caused it.
3. **Unreviewed code sits in the control plane's critical paths.** The write gate and the embedded-Postgres supervisor are exactly the places you least want unreviewed drift: both are enforced continuously, both are hard to reason about from the outside, and rolling either back changes behaviour for every agent on the plane at once.

The tell is that **the patch leaves a scar**: a hand-edited install almost always keeps the file it replaced next to the file it replaced it with.

## The fingerprint

A shadowed install is easy to miss and cheap to detect. The tell is a **behaviour or error string that the reported release does not contain**.

On the `default` plane, agent writes were being refused with:

```json
{
  "code": "cross_issue_influence_run_context_required",
  "details": { "reason": "no_context_source_and_target_unbound" }
}
```

The published `@paperclipai/server@2026.916.1` has no `reason` field on that error at all — its gate throws a bare `crossIssueInfluenceRunContextError()`. So **any report carrying a `details.reason` from this gate proves the reporting instance is not running the release it claims.** Treat the string as evidence about the instance, not just about the bug.

## Detection

Compare the installed artifact against the published tarball for the version the instance reports, and look for backup scars. The version string alone cannot detect this.

```bash
# 1. What the instance claims to be, and what it is actually running.
paperclipai --version
ps -o pid,lstart,cmd -C node | grep paperclipai    # packaged install, not a git checkout

# 2. Locate the install root, then pull the published artifact for that exact
#    version. `npm root -g` is the reliable form; resolving the bin symlink and
#    stripping its `dist/` also works, since the entrypoint is <root>/dist/index.js.
VER=$(paperclipai --version)
ROOT="$(npm root -g)/paperclipai"
DIST="$ROOT/node_modules/@paperclipai/server/dist"
REL="https://registry.npmjs.org/@paperclipai/server/-/server-$VER.tgz"
curl -sSL -o /tmp/srv.tgz "$REL" && tar xzf /tmp/srv.tgz -C /tmp

# 3. Compare. Identical dist => the install matches the release.
diff -rq /tmp/package/dist "$DIST"

# 4. Look for scars. A hand-edited install usually kept the file it replaced
#    next to the file it replaced it with.
find "$DIST" \( -name '*.pre-*' -o -name '*.bak-*' \) -printf '%TY-%Tm-%Td %TH:%TM  %f\n' | sort
```

For a targeted check on one subsystem, diff a single file and grep for markers the release should not have:

```bash
F=services/cross-issue-influence-limit.js
diff "/tmp/package/dist/$F" "$DIST/$F"
grep -c targetIsBound "$DIST/$F"   # 0 on the release
```

If `diff` is non-empty, find out what the install actually is **before changing anything about it**, and recover the released original from the backup file rather than assuming you can reconstruct it:

```bash
# The .bak/.pre file is the released original; diff it against the live file to
# read the patch, then port it to source and merge that instead of the dist.
diff "$DIST/services/cross-issue-influence-limit.js.bak-<ts>" \
     "$DIST/services/cross-issue-influence-limit.js"
```

Then trace the patch back to source so it can be reviewed and merged:

```bash
git log --all -S '<marker string>' --oneline -- server/src/services/<file>.ts
git branch -a --contains <commit>
```

## What was found on `default`

Instance `default`, server pid 2416922, `node ~/.npm-global/bin/paperclipai run --instance default`, cwd `/home/petrouil`. Reported version `2026.916.1`; the published tarball for that version is the baseline, and **two unrelated patches had been applied directly to the installed dist**.

### The scars

```bash
find "$(npm root -g)/paperclipai/node_modules/@paperclipai/server/dist" -name '*.pre-*' -o -name '*.bak-*'
```

Eight `.pre-pet110-20260925T171750Z` files and two `.bak-20260925T002012Z` files, all carrying an on-disk mtime of 00:57Z — the timestamp embedded in each name records when its patch was cut, which is not when the file was last written. Each is byte-identical to the published release, so the backups are trustworthy originals and the patch can be read as a clean diff against them. `diff -rq` against the published tarball reported 18 differing or extra files across two unrelated subsystems.

### Patch 1 — embedded-Postgres shutdown intent (00:57Z)

`embedded-postgres-supervisor.js` and `index.js` gained a shutdown-intent mark and an `onControlledExit` path: distinguish PostgreSQL exiting `code=0` with no signal during a requested shutdown from a crash, so a unit using `KillMode=control-group` does not get its own requested stop read as an unexpected exit and relaunched. Also renames `shuttingDown` to `shutdownIntent` and tracks instances stopped via a local `stop()` in `instancesRequestedToStop`. Note this edited the **top-level `index.js` entrypoint** as well as the supervisor.

### Patch 2 — cross-issue write gate (00:20Z)

`services/cross-issue-influence-limit.js` gained a `TERMINAL_HEARTBEAT_RUN_STATUSES` set, a `reason` parameter on `crossIssueInfluenceRunContextError` emitting `malformed_run_id`, `run_not_found`, and `no_context_source_and_target_unbound`, and `status: heartbeatRuns.status` added to the run select. That in turn let a run-binding fallback trust an issue's `checkoutRunId` / `executionRunId` **only while the run is not terminal**. The published release has no `reason` field and refuses any run with no source issue outright.

At the time this was written neither patch was on `master`, and the second matched commits on the then-unmerged branch `fix/cross-issue-influence-target-binding-v2` (73784955c "key run-bound fallback on the target issue", f80a08c00 "name the failing gate in the 403 details"). **Both have since been reviewed and merged, so `master` now carries them** — see "What replaced the hand-patch" below. The history matters because the stale version of this line is what makes a fork build look unusable: read it, and the only remaining option appears to be a published channel, which is the regression this section exists to prevent.

The gate patch is a **strict improvement** on the released behaviour. The release refuses every write from a task-less run outright, because a run with no source issue in its context snapshot has nothing to attribute the write to; the patched build lets such a run write to the one issue it is actually bound to and counts the rest against the cap. That improvement is why the plane had not been obviously broken — it was quietly running better than its version number claimed, which is what makes this failure mode durable. It is also why the first symptom of it was a *wrong diagnosis* rather than an outage: the instance's refusals did not match anything reproducible from the release, so the cause got attributed to the wrong subsystem.

## What replaced the hand-patch

Both patches are merged on `master` and the installed dist still carries them only as hand-edits, so the instance is now *behind its own fork*: a build of `master` contains the hand-patches **plus** fixes the published releases never carried.

That inverts the usual reinstall advice, so it is worth stating as a measurement rather than a conclusion. Unpacking each published channel and grepping the three subsystems:

| channel | version | malformed-JSON `400` | run-bound cross-issue fallback | database shutdown latch |
| --- | --- | --- | --- | --- |
| `latest` | `2026.916.1` | no | **no** | **no** |
| `beta` | `2026.921.0-beta.1` | yes | **no** | **no** |
| `canary` | `2026.926.0-canary.4` | yes | **no** | **no** |
| `nightly` | `2026.926.0-nightly.0` | yes | **no** | **no** |
| build of this fork's `master` | — | yes | yes | yes |

The two `no` columns under "run-bound fallback" and "shutdown latch" are not an older build of the fix; they are **absent from every published channel**, because both were written here and never released upstream. So on this plane an `npm i -g` of any channel — stable, beta, canary or nightly — is a **regression**: it deletes ten scar files and reinstates a write gate that fails closed for every task-less run. Rule 4 below is about not reinstalling by reflex; this is the case where reinstalling is worse than the shadowing.

`node scripts/check-running-build-drift.mjs` reports all three columns for a given dist, and additionally prints the retained-original files, so "present" and "durably present" are never conflated. Its exit code covers the first column only, on purpose: a hand-edited install is a fact about the plane, not a deploy finding.

```bash
# What the server is actually running, fix by fix, plus whether a reinstall would undo it.
node scripts/check-running-build-drift.mjs

# The same question about a build you have not installed yet.
node -e 'import("./scripts/check-running-build-drift.mjs").then(async m => {
  const { execFileSync } = await import("node:child_process");
  process.exit(m.runCheck({
    distRoot: process.argv[1],
    git: (a) => execFileSync("git", a, { cwd: process.cwd(), encoding: "utf8" }),
  }));
})' /path/to/server/dist
```

A gap between the two is the deploy decision, and it is a per-channel question, not a per-version one. Measure it; do not infer it from a version number.

## Rules of thumb

1. **A version string is a claim, not a check.** Before debugging instance behaviour, diff the installed `dist` against the published tarball for that version, look for `.pre-*` / `.bak-*` scars, and run `scripts/check-running-build-drift.mjs` for the fix-by-fix answer. Ten seconds, and it tells you whether you are reasoning about real code.
2. **Never patch `node_modules`.** If unreleased work must run on a dev plane, build and install a tarball from a named commit so the whole change set is one auditable unit, and record that commit in the instance's notes. Hand-editing a dist makes the change invisible to review, unreproducible, and one `npm install` from gone.
3. **Back up outside the tree.** A `cp file file.bak-<ts>` inside `dist/` is a useful forensic marker, but it also means the release comparison reports extra files and the patch can be silently reverted by a reinstall. Keep originals in scratch, not in the artifact you are shipping.
4. **Do not "repair" a shadowed install by reinstalling** before deciding what you are keeping. `npm i -g` reverts the gate to released behaviour — fail-closed for every task-less run, no reason codes — so the instance gets *worse* and the 403s return looking like a regression from the fix. Merge the branch or accept released behaviour; choose deliberately. On a plane whose hand-patches have since merged, the correct move is the other way round: install a build of the fork that already contains them, and measure the channel matrix above before assuming a published channel can.
5. **Treat new error strings as instance evidence.** When a 403 or 500 carries a `details.reason` or code you cannot find in the release, suspect the instance before you suspect your reading of the bug.
6. **Ship authorization-path code through review before it runs.** The write gate is the worst place for unreviewed drift: continuously enforced, externally hard to reason about, and reverted globally by any reinstall.
