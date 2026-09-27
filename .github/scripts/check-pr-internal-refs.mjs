#!/usr/bin/env node
/**
 * check-pr-internal-refs.mjs
 * Enforces CONTRIBUTING.md's "No Internal Issue References" and "Branch
 * Naming" sections, which until now were enforced only by a human reading each
 * PR. Both sections are stated in detail, with copy-paste remediation, and
 * nothing checked them — so an id in a title survived an explicit review note
 * and became a permanent commit subject.
 *
 * Export: checkInternalRefs(input) → { passed, failures }
 *
 * ## Why the prefix list is an input and not a constant
 *
 * The rule bans identifiers from *your own instance's* namespace, and this
 * repository is a fork. The canonical product's own identifier namespace is
 * `PAP-`/`PAPA-`, and the fork inherits it legitimately: on this repository's
 * master, `\b(PAP|PAPA)-[0-9]+` matches 736 files including the whole `ui/`
 * tree, because `PAP-1/child` is a canonical test fixture in
 * `cli/src/__tests__/common.test.ts` and a canonical route in 90+ files
 * (`/PAP/issues/...`). A gate written as "PET, PAP or PAPA" is born failing on
 * the product, gets disabled within a day, and a disabled gate reads as "we
 * checked". So the default list is the instance prefix alone, and a deployment
 * that wants more prefixes names them.
 *
 * ## Why there is a second, open matcher, and what it is not allowed to match
 *
 * The list above is closed by construction, and the rule text is not. It bans
 * "any `{PREFIX}-{NUMBER}` identifier that isn't a public GitHub issue number",
 * which is a shape, not a list — so a prefix nobody configured walks straight
 * through. It is not hypothetical: PR #85 merged to `master` as `1220016a0`
 * with `TASK-482` written three times in its *Steps to reproduce*, `review`
 * green, and a reviewer on github.com unable to open any of them.
 *
 * Widening `DEFAULT_INTERNAL_REF_PREFIXES` to name more prefixes does not fix
 * it, for the reason the section above already gives: every prefix added is a
 * prefix that has to be guessed, and the ones this repository does not name are
 * unbounded. The obvious alternative does not fix it either, and it is worth
 * saying why because the blocklist is easy to mistake for the principled
 * option: match the bare shape and blocklist the standard tokens it would catch
 * — `GPT-5`, `UTF-8`, `SHA-256`, `HTTP-404`, `RFC-2119`, `ISO-8601` — and the
 * filter is a property of the *vocabulary* rather than of the sentence. That is
 * the prefix list wearing different clothes, and this file's own first section
 * already condemns it: the list is unbounded, and adding the seventh entry only
 * moves the boundary.
 *
 * So the second matcher matches the shape *where an id is being used as one*.
 * That is a claim about a position, not about a shape being safe by itself, and
 * the difference is the whole reason it generalises.
 *
 * It is not a claim to have no guessing left in it. The verb tier is a closed
 * list of nine English tokens, and `supersedes`, `replaces`, `tracks`,
 * `duplicates`, `blocks` and `addresses` are all reference positions that none
 * of them match. So this trades an unbounded guessed vocabulary for a bounded
 * one — three syntactic positions times nine verbs — which is a large reduction
 * and a real improvement, but it is "much smaller", not "instead of". The
 * measurement below is what says the reduction is worth having, and the
 * motivating case is the honest limit: #85's three lines were caught by *two* of
 * the three positions, and one of those was the `issues/` path rule rather than
 * the verb list. Had the verb been the only signal, the recall would have rested
 * on the guesswork. What keeps this from being born failing is measured, not
 * argued — see "the measurement" below.
 *
 * ### the measurement
 *
 * Pinned to a range, not to a moving window: **`#37`–`#96`, 60 pull requests, as
 * read at `2026-09-27T01:41Z`**. A range is replayable; "the 60 most recent" is
 * a description of a moment that has already passed, and a reader who runs it
 * next week gets a different population with no way to tell a different answer
 * from a stale claim.
 *
 * Over that window the bare shape `[A-Z][A-Z0-9]{1,9}-\d+` applied to title and
 * body fires on **9 of the 60**. Sixteen of those hits are already covered by
 * the configured prefix list. Exactly **two** tokens reach past that list, and
 * both are the reason this matcher is not just the bare shape:
 *
 * - `GPT-5`, in four pull requests (#48, #67, #75, #87), every one of them in a
 *   **Model Used** section naming the model. A matcher that fails the pull
 *   request that documents the model which wrote it is a matcher that gets
 *   disabled within a day, and a disabled gate reads as "we checked".
 * - `PROJ-123`, in #67, where it is the *shape* of a config value being
 *   documented rather than a ticket being pointed at.
 *
 * ### the true positive is a body state that no longer exists
 *
 * The change is motivated by `TASK-482` in #85, and **that finding cannot be
 * re-derived from the API by anyone, ever again.** #85's body was sanitised at
 * `2026-09-27T00:06:39Z`, five minutes after the commit that measured it: the
 * three identifiers became prose. The audit comment on #85 is the surviving
 * record of the before state, pair by pair, and `PR85_REPRO` in the tests is a
 * faithful transcription of it.
 *
 * So the number to expect when you replay this is **zero**, not one. Over
 * `#37`–`#96` the open tier reports 0 findings, and `PR85_REPRO` still fails on
 * its own, which is the mechanism working. Zero is the correct replay result and
 * is not a regression — it is stated here so that a reader who reaches zero can
 * tell an inert matcher from an unmeasured one, which the previous wording of
 * this section left open.
 *
 * The population contaminates itself, so re-measuring has to account for it: a
 * pull request *documenting* this gate quotes the tokens the gate matches. #98's
 * own body carries `TASK-482`, `PROJ-123`, `UTF-8`, `SHA-256`, `HTTP-404` and —
 * out of the regex literal `A-Z0-9` in its own write-up — `Z0-9`. Every
 * gate-documentation pull request therefore adds tokens past the configured
 * list, which is why that set grows each time the rule is explained. Exclude
 * those deliberately when re-measuring, or expect the tail to move.
 *
 * The fix is a second condition, not a longer blocklist: the shape only counts
 * where an id is being *referred to*. Three positions qualify, and they are
 * all positions a ticket id is written into rather than mentioned in:
 *
 * - an issue-router path — `/issues/TASK-482`, `/api/issues/{TASK-482}/checkout`
 * - a `#` reference — `#TASK-482`
 * - a reference verb — `Fixes TASK-482`, `ticket TASK-482`, `see TASK-482`, and
 *   the scoped conventional-commit form `fix(shared): TASK-482`, which is this
 *   repository's dominant commit convention
 *
 * That rule is what turns 9 flagged pull requests into 0 findings on `GPT-5`,
 * `PROJ-123` and the rest, and the property worth having is that it does so
 * without the one real case going with them: `PR85_REPRO` fires, the population
 * does not. A gate that adds one true positive and zero false positives to sixty
 * real pull requests can be merged without anyone having to decide whether to
 * trust it.
 *
 * This is the same split the address rule below rests on, one level up: there,
 * prose that names `127.0.0.1` passes and a URL pointing at it fails; here,
 * prose that names `GPT-5` passes and a path pointing at `TASK-482` fails.
 *
 * ### the boundaries this matcher does not claim
 *
 * Stated as boundaries rather than left to be discovered, because each one is a
 * real case a reviewer will try:
 *
 * - **Not case-insensitive.** `utf-8`, `sha-256`, `http-404` and `gpt-5` are
 *   ordinary prose, and a case-insensitive open shape matches all four. A
 *   lowercase ticket prefix is still caught, by the configured list, which is
 *   case-insensitive precisely because it knows its prefix.
 * - **Not the compact form, on the branch name.** `fix/SHA256-digest` is a
 *   perfectly good branch name and nothing structural separates it from
 *   `fix/task482-thing`, so an open compact shape is a blocklist wearing a
 *   shape. The *configured* list is what catches `fix/pet9003-blocker-edge`,
 *   which is the compact case shape that has actually been observed on this
 *   fork. This boundary is about the open shape only: the configured `compact`
 *   matcher does scan the added-line diff, and the section below carries the
 *   measurement for that.
 * - **Not on a prepositional mention.** "the defect in TASK-482" is not a
 *   reference position, and `UTF-8` is not either. The same reason a bare
 *   `10.0.0.7` is left alone below: reaching for it fires on correct work.
 * - **Not on the diff.** 736 files on `master` carry `PAP-`/`PAPA-` legitimately.
 *   The configured list, which knows those prefixes, is what covers the diff.
 * - **Not aware of character classes.** A branch called `fix/A-Z0-9-range`
 *   matches `Z0-9` out of the middle of the range, on the branch surface, and
 *   fails. No code change: the shape cannot know it is inside a range, and a
 *   branch name is the one surface with no reference position to key on. It is
 *   listed because it is the exact string a pull request *about* this gate
 *   writes, so it is the first thing the next person tries.
 *
 * The one surface that does not require a reference position is the branch
 * name, because a branch name is not prose containing a reference — it is the
 * name, and there is no verb, no `#` and no path in it for the rules to key on.
 * The bare separated shape is measured there rather than assumed: over the 106
 * distinct branch names that have been a pull request head on this fork, as read
 * at `2026-09-27T01:41Z`, it flags none. That population grows as branches are
 * pushed, so the honest form of the claim is the instant it was read at rather
 * than a number to memorise; the conclusion has held from 84 to 106. Its one
 * cost is stated rather than hidden — a branch called
 * `fix/UTF-8-normalization` fails, and the remedy is a rename.
 *
 * ## Why the compact form is scanned in the diff as well as the branch name
 *
 * `compact` started life as a branch-name matcher: `fix/pet9002-blocker-edge` is
 * the spelling that actually lands in git, and `PET-\d+` cannot see it. The
 * added-line scan then shipped with `separated` + `link` and omitted it, which
 * left a hole in the one surface that matters most — a temp-directory prefix
 * like `fs.mkdtempSync(join(tmpdir(), "pet9004-proc-"))` is a compact identifier
 * on an added line, and the diff is where those arrive. The gate reported clean
 * over a leak of exactly the shape it exists to catch.
 *
 * Leaving `compact` out of the diff scan is defensible on its face: a bare
 * `pet\d{2,}` in a diff line is *plausibly* a coincidence, and a gate born
 * failing gets disabled within a day — after which the fork has less
 * enforcement than it has now, not more. So the matcher was measured before it
 * was wired in rather than assumed either way.
 *
 * Two measurements, both replayed against the real inputs the gate receives:
 *
 * - **Every added line in this repository's history** (4,653 commits,
 *   3,045,650 added lines): 22 matches across 9 files. Nine of them are this
 *   file and its own test, which carry the literals they search for and are
 *   exempt below. The other thirteen are real leaks — systemd unit names, six
 *   `mkdtemp`/`makeTempDir` prefixes, a deploy note naming a backup suffix.
 *   **Zero** of the 22 is a coincidence.
 * - **All 67 merged pull requests on this fork**, patch by patch as the API
 *   returns them (24,444 added lines): the scan set is a strict superset of the
 *   one that shipped, moving 16 flagged pull requests to 19. The five it newly
 *   flags contribute 10 findings, and every one is a real identifier of the
 *   kind above. **Zero** false positives.
 *
 * The predicted coincidence rate is not merely low, it is absent at this
 * scale, and the reason is the two-digit floor plus the lookbehind: a match has
 * to *begin* the token, so `abcpet12` and a hex or base64 digest cannot produce
 * one. What is left is a three-letter word followed by two or more digits with
 * nothing attached, which on this repository is a real identifier every time.
 *
 * The measurement is recorded here rather than in the change that made it so
 * that the next person to suspect a false positive can check the claim instead
 * of trusting it — the same reason the address measurements above are written
 * down. If a future commit adds `compact` hits that are coincidences, this
 * paragraph is the thing that has to be re-measured and rewritten.
 *
 * ## Instance-local addresses: why authored text only
 *
 * CONTRIBUTING.md's section also bans `localhost`, private-IP and tailnet URLs,
 * and that rule *is* checked here — but only in the text an author writes: the
 * PR title, the description, the branch name, the commit subjects and the pull
 * request comments. It is deliberately not applied to the diff or to the commit
 * message body, and the difference is the whole design.
 *
 * The evidence for the restriction is the measurement this file's identifier
 * half already records: `\b(localhost|127\.0\.0\.1)` matches 664 files on
 * master, and every one of them is the code working. A test asserting a
 * service binds `127.0.0.1` is a test doing its job; the e2e harness reaches
 * its fixtures over loopback by design. Scan the source and the gate is born
 * failing on correct work, and a gate that fails on correct work gets
 * disabled within a day — and a disabled gate reads as "we checked".
 *
 * The same string in a PR *body* is usually not correct. Nobody needs
 * `127.0.0.1` to understand a change, and a reviewer on github.com cannot use
 * the coordinate anyway. So the shape is split by surface: prose that merely
 * names the loopback interface passes, and a URL that points at it fails.
 *
 * Replayed over the 60 most recent pull requests on this fork, the matcher
 * below flags exactly two — #22 (`http://127.0.0.1:8099/v1` in the body) and
 * #25 (`http://localhost:3101/api/companies/...` in the body) — and no
 * correctly-authored body. Both are the class this rule exists for: an
 * instance coordinate, copy-pasted, permanent. The same matcher on the comment
 * surface over the 100 most recently updated pull requests adds two more, on
 * #105: `http://localhost` twice, both in the same comment.
 *
 * ### the address half stops before the commit body
 *
 * The commit message body is the one authored surface this half does not
 * reach, and the reason is the same as the diff's, arrived at separately.
 *
 * On a diff line an instance address is the code working. In a commit body it
 * is the *change* working: a commit that documents a port collision, a pinned
 * test port, a loopback smoke URL or a tailnet hostname exists in order to
 * name that address, and the remedy this gate would ask for — write the
 * endpoint as a shape — deletes the sentence that makes the commit worth
 * having. `b83e14ad` is "stop the readiness probe from stealing the guest
 * exposure port"; its body is the `127.0.0.1:42000` that collided. There is no
 * rewording that keeps that commit.
 *
 * The identifier half does not have this problem, which is why the two halves
 * diverge here rather than the rule being dropped. `PET-9001/PET-9002 were the
 * live instance of this` and `the delegation-guard issue was the live instance
 * of this` say the same thing. Rewording is always available for an identifier
 * and is never available for an address, so an identifier is a finding on every
 * authored surface and an address is a finding only on the ones that are not
 * describing one.
 *
 * The measurement, replayed over the 4670 commits on `master`: the address
 * half flags **31** commit bodies and the identifier half flags 15. All 31
 * were read, and all 31 are the case above — a pinned loopback port, a curl
 * repro, a fictional MagicDNS name, one dependabot release-notes body quoting
 * upstream's own `ws://localhost:${port}` example. None of the 15 is that
 * case. That is the whole argument for the split: the identifier half gains
 * real coverage on this surface and the address half acquires only noise.
 *
 * What the split costs is stated rather than left to be discovered: on a merge
 * or rebase, a branch commit body naming an instance address is no longer
 * flagged, because the PR description is a different string. Every other
 * authored surface keeps the half, including the commit subject — which under
 * a squash merge *is* the PR title, so the text that becomes permanent history
 * is covered on the surface it was written on and the surface it lands on.
 *
 * `agent://` is likewise a canonical product feature (structured agent
 * mentions, `packages/shared/src/project-mentions.ts`), so only `agent://`
 * followed by a configured instance prefix is treated as a link to an internal
 * issue — a bare `agent://` is not.
 *
 * ## Pull request comments: the seventh surface, and the largest one
 *
 * `CONTRIBUTING.md` names the surfaces the rule covers — "your PR title,
 * description, commits, and comments" — and every surface but one was scanned.
 * Comments were not, and the measurement of what that cost is the reason this
 * section exists. Replayed over the 100 most recently updated pull requests on
 * this fork, against this gate's own matchers, on all 367 comments they carry
 * (issue comments, inline review comments and review bodies):
 *
 * | | |
 * |---|---:|
 * | comments read | 367 |
 * | comments carrying a finding | **131** |
 * | …written by the pull request's own author | 125 |
 * | …written by somebody else | 6 (all `github-actions[bot]`) |
 * | findings this gate reports, run as shipped | 139 |
 * | open pull requests that would fail | **8 of 12** |
 *
 * This is not a tail risk found by reading the code; it is the single largest
 * concentration of unreported leaks anywhere on this repository, and the reason
 * it went unreported is the reason this section is written down: the surface
 * nobody looked at is the surface that leaks.
 *
 * Three of the 131 are the two address findings and one instance-address
 * finding on #105, on a comment the gate's own maintainer wrote the same
 * afternoon the gate shipped. The author had pasted the before/after diff
 * verbatim into a reply explaining the fix, which put the very identifiers the
 * gate had been made to reject onto the pull request that adds the gate, and
 * the gate reported `passed: true` throughout. The harness was correct and the
 * coverage was absent, which is the failure mode this surface is here to end.
 *
 * ### why a comment is the same kind of surface as a title
 *
 * The original scoping was defensible on its own terms — the rule was about
 * "text that becomes permanent history" (a squash subject) or "text that lands
 * in the tree" (a code comment), and a PR comment is neither. It is also
 * wrong, and the measurement above is what makes it wrong rather than merely
 * unfashionable: a comment on github.com is permanent, public, indexed by
 * search engines, and readable by exactly the audience the rule exists to
 * protect — a reviewer who cannot open the identifier. The `git log` argument
 * that justified excluding commit bodies does not transfer, because nobody
 * reaches a merged pull request's comment thread by reading the commit.
 *
 * So the surface is scanned, and the same three matchers apply with the same
 * reference-position requirement. A comment is prose, so `GPT-5` and
 * `PROJ-123` still pass, exactly as they do in a body.
 *
 * ### why the exemption costs nothing today and is still load-bearing
 *
 * Measured on that same population, **zero** of the 367 comments match
 * `isGateComment` — every gate comment on those 100 pull requests is a
 * "all checks passing" report, and a passing report quotes nothing. The
 * exemption is therefore unexercised by the population and indispensable the
 * moment the gate fails, which is the moment it starts quoting the literals it
 * found. A control feeds a real failing report back through the scan: as the
 * gate's own comment it passes, and the same body one login over — an agent's
 * review comment, which is what the 6 third-party findings above are — it fails.
 * That pair is the whole argument for the exclusion existing in one specific
 * form rather than another.
 *
 * ### the one comment the gate does not read: its own
 *
 * The gate's report quotes the literals it found — `` `PET-9005` `` — because
 * the author has to be able to search for them. A gate that scanned its own
 * report would therefore fail on its own output on the next run, and the
 * failure would be indistinguishable from a real leak. That is not a reason to
 * render the report in shapes instead; the literal is what makes the report
 * actionable.
 *
 * So one comment is excluded, by the predicate `isGateComment` below, and that
 * predicate is **the same one `run-quality-gates.mjs` already uses** to find
 * the comment it is about to overwrite. Both halves are required: a bot login
 * (nobody can post as `commitperclip[bot]`) and the `— commitperclip`
 * signature line. This introduces no new trust, because the orchestrator has
 * already decided that a comment matching this predicate is its own before
 * this gate runs; the only thing that changes is that the gate stops reading
 * it. The boundary is stated rather than left to be discovered: a token that
 * can post as a bot login *and* choose to write the signature can hide a leak
 * in a comment, and the way to close that is to not give agents a posting
 * token, not to widen this predicate. Note the login half is not sufficient on
 * its own — agents' own review comments reach this repository as
 * `github-actions[bot]` — and the signature half is not sufficient on its own,
 * because a human can type the signature in a comment. Measured over the 367
 * comments above, the two halves together are what separates the gate's report
 * from real content.
 *
 * ### the trap this surface creates, named in the report
 *
 * A finding in a comment the author cannot edit blocks the author on a third
 * party. That is measured, not hypothetical: 6 of the 131 findings are in
 * comments written by somebody else, and all six are agent review comments.
 * Blocking is still the right verdict — the leak is real and it is permanent,
 * and a non-blocking surface is a surface that gets no fixes — but the report
 * has to say who has to edit it, or the author is sent to a dead end. It also
 * has to say that *replying about the leak re-creates it*, which is the
 * reflex every author has after reading a finding: the next comment says "fixed
 * the PET-9005 in my last comment" and is itself a finding, forever.
 *
 * ## Failing closed
 *
 * Every way this gate can be unable to answer "does this PR leak an id?"
 * produces a failure, never a pass:
 *
 * - the prefix list resolves to nothing, or holds a malformed entry;
 * - a changed file reports line changes but carries no patch to scan, and the
 *   published content of that file did not arrive either. Both readers are
 *   tried before the gate gives up on a file, and a file it can read by either
 *   one is scanned rather than refused — see "Two readers, one rule" for why the
 *   second reader is a read and not an exemption;
 * - a patch hunk is shorter than its own header declares (GitHub truncates
 *   large diffs and the truncation is not flagged anywhere in the payload), and
 *   the whole-file read did not arrive to cover the part that was cut;
 * - the changed-file list reached GitHub's 3000-file cap;
 * - the commit list could not be fetched, so the commit-message surface was
 *   never read. The fetch is optional so a transient 5xx cannot take down the
 *   gates that do block, which is right; reading its failure as "no
 *   references found" would be the gate answering about text it never saw.
 * - the comment list could not be fetched, for the same reason and with the
 *   same consequence. This is the surface with the most findings on it, so it
 *   is the one where a silent empty list would cost the most.
 * - the comment list reached `MAX_PR_COMMENTS`, so the fetch stopped with
 *   comments unread and the surface is not fully covered.
 *
 * A gate that answers "passed" because it could not look is worse than no gate,
 * because it is evidence.
 *
 * ## Two readers, one rule
 *
 * Failing closed is not the same as refusing to read. The rule above is about
 * the gate's *knowledge* of a file, not about which HTTP call it is allowed to
 * make, and for most of this gate's life it conflated the two: a changed file
 * GitHub declined to produce a patch for was reported unscannable, full stop,
 * however readable the file plainly was.
 *
 * The cost was not hypothetical and it was not confined to one file class. A
 * drizzle migration snapshot is ~1.3 MB and ~48k changed lines, GitHub returns
 * `patch: null` for a file that size, and `AGENTS.md` section 6 tells every
 * contributor that a data-model change means running the generator — so the gate
 * refused to certify *every correct schema change on this fork*, and the
 * failure it reported ("this gate cannot certify this diff") was true and
 * useless at the same time. The obvious repairs all make the gate weaker in
 * exchange for the file being let through: a glob in `ALLOWLIST` (a trust grant
 * on a path, with a filename that changes every migration so the entry rots at
 * the next one), a blanket "generated files are fine" rule, or trusting the
 * generator's output rather than the bytes.
 *
 * So the gate grew a second reader instead of an exemption. When a patch is
 * missing or truncated, the caller fetches the file's content at the head
 * commit and hands it over, and the gate scans *that* — the whole file, in
 * full, with the same matchers, redacting the same way. Nothing is exempted
 * because of what a file is called or where it sits; a `PET-<number>` inside a
 * migration snapshot is still a finding, which is a claim the shape-proof
 * approach can only make and this one makes by having looked.
 *
 * The properties that matter, and each is enforced by a test that fails if it is
 * dropped:
 *
 * - **No verdict changes on a file that was already scannable.** The fallback
 *   only runs where the gate would otherwise have emitted "unscannable", so
 *   every patch-bearing file keeps the patch-only, added-lines-only answer it
 *   gave before.
 * - **It fails closed when the second read does not arrive.** No content, a
 *   payload over `MAX_SCANNED_FILE_BYTES`, or a payload carrying a NUL all land
 *   the file back in `unscannable`. A fetch that is allowed to fail therefore
 *   cannot turn a red into a green by being unavailable; it can only leave the
 *   verdict where it was.
 * - **It is a whole-file read, and says so.** Every line counts where the patch
 *   path counts added lines, because a whole file cannot say which lines this
 *   pull request added — and a pull request that publishes a file publishes all
 *   of it. The asymmetry is toward reporting, which is the direction the
 *   fail-closed rule already commits to.
 */
import { fileURLToPath } from 'node:url';

/** The instance prefix this repository's own board issues carry. */
export const DEFAULT_INTERNAL_REF_PREFIXES = ['PET'];

/**
 * Namespaces the open matcher must not claim, because the product owns them.
 *
 * This is an exemption, not a prefix list, and the difference is the whole
 * reason the open matcher is usable: `DEFAULT_INTERNAL_REF_PREFIXES` is
 * "identifiers I issued", and adding to it makes the gate stricter, whereas
 * every entry here makes it *looser* and therefore has to be earned. `PAP` and
 * `PAPA` are earned by the header's measurement — they are the canonical
 * product's own namespace, the fork inherits it legitimately, and 736 files on
 * `master` carry it.
 *
 * An empty or malformed list is a configuration error rather than a default,
 * because the failure mode is silent in the dangerous direction: drop the
 * entries and every honest mention of `/PAP/issues/PAP-1` in a pull request
 * body starts failing, which is how a gate acquires a reputation for noise.
 */
export const DEFAULT_PRODUCT_OWNED_PREFIXES = ['PAP', 'PAPA'];

/** GitHub's hard ceiling on a pull request's changed-file list. */
export const MAX_PR_FILES = 3000;

/**
 * The point at which the comment list stops being fully read.
 *
 * Not a documented GitHub ceiling — there is none for comments — and the bound
 * is here for the same reason `MAX_PR_FILES` is: the scan has to be bounded, and
 * a fetch that stops early must say so rather than report a clean surface over
 * the part it did read. The number is the same as the file cap so the two
 * surfaces carry the same bound, and it is four orders of magnitude above
 * anything real: the busiest pull request in the 100-pull-request population
 * above carries 13 comments across all three comment endpoints.
 */
export const MAX_PR_COMMENTS = 3000;

/**
 * The ceiling on a whole-file read used to stand in for a patch that did not arrive.
 *
 * The gate has two readers for a changed file — the unified diff GitHub returns
 * in `patch`, and the file's content at the head commit — and it used to have
 * only the first. So a file GitHub declines to produce a patch for was reported
 * as unscannable no matter how readable it actually is, and the honest verdict
 * ("this gate cannot certify this diff") became the verdict on every correct
 * change that added a large generated file. A drizzle migration snapshot is
 * 1.3 MB and about 48k changed lines, so that is every data-model change.
 *
 * The bound is on the *fallback* read only, and it fails closed like every other
 * bound here: a file above it stays unscannable rather than being sampled. It
 * sits far above any file in this repository's history that a patch would not
 * cover, and the number is quoted in the failure text so an author who hits it
 * knows the split is a real one rather than a silent limit.
 */
export const MAX_SCANNED_FILE_BYTES = 4_000_000;

/**
 * The signature the gate stamps on its own report, and the logins it posts as.
 *
 * These live here rather than in `run-quality-gates.mjs` because the gate needs
 * them to recognise its own report, and importing the orchestrator to get them
 * would be circular. `run-quality-gates.mjs` imports them back from here, so
 * there is still exactly one definition of each.
 */
export const GATE_COMMENT_SIGNATURE = '— commitperclip';

/**
 * Logins that may own the gate comment. The app identity is the norm; the extra
 * entry covers a repository where the commitperclip app is not installed and
 * the gates therefore run under the workflow's own `GITHUB_TOKEN` instead.
 */
export const GATE_COMMENT_LOGINS = ['commitperclip[bot]', 'commitperclip'];

/**
 * Whether a comment is the gate's own report, and so is not scanned.
 *
 * Both halves are required. The login half is what a human cannot forge; the
 * signature half is what separates the gate's report from an agent's own review
 * comment, since agents' comments reach this repository under the same bot
 * login. See the header's "the one comment the gate does not read" for the
 * measurement behind the split and for the boundary it does not close.
 *
 * `extraLogins` is the deployment's `GH_COMMENTER_LOGIN`, which is how the
 * orchestrator accounts for a repository that posts as a login neither list
 * names. The exemption follows the identity rather than being duplicated, so a
 * comment the orchestrator would overwrite is a comment the gate does not read.
 */
export function isGateComment(comment, extraLogins = []) {
  const login = comment?.user?.login;
  if (typeof login !== 'string') return false;
  const owners = new Set([...GATE_COMMENT_LOGINS, ...extraLogins.filter((l) => typeof l === 'string' && l)]);
  if (!owners.has(login)) return false;
  const body = comment?.body;
  return typeof body === 'string' && body.includes(GATE_COMMENT_SIGNATURE);
}

/**
 * Paths this gate never scans.
 *
 * The gate and its own test necessarily contain the literals they search for.
 * Self-exclusion is a fixed list rather than a heuristic because the set is
 * closed: adding a file here is a reviewable act, and a heuristic broad enough
 * to avoid maintenance would also be broad enough to hide a real leak.
 */
export const SELF_EXEMPT_PATHS = [
  '.github/scripts/check-pr-internal-refs.mjs',
  '.github/scripts/tests/check-pr-internal-refs.test.mjs',
];

/**
 * Paths exempt from the diff scan because they *are* the rule text and must
 * quote the banned shapes to explain them. A reason is mandatory and enforced
 * below — an allowlist entry that does not carry one is itself a failure, so
 * this list cannot grow into a quiet exemption.
 */
export const ALLOWLIST = [
  {
    path: 'CONTRIBUTING.md',
    reason: 'The rule text itself: it quotes the banned identifier and link shapes to define them.',
  },
  {
    path: '.github/PULL_REQUEST_TEMPLATE.md',
    reason: 'The rule text itself: the PR template repeats the banned shapes in its "do not include" section.',
  },
];

/**
 * The ALLOWLIST reduced to the entries that actually exempt anything.
 *
 * An entry needs both a `path` and a `reason` to exempt a file, because a
 * reason-less entry is itself reported as a failure — an exemption nobody can
 * review is not an exemption. That makes "which paths are exempt" a function of
 * the module constant rather than something each caller re-derives, and three
 * call sites need the same answer: the loop's `continue`, the whole-file fetch
 * list, and the fetch caller's own default. Left as three expressions, one of
 * them would eventually read the array and quietly restore an exemption that
 * the mandatory-reason rule exists to prevent.
 */
function allowReasonsMap() {
  return new Map(ALLOWLIST.filter((e) => e && e.path && e.reason).map((e) => [e.path, e.reason]));
}

/** Case-insensitive word boundary that also refuses to start inside a word. */
const NOT_IN_WORD = String.raw`(?<![A-Za-z0-9_])`;

/**
 * Resolves and validates the prefix list. Returns `{ prefixes }` or
 * `{ configError }`; the caller turns a config error into a failure.
 */
export function resolvePrefixes(raw) {
  // A string is the env-var shape (`PET,PAP`), an array the programmatic one.
  // Anything else is a caller error and has to surface as a failure rather than
  // as a thrown TypeError, because the gate's job here is to report, not crash.
  const source = raw === undefined || raw === null ? DEFAULT_INTERNAL_REF_PREFIXES : raw;
  const entries = Array.isArray(source) ? source : typeof source === 'string' ? source.split(',') : null;
  if (entries === null) {
    return {
      configError:
        'INTERNAL_REF_PREFIXES must be a comma-separated string or an array of prefixes, ' +
        `got ${typeof source}. Refusing to pass a scan that could not match anything.`,
    };
  }

  const list = entries
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);

  if (list.length === 0) {
    return {
      configError:
        'INTERNAL_REF_PREFIXES is set but resolved to no prefixes. Refusing to pass a scan that could not match anything — ' +
        'unset it to fall back to this instance\'s default, or name at least one valid prefix.',
    };
  }

  const bad = list.filter((entry) => !/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(entry));
  if (bad.length > 0) {
    return {
      configError:
        `INTERNAL_REF_PREFIXES holds ${bad.length === 1 ? 'an entry' : 'entries'} that cannot be an identifier prefix: ` +
        `${bad.map((e) => `"${e}"`).join(', ')}. Expected 2-10 characters, starting with a letter, letters and digits only.`,
    };
  }

  // De-duplicated case-insensitively: a list holding `pet` and `PET` twice
  // would otherwise report the same finding once per spelling.
  const seen = new Set();
  const prefixes = [];
  for (const entry of list) {
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    prefixes.push(entry);
  }

  return { prefixes };
}

/**
 * Resolves and validates the product-owned exemption list. Same contract as
 * `resolvePrefixes`: a configuration error is returned, never thrown, and the
 * caller turns it into a failure.
 */
export function resolveProductOwnedPrefixes(raw) {
  const source = raw === undefined || raw === null ? DEFAULT_PRODUCT_OWNED_PREFIXES : raw;
  const entries = Array.isArray(source) ? source : typeof source === 'string' ? source.split(',') : null;
  if (entries === null) {
    return {
      configError:
        'PRODUCT_OWNED_REF_PREFIXES must be a comma-separated string or an array of prefixes, ' +
        `got ${typeof source}. Refusing to run a matcher whose exemptions cannot be read.`,
    };
  }

  const list = entries.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  if (list.length === 0) {
    return {
      configError:
        'PRODUCT_OWNED_REF_PREFIXES is set but resolved to no prefixes. That would make every ' +
        'mention of the product\'s own `PAP-`/`PAPA-` namespace a failure, including the canonical ' +
        'route shape. Unset it, or name at least one prefix.',
    };
  }

  const bad = list.filter((entry) => !/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(entry));
  if (bad.length > 0) {
    return {
      configError:
        `PRODUCT_OWNED_REF_PREFIXES holds ${bad.length === 1 ? 'an entry' : 'entries'} that cannot be an ` +
        `identifier prefix: ${bad.map((e) => `"${e}"`).join(', ')}. Expected 2-10 characters, starting with ` +
        'a letter, letters and digits only.',
    };
  }

  const seen = new Set();
  const owned = [];
  for (const entry of list) {
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    owned.push(key);
  }

  return { owned };
}

/**
 * Builds the matchers for one prefix.
 *
 * Two shapes per prefix, because the identifier is written both ways and a
 * branch-name check that only knows the separated form misses the one shape
 * that actually lands in git: `fix/pet9002-blocker-edge-one-way-door` carries
 * no hyphen after the prefix at all, so `PET-\d+` cannot see it.
 */
function buildMatchers(prefixes) {
  const alternation = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join('|');
  return {
    // `PET-9001`, `#PET-9001`, `/PET-9001`
    separated: new RegExp(`${NOT_IN_WORD}(${alternation})-\\d+\\b`, 'gi'),
    // `pet9002-blocker`, `pet9002_blocker`, `pet9002`. Two digits minimum: with no
    // separator a single trailing digit is far more likely to be a coincidence.
    // The floor used to be measured, not argued — the sweep that removed the
    // real compact-form occurrences found eleven on master, all in temp-dir
    // prefixes, throwaway systemd unit names and a deploy note. It is stated as
    // a judgement now because that measurement is zero. Read the zero narrowly:
    // it is a property of one tree at one moment, not of the rule. Eleven sat
    // on master past the sweep that cleared the separated spelling, and four of
    // them arrived *after* a first cut of this cleanup had already rebased, so
    // the same claim made one commit earlier was false. The separated form also
    // still has one live occurrence this cleanup does not touch — a branch
    // name in .github/workflows/e2e-service-leg.yml, where renaming the ref
    // would break the workflow that names it. "Zero" means this matcher, this
    // spelling, this tree.
    // Scanned on the added-line diff as well as the branch name — see the
    // while it was absent.
    compact: new RegExp(`${NOT_IN_WORD}(${alternation})\\d{2,}\\b`, 'gi'),
    // `/PET/issues/...`, `/PET/agents/...`, `agent://PET`
    link: new RegExp(
      String.raw`(?<![A-Za-z0-9_])(?:/(${alternation})/(?:issues|agents|documents)\b|(?:agent|issue|document)://(${alternation})\b)`,
      'gi',
    ),
  };
}

function findAll(text, pattern) {
  const found = new Set();
  // Fresh lastIndex per call: these module-level-free patterns are rebuilt per
  // call, but `exec` in a loop is still stateful if a caller ever hoists one.
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.add(match[0]);
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  return [...found];
}

/**
 * `findAll`, but keyed on the first capture group rather than the whole match.
 *
 * The open-shape rules match more than the identifier — `issues/PAP-224` is a
 * path segment plus an id, and `#TASK-482` is a sigil plus an id — and the
 * exemption check has to see the id alone. Returning `match[0]` would compare
 * `issues/PAP` against a list of prefixes, never match, and report the
 * product's own namespace as a leak.
 */
function findAllCaptured(text, pattern) {
  const found = new Set();
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    found.add(match[1] ?? match[0]);
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  return [...found];
}

/**
 * The open identifier shape, and the three positions a reference goes.
 *
 * `OPEN_SHAPE` is deliberately not case-insensitive and carries no `i` flag, so
 * the verb alternation below spells both cases by hand. Adding `i` here would
 * silently make `[A-Z]` match `[a-z]` and the matcher would start claiming
 * `utf-8` and `sha-256` — see the header's boundaries.
 */
const OPEN_SHAPE = String.raw`[A-Z][A-Z0-9]{1,9}-\d+\b`;

/**
 * The bare separated shape, with no reference-position requirement.
 *
 * Used on exactly one surface — the branch name. A branch name is not prose
 * with a reference in it; it *is* the name, so there is no verb, no `#` and no
 * path for the reference rules to key on, and `fix/TASK-482-unbound-target`
 * would otherwise pass. Measured over the 96 distinct branch names that have
 * been a pull request head on this fork, this shape flags none of them, so the
 * one cost it carries is theoretical: a branch named `fix/UTF-8-normalization`
 * fails, and the remedy is to rename the branch, which costs nothing before the
 * branch is pushed and nothing after.
 *
 * The compact form stays out on every surface. `fix/SHA256-digest` is a
 * perfectly good branch name and nothing structural separates it from
 * `fix/task482-thing`; the configured list already catches the instance's own
 * lowercase prefix, which is the case that has actually been observed.
 */
const OPEN_SHAPE_LOOSE = new RegExp(String.raw`${NOT_IN_WORD}(${OPEN_SHAPE})`, 'g');


/**
 * The gap between a reference verb and the id it refers to.
 *
 * Authors quote the id they have just named, so the reference is usually
 * written `` `TASK-482` `` or `"TASK-482"`, and a matcher that insists on a
 * single space misses the form that actually appears — that gap is what made
 * the first cut of the verb rule read #85 as clean. Held as a plain string
 * because it contains a backtick, which cannot appear unescaped inside the
 * template literal the rules themselves are written in.
 *
 * The class opens `(` and closes it again. That is the scoped
 * conventional-commit prefix, which is this repository's dominant commit
 * convention, so `fix(shared): TASK-482` is the single most likely subject this
 * rule is ever asked about: `fix:` fires and `fix(shared):` was silent. An
 * unbalanced class reads as an oversight rather than a decision, so it is
 * balanced on purpose and both forms are pinned in the tests.
 */
const REF_GAP = "[: #`\"'(){\\[]*";

const OPEN_REF_RULES = [
  // `/issues/TASK-482`, `POST /api/issues/{TASK-482}/checkout`. The `{$?` is a
  // URL template placeholder, which is how #85 wrote the step the finding is
  // about: a reader copying that curl gets a shell brace, not an issue.
  new RegExp(String.raw`\b(?:issues|agents|documents)/[{]?(?:\$\{)?(${OPEN_SHAPE})`, 'g'),
  // `#TASK-482`. A `#` followed by a space is a Markdown heading and is not
  // matched; `#123` is a public GitHub reference and has no prefix to match.
  new RegExp(String.raw`(?<![A-Za-z0-9_])#(${OPEN_SHAPE})`, 'g'),
  // `Fixes TASK-482`, `ticket TASK-482`, `see TASK-482`.
  //
  // The optional group is the conventional-commit scope, and it is here because
  // the gap class alone cannot do the job. `fix(shared): TASK-482` is not a gap
  // problem: the class matches one character at a time, and the scope *name*
  // sits between the two parens, so balancing the class without this group
  // leaves the form silent — and this is the dominant commit convention in the
  // repository, so it is the most likely input the verb tier ever gets. The
  // scope body excludes whitespace, so a prose aside in parentheses
  // (`the fix (see TASK-482)`) is still not a reference position.
  new RegExp(
    String.raw`\b(?:[Ff]ix(?:e[sd])?|[Cc]los(?:e[sd])?|[Rr]ef(?:s|erenced)?|[Ss]ee|[Tt]ickets?|[Tt]asks?|[Bb]ugs?)\b(?:\([A-Za-z0-9_./-]+\))?${REF_GAP}(${OPEN_SHAPE})`,
    'g',
  ),
];

/**
 * Every `{PREFIX}-{NUMBER}` reference in one string whose prefix this
 * deployment has not accounted for, de-duplicated.
 *
 * `owned` is the resolved product-owned list from `resolveProductOwnedPrefixes`;
 * `alreadyFound` is what the configured-prefix matchers already reported on the
 * same surface, and it is subtracted here so that one id is one finding even
 * when both tiers can see it. The second half of that is not cosmetic: the
 * conventional-commit prefix `fix:` is also a reference verb, so a title
 * reading `fix: PET-9003` is visible to both matchers, and an author who fixed
 * one identifier and got two paragraphs about it learns to skip the gate.
 *
 * `requireReference: false` drops the reference-position condition, and is used
 * on the branch-name surface only. See `OPEN_SHAPE_LOOSE`.
 *
 * `maskInlineCode: true` is the commit-body surface, and it is the whole of the
 * fix for the open tier's path rule on bodies: see `maskInlineCodeSpans` for
 * the rule, the three-commit measurement it came from and the one case it
 * deliberately leaves failing. Titles, descriptions, comments and branch names
 * do not set it — none of them is a document whose topic is a URL shape.
 */
/**
 * The path-shaped rule, and the reason a commit body is the one surface that
 * runs it against text with inline code spans removed.
 *
 * An inline code span is a *quotation of a token or a shape*, and a commit body
 * is the one authored surface where quoting one is the entire point of the
 * commit. Replayed over the 4678 commits on `origin/master`, the bare-path rule
 * fired on six bodies, and two of the six are that case and cannot be reworded
 * around:
 *
 * - `bc0a076e` *stop linking foreign tracker keys as Paperclip issues* — the
 *   body is the rule about the token: "That renderer auto-links any
 *   `IDENT-123`-shaped token to an internal `/issues/IDENT-123` link".
 * - `d6bee62f` *Cloud tenant issue identifier routes* — the body is the bug
 *   report: "`/api/issues/PC1897-1` skipped identifier lookup and fell through".
 *
 * A third, `af0e05f3` *onboarding wizard navigates to dashboard*, names the
 * path outside any code span ("(e.g. /JAR/issues/JAR-1)"), and deliberately
 * still fails: it is a bare path in running prose, which is the form a reader
 * could paste, and the remedy for it is to genericise the id
 * (`/JAR/issues/<id>`) rather than to escape a code span. One commit in 4678 is
 * a different proposition from three in six.
 *
 * Fenced blocks are NOT masked, whether the fence is backticks or a tilde. A
 * fenced block is a runnable artifact and a `/issues/TASK-482` inside one is a
 * path a reviewer can paste, which is the case the rule exists for; masking
 * ```` ```\nPOST /api/issues/TASK-482/checkout\n``` ```` would have been a
 * false negative in the exact shape the rule is written for.
 *
 * @param {string} text
 * @returns {string} the same text, same length and same line breaks, with the
 *   contents of every inline code span replaced by spaces. Fenced regions are
 *   returned untouched.
 */
export function maskInlineCodeSpans(text) {
  if (typeof text !== 'string' || !text.includes('`')) return text;
  const n = text.length;
  const out = text.split('');
  // The start of the line containing `i`, so "does this run open a line" is a
  // question about the characters between the two rather than a regex that has
  // to know about newlines.
  const lineStartOf = (i) => {
    let k = i - 1;
    while (k >= 0 && text[k] !== '\n') k--;
    return k + 1;
  };
  const isFenceAt = (i, run) => run >= 3 && text.slice(lineStartOf(i), i).trim() === '';

  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch !== '`' && ch !== '~') { i++; continue; }
    let open = 0;
    while (text[i + open] === ch) open++;

    // A fence: skip the whole region, masked or not. The closing fence is the
    // next line-opening run of the same character and the same minimum length.
    if (isFenceAt(i, open)) {
      let j = i + open;
      let end = n;
      while (j < n) {
        if (text[j] === ch) {
          let run = 0;
          while (text[j + run] === ch) run++;
          if (isFenceAt(j, run)) { end = j + run; break; }
          j += run;
          continue;
        }
        j++;
      }
      i = end;
      continue;
    }

    // A tilde that is not a fence is ordinary text and is left for the `i++`
    // below; only a backtick run can open an inline code span.
    if (ch !== '`') { i += open; continue; }

    // An inline span. CommonMark lets a longer run close a shorter one, so the
    // closing run is the next run of at least the same length.
    let j = i + open;
    let close = 0;
    while (j < n) {
      if (text[j] !== '`') { j++; continue; }
      let run = 0;
      while (text[j + run] === '`') run++;
      if (run >= open) { close = run; break; }
      j += run;
    }
    if (j >= n) { i += open; continue; } // unterminated: not a span
    for (let k = i + open; k < j; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
    i = j + close;
  }
  return out.join('');
}

export function findUnknownInternalRefs(
  text,
  owned = DEFAULT_PRODUCT_OWNED_PREFIXES,
  alreadyFound = [],
  { requireReference = true, maskInlineCode = false } = {},
) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const exempt = new Set(owned.map((p) => p.toLowerCase()));
  const seen = new Set(alreadyFound.map((h) => String(h).toLowerCase()));
  const found = new Set();
  const masked = maskInlineCode ? maskInlineCodeSpans(text) : text;
  // Each rule is paired with the text it reads. Only the path rule (index 0)
  // reads the masked text; the verb and `#` rules keep the original, so a
  // `` `Closes TASK-482` `` in a code span is still a finding. The exemption is
  // about a *path being quoted as a shape*, not about code spans being a general
  // escape hatch, and keeping the other two rules on the original text is what
  // stops it from becoming one.
  const rules = requireReference
    ? OPEN_REF_RULES.map((rule, i) => [rule, i === 0 && maskInlineCode ? masked : text])
    : [[OPEN_SHAPE_LOOSE, text]];
  for (const [rule, source] of rules) {
    for (const hit of findAllCaptured(source, rule)) {
      const prefix = hit.slice(0, hit.lastIndexOf('-'));
      if (exempt.has(prefix.toLowerCase())) continue;
      if (seen.has(hit.toLowerCase())) continue;
      found.add(hit);
    }
  }
  return [...found];
}

/**
 * The instance-local hosts this gate knows how to name.
 *
 * Split by why each entry is here, because the two groups are treated
 * differently below and conflating them is what makes this rule unusable:
 *
 * - loopback and RFC1918 (`127.0.0.0/8`, `::1`, `10/8`, `172.16/12`,
 *   `192.168/16`): the address space a single-node instance lives in. None of
 *   it routes anywhere public, so a body that names it is naming one machine.
 * - `100.64.0.0/10`: the CGNAT block Tailscale hands out. A tailnet node is
 *   routinely addressed by its `100.x` address, so the tailnet rule is not
 *   only about MagicDNS names.
 * - `localhost`: the name, and the one people paste.
 * - `0.0.0.0`: the wildcard bind, which is a *target* in a URL and a *socket
 *   description* in prose. The distinction matters, so it appears in one
 *   matcher and not the other (see `HOST_WITH_PORT`).
 * - `*.ts.net`: MagicDNS. No legitimate appearance in a public PR body.
 */
const INSTANCE_HOST = String.raw`(?:localhost|127\.(?:\d{1,3}\.){2}\d{1,3}|\[::1\]|10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|[A-Za-z0-9-]+(?:-[A-Za-z0-9-]+)*\.ts\.net|0\.0\.0\.0)`;

/** Schemes whose authority component is a host: the http family, the wire
 *  protocols an instance is reached over, and the URL schemes that appear in
 *  a config snippet. `file:` is absent on purpose — a `file://` path is a local
 *  filesystem path, not an instance coordinate. */
const URL_SCHEME = String.raw`(?:https?|wss?|ssh|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|grpc|git\+https?)`;

/**
 * A host in the authority of a URL: `http://localhost:3101/api/...`.
 *
 * The optional `user:pass@` is consumed so that a credentialed DSN
 * (`postgres://agent:hunter2@10.0.0.7:5432/paperclip`) reports the address
 * rather than stopping at the userinfo.
 */
const HOST_IN_URL = new RegExp(
  String.raw`\b${URL_SCHEME}://(?:[^\s/@]+@)?${INSTANCE_HOST}`,
  'gi',
);

/**
 * A bare authority: `localhost:3101`, `192.168.1.20:8080`.
 *
 * `host:port` with no scheme is a URL reference in every reading — it is the
 * authority form, and a reader copies it into a browser. The lookbehind refuses
 * to start inside a word, a path or a dotted name, which also keeps this
 * matcher from re-reporting the `localhost` that `HOST_IN_URL` already
 * reported (that one is preceded by `//`).
 *
 * `0.0.0.0` is the one host excluded here and kept in `HOST_IN_URL`. "The unit
 * binds 0.0.0.0:3100" is a true and load-bearing sentence about a socket, and
 * this repository has a whole class of pull requests that need to say it;
 * "curl http://0.0.0.0:3100" is a client reaching for an instance. A wildcard
 * is a description in one position and a target in the other.
 */
const HOST_WITH_PORT = new RegExp(
  String.raw`(?<![\w./-])(?:localhost|127\.(?:\d{1,3}\.){2}\d{1,3}|\[::1\]|10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}|[A-Za-z0-9-]+(?:-[A-Za-z0-9-]+)*\.ts\.net):\d{1,5}\b`,
  'gi',
);

/**
 * A MagicDNS name with no scheme and no port: `box.tail1234.ts.net`.
 *
 * Unqualified, because there is no reading of a tailnet hostname in a public
 * PR body that is not a leak, and requiring a scheme around it would let the
 * bare form through.
 */
const TAILNET_NAME = new RegExp(String.raw`\b[A-Za-z0-9-]+\.ts\.net\b`, 'gi');

/**
 * Every instance-local address reference in one string, de-duplicated.
 *
 * Exported for the tests and for any caller that wants the finding without the
 * surrounding report text. A bare `localhost` in prose is deliberately not a
 * match — see the header's note on why the shape is split by surface.
 */
export function findInstanceHosts(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  return [
    ...new Set([...findAll(text, HOST_IN_URL), ...findAll(text, HOST_WITH_PORT), ...findAll(text, TAILNET_NAME)]),
  ];
}

/** True when the line is the added half of a unified-diff body. */
function isAddedLine(line) {
  return line.startsWith('+') && !line.startsWith('+++');
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Decides whether a unified diff was fully delivered.
 *
 * GitHub truncates the patch it returns for a large diff and puts nothing in
 * the payload to say so. The truncation is still detectable, because a hunk
 * header declares exactly how many body lines follow it. A hunk that ends
 * early has been cut. The alternative — trusting that what arrived is what
 * changed — is a gate that reports "no internal references" about code it
 * never read.
 */
export function patchIsComplete(patch) {
  const lines = patch.split('\n');
  let declared = null;

  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      declared = {
        old: header[2] === undefined ? 1 : Number(header[2]),
        next: header[4] === undefined ? 1 : Number(header[4]),
        seenOld: 0,
        seenNext: 0,
      };
      continue;
    }
    if (declared === null) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    // An empty string is not a unified-diff body line. A real empty context
    // line is a single space. The trailing '' that `split` leaves after a
    // final newline is the common case, and counting it as context would pad
    // the last hunk back up to its declared size and hide every truncation.
    if (line.length === 0) continue;
    if (line.startsWith('+')) declared.seenNext += 1;
    else if (line.startsWith('-')) declared.seenOld += 1;
    else declared.seenOld += 1, declared.seenNext += 1;
  }

  if (declared === null) return { complete: true };

  return {
    complete: declared.seenOld >= declared.old && declared.seenNext >= declared.next,
  };
}

/**
 * Whether the diff scan will look inside this file at all.
 *
 * The two exemption lists and the loop's own `continue` are one decision, so they
 * are one function here. It is also what keeps the whole-file fetch honest: an
 * exempt file's content is never read by the gate, so fetching it would spend an
 * API request and a 1.3 MB transfer on bytes the run then throws away. That is
 * not a hypothetical on this repository — this gate's own test file is exempt,
 * is 113,621 bytes, and arrives without a patch, so a fetch list that ignored
 * the exemption would read the largest file in every pull request that edits
 * this gate and discard it.
 *
 * The *name* of an exempt file is still scanned. That check sits above the
 * exemption in the loop and needs no content, which is why this predicate is
 * about the content read only.
 *
 * `allowed` is the same `Map` the loop builds rather than the raw `ALLOWLIST`,
 * and the difference is load-bearing: an entry with no `reason` is itself
 * reported as a failure a few lines away, and it must go on exempting nothing.
 * Reading the array here would have made a malformed entry quietly restore an
 * exemption, which is the one thing the "a reason is mandatory" rule exists to
 * prevent.
 */
export function isContentExempt(filename, allowed = allowReasonsMap()) {
  return SELF_EXEMPT_PATHS.includes(filename) || allowed.has?.(filename) === true;
}

/**
 * Whether this changed file cannot be read from its patch alone.
 *
 * This is the gate's own test for "I will have to say unscannable", exported so
 * the orchestrator can go and get the file instead of re-deriving the rule. The
 * two answers have to be one answer: a caller that re-implemented this predicate
 * would drift from the gate, and the drift would be silent in the safe-looking
 * direction — a file the gate considers readable but the fetch skipped, which is
 * the current behaviour, reappearing under a new name.
 *
 * The two cases are the ones `patchIsComplete` and the null-patch branch already
 * name: no patch at all where line changes are reported, and a patch that was
 * cut short. A file with no patch and no line changes is a binary or a pure
 * rename, which is a true negative and never needs a fetch.
 */
export function fileNeedsWholeContent(file) {
  const changes = typeof file?.changes === 'number' ? file.changes : 0;
  const patch = typeof file?.patch === 'string' ? file.patch : null;
  if (patch === null) return changes > 0;
  return !patchIsComplete(patch).complete;
}

/**
 * The filenames in a changed-file list the gate will not be able to read.
 *
 * Deleted files are excluded and it is not an oversight: there is no content at
 * the head commit for a path the pull request removes, so a fetch for one can
 * only ever come back empty. A removal carries no added lines either, so there
 * is nothing to scan and nothing to fail closed about.
 *
 * Content-exempt files are excluded for the reason `isContentExempt` gives: the
 * gate will not look inside them, so reading them buys nothing.
 */
export function filesNeedingWholeContent(files, allowed = allowReasonsMap()) {
  const names = [];
  for (const file of files ?? []) {
    const filename = file?.filename;
    if (typeof filename !== 'string' || filename === '') continue;
    if (file?.status === 'removed') continue;
    if (isContentExempt(filename, allowed)) continue;
    if (!fileNeedsWholeContent(file)) continue;
    names.push(filename);
  }
  return names;
}

/**
 * The file's content, if it is readable, in range, and shaped like text.
 *
 * Three refusals, each of which lands the caller back on "unscannable" rather
 * than on a partial scan: no entry for this path, a payload above
 * `MAX_SCANNED_FILE_BYTES`, and a payload carrying a NUL. The last is not
 * paranoia — the content endpoint returns base64 for a path GitHub considers
 * binary, and handing that to a UTF-8 text scan would produce a finding about
 * base64 that means nothing, or a decode error in the middle of a gate run.
 */
export function wholeFileContent(fileContents, filename) {
  const content = fileContents?.[filename];
  if (typeof content !== 'string' || content === '') return null;
  if (Buffer.byteLength(content, 'utf8') > MAX_SCANNED_FILE_BYTES) return null;
  if (content.includes('\u0000')) return null;
  return content;
}

/**
 * The one character a match is replaced with in anything this gate prints.
 *
 * U+2588 is a single UTF-16 code unit, which is what makes a mask of
 * `REDACTION_CHAR.repeat(n)` the same length as the `n`-character hit it
 * replaces. Every offset, every column and every "the preview is 72 characters
 * wide" claim in the report survives redaction. A fixed-width marker like
 * `[REDACTED]` would have been shorter than the text it replaced and silently
 * shifted every offset after the match, which is the whole reason the finding
 * quotes a preview at all.
 */
const REDACTION_CHAR = '█';

/**
 * Replace every occurrence of every matched string with an equal-length mask.
 *
 * This gate scans pull request comments — a surface it then writes findings
 * onto. When the finding text reproduced the match, the remediation comment was
 * itself a comment carrying the reference, so the next run found it and posted
 * again: a self-amplifying loop that pins the gate red on any pull request it
 * has ever fired on, and trains reviewers to expect a false positive here.
 * Measured on pull request 131 during one review: 3, then 4, then 6, then 8
 * matched strings across four runs, with every increment coming from a
 * remediation comment and none from an author edit.
 *
 * The mask is applied to the whole assembled finding rather than to each
 * interpolations site, so a leak is closed wherever it arises: the `↳ found in`
 * preview, a surface label that quotes its own text (the branch-name finding
 * interpolates the branch), and any remedy text added later. A per-site fix
 * closes the three sites known today and leaves the fourth open.
 *
 * Longest hit first, because hits can nest — `TASK-1` is a prefix of `TASK-12`
 * — and masking the short one first would leave a stray digit where the long one
 * used to be. The example is spelled in a prefix the fixture floor below does
 * not scan, for the same reason every other fixture in this file is: a literal
 * in this instance's own namespace is a real coordinate the moment somebody
 * copies it, and this file is deliberately exempt from the gate that would
 * catch that.
 *
 * @param {string} text  the assembled finding
 * @param {Iterable<string>} hits  every string this finding matched
 * @returns {string} `text` with each match masked, same length
 */
export function redactMatches(text, hits) {
  if (typeof text !== 'string' || text === '') return text;
  const ordered = [...new Set(hits)]
    .filter((h) => typeof h === 'string' && h.length > 0)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const hit of ordered) {
    out = out.split(hit).join(REDACTION_CHAR.repeat(hit.length));
  }
  return out;
}

/**
 * @param {object} input
 * @param {string} input.prTitle
 * @param {string} input.prBody
 * @param {string} input.prBranch
 * @param {Array<{commit?: {message?: string}, sha?: string}>} [input.commits]
 * @param {boolean} [input.commitsUnavailable]  the commit fetch failed; the
 *   commit-message surface was therefore not scanned at all
 * @param {Array<object>} [input.files]  entries of `/pulls/{n}/files`
 * @param {Record<string, string>} [input.fileContents]  the published content of
 *   the files in `files` whose patch the API did not deliver, keyed by
 *   `filename`. The second reader; see `filesNeedingWholeContent` for which
 *   files the caller is expected to have fetched, and the diff loop for what
 *   happens when one is absent.
 * @param {string|string[]|undefined} [input.prefixes]
 * @param {string|string[]|undefined} [input.productOwnedPrefixes]
 * @returns {{passed: boolean, failures: string[], wholeFileScans: string[]}}
 */
export function checkInternalRefs({
  prTitle = '',
  prBody = '',
  prBranch = '',
  commits = [],
  commitsUnavailable = false,
  comments = [],
  commentsUnavailable = false,
  commentLogins = [],
  files = [],
  fileContents = {},
  prefixes,
  productOwnedPrefixes,
} = {}) {
  const { prefixes: resolved, configError } = resolvePrefixes(prefixes);
  if (configError) return { passed: false, failures: [configError], wholeFileScans: [] };

  const { owned, configError: ownedError } = resolveProductOwnedPrefixes(productOwnedPrefixes);
  if (ownedError) return { passed: false, failures: [ownedError], wholeFileScans: [] };

  const { separated, compact, link } = buildMatchers(resolved);
  const prefixLabel = resolved.map((p) => `${p}-<number>`).join(', ');
  const failures = [];

  /**
   * The only way this gate is allowed to put a finding into `failures`.
   *
   * Every rule below reports through this, so the "a finding never prints what
   * it matched" property is enforced once instead of at each call site — see
   * `redactMatches` for why the loop that makes this necessary is not a style
   * problem. The findings pushed directly (unscannable surfaces, the comment
   * cap, the prefix-config error) are not routed here: they are not matches
   * and there is nothing of theirs to redact.
   */
  const finding = (text, hits) => {
    failures.push(redactMatches(text, hits));
  };

  /**
   * How many distinct strings a finding matched, phrased without naming any of
   * them. This replaces an enumeration of the matched strings: the count is
   * what the author acts on, and the shape is recoverable from
   * `prefixLabel`, which is genericised to `PET-<number>` at the point it is
   * built.
   */
  const countOf = (hits) => {
    const n = new Set(hits).size;
    return `${n} internal issue identifier${n === 1 ? '' : 's'}`;
  };

  // A surface the run could not read is not a surface that is clean. The
  // commit list is fetched separately from the pull payload and is allowed to
  // fail, so an empty list is ambiguous: it means either "this pull request
  // has no commits", which cannot happen, or "the fetch failed". Reporting
  // `passed: true` off the second reading is the one thing this gate must
  // never do — it is a claim about text the run never saw.
  //
  // This is the same principle as the truncated-patch and 3000-file-cap
  // handling below, which already refuse to claim a clean scan.
  if (commitsUnavailable) {
    failures.push(
      'The commit list could not be read, so the commit-message surface was not scanned and this result is not a ' +
      'clean scan. The `/pulls/{n}/commits` fetch is allowed to fail so that a transient 5xx cannot take down ' +
      'the gates that do block; the cost is that this gate then has nothing to read. Re-run the gate once the ' +
      'API is reachable. Do not read `passed: true` here as "no internal references found".'
    );
  }

  const report = (surface, location, hits, extra = '') => {
    finding(
      `${surface} carries ${countOf(hits)}` +
      `${prefixLabel ? ` (prefixes: ${prefixLabel})` : ''} — ` +
      'internal issue identifiers from this instance\'s namespace. ' +
      'CONTRIBUTING.md ("No Internal Issue References") bans \`{PREFIX}-{NUMBER}\` that is not a public GitHub issue number, ' +
      'because a reviewer on github.com cannot open it. Restate the context in plain English instead.' +
      (extra ? ` ${extra}` : ''),
      hits
    );
    if (location) {
      finding(`  ↳ found in ${location}`, hits);
    }
  };

  /**
   * The instance-local-address half of the same rule, on the same four
   * authored surfaces and nowhere else.
   *
   * Its own report text, because the fix is not "restate the context in plain
   * English" — a reviewer can read `http://<host>:<port>` perfectly well. The
   * fix is to write the endpoint as a shape instead of an address, and the
   * failure has to say that or the author removes the sentence instead.
   */
  const hostReport = (surface, location, text, extra = '') => {
    const hits = findInstanceHosts(text);
    if (hits.length === 0) return;
    const n = new Set(hits).size;
    finding(
      `${surface} carries ${n} instance-local address${n === 1 ? '' : 'es'} — ` +
      'addresses that resolve to one machine, not to a repository. ' +
      'CONTRIBUTING.md ("No Internal Issue References") bans `localhost`, private-IP and tailnet URLs ' +
      'pointing at your own instance, because a reviewer on github.com has no route to them. ' +
      'Write the endpoint as a shape — `scheme://<host>:<port>` — and say what it is, not where it happened to run.' +
      (extra ? ` ${extra}` : ''),
      hits
    );
    if (location) {
      finding(`  ↳ found in ${location}`, hits);
    }
  };

  /**
   * The open-shape half of the same rule, on the same four authored surfaces.
   *
   * Its own report text, because this finding is a different mistake from a
   * configured-prefix finding and the fix is different. A `PET-` id is a
   * coordinate from this instance's board. An unconfigured `TASK-482` is the
   * same mistake made by a tool whose namespace nobody here configured, and the
   * only way to write the body correctly is to stop pointing at the ticket
   * altogether — so the failure has to say that, or the author adds a second
   * prefix to the config and the hole moves rather than closes.
   */
  const unknownReport = (surface, location, text, owned, alreadyFound, extra = '', options = {}) => {
    const hits = findUnknownInternalRefs(text, owned, alreadyFound, options);
    if (hits.length === 0) return;
    const n = new Set(hits).size;
    finding(
      `${surface} refers to ${n} issue identifier${n === 1 ? '' : 's'} in a namespace this repository has no exemption for. ` +
      'CONTRIBUTING.md ("No Internal Issue References") bans `{PREFIX}-{NUMBER}` that is not a public GitHub ' +
      'issue number, because a reviewer on github.com cannot open it. Restate what the issue was in plain ' +
      'English and delete the reference.' +
      (extra ? ` ${extra}` : ''),
      hits
    );
    if (location) {
      finding(`  ↳ found in ${location}`, hits);
    }
  };

  // --- Surface 1: PR title -------------------------------------------------
  const titleHits = [...findAll(prTitle, separated), ...findAll(prTitle, compact), ...findAll(prTitle, link)];
  if (titleHits.length > 0) {
    report('The PR title', null, titleHits,
      'A squash merge takes the PR title as the commit subject, so this becomes permanent history and cannot be cleaned up afterwards without a rewrite.');
  }
  unknownReport('The PR title', null, prTitle, owned, titleHits,
    'A squash merge takes the PR title as the commit subject, so this becomes permanent history and cannot be cleaned up afterwards without a rewrite.');
  hostReport('The PR title', null, prTitle,
    'A squash merge takes the PR title as the commit subject, so an instance address in a title is permanent history.');

  // --- Surface 2: PR body --------------------------------------------------
  const bodyHits = [...findAll(prBody, separated), ...findAll(prBody, compact), ...findAll(prBody, link)];
  if (bodyHits.length > 0) {
    report('The PR description', null, bodyHits,
      'The description should carry the reasoning, not the coordinates of a ticket nobody outside this instance can open.');
  }
  unknownReport('The PR description', null, prBody, owned, bodyHits,
    'A repro step is where these arrive, because the id is the one part of the step a reader cannot reconstruct. Say what the issue was, not what number it had here.');
  hostReport('The PR description', null, prBody,
    'A curl line or a config snippet pasted verbatim is where these arrive: the endpoint is the one thing a reader cannot reconstruct.');

  // --- Surface 3: branch name ---------------------------------------------
  const branchHits = [...findAll(prBranch, separated), ...findAll(prBranch, compact)];
  if (branchHits.length > 0) {
    report(`The branch name \`${prBranch}\``, null, branchHits,
      'CONTRIBUTING.md ("Branch Naming") asks for a name describing the change, and ships the rename snippet for exactly this case.');
  }
  // No reference-position requirement here, and only here: a branch name has
  // no verb, no `#` and no path to key on, so the reference rules would never
  // fire and `fix/TASK-482-unbound-target` would pass.
  unknownReport(`The branch name \`${prBranch}\``, null, prBranch, owned, branchHits,
    'CONTRIBUTING.md ("Branch Naming") asks for a name describing the change, and ships the rename snippet for exactly this case.',
    { requireReference: false });
  hostReport(`The branch name \`${prBranch}\``, null, prBranch,
    'A branch name is published on the PR and outlives the merge.');
  // On this surface the address rule can only ever fire on a bare `.ts.net`
  // name, and that is a property of git rather than of the matchers.
  // `git check-ref-format` rejects a refname containing `:`, `@{`, or `//`, so
  // every shape `HOST_IN_URL` and `HOST_WITH_PORT` exist to catch — an
  // authority, a credentialed DSN, a spelled-out URL — is unrepresentable in a
  // branch name. Relaxing the path lookbehind for this surface therefore buys
  // nothing and reads as though it does. Measured over the 84 branch names that
  // have ever been a head on this fork, the branch surface reported 16
  // findings, and all 16 were identifiers. The address shapes a branch *can*
  // carry are the bare ones, which the header's second exclusion declines on
  // purpose: `fix/10.0.0.7-rebind` describes a change accurately and a hyphen
  // is how a branch name separates its words, so reading `-8099-` as a port
  // would mean matching most names with three digits in them.

  // --- Surface 4: commit messages, subject and body -----------------------
  // A squash collapses the branch into the PR title, but a merge or a rebase
  // preserves these messages whole, and a reviewer reading `git log` before
  // merging reads the body today, not just the subject.
  //
  // The body is scanned for identifiers, and the identifier half applies to it
  // as it does to every other authored surface. The address half does not —
  // see the note where the body scan is written, and the header's "the address
  // half stops before the commit body".
  //
  // This is not hypothetical. The three identifier literals that the gate
  // reported `passed: true` alongside sat in commit bodies on the branch that
  // shipped this gate, and the gate could not see them, because it read
  // `split('\n')[0]` and stopped there.
  //
  // Subject and body are reported as separate surfaces so the remedy matches
  // the defect: a subject is reworded with `git rebase -i`, and a body is
  // edited in place on the commit. An author who fixed the id in their subject
  // and got told to reword the subject learns to skip the gate.
  const SUBJECT_REMEDY =
    'Rewrite the subject (`git rebase -i`, `reword`); a merged subject is permanent history.';
  const BODY_REMEDY =
    'Edit the commit message on the commit itself (`git rebase -i`, `reword`, or the "Edit" button on ' +
    'the commit page); a merged message is permanent history.';

  // One pass builds the subject list, because the open tier has to be handed
  // the configured tier's hits *for the same subject*. `fix:` is a reference
  // verb, so a conventional-commit type that is also a verb is visible to both
  // matchers; without the handoff the author gets two paragraphs, and the
  // second is false — it calls a namespace this repository has an exemption for
  // one it has none for. `alreadyFound` is subtracted, so one id is one finding
  // on every surface.
  //
  // The Map is keyed by the subject text and iterated in insertion order: the
  // key is what makes two commits that share a subject one finding rather than
  // two, and the order is what the report reads for its location. Keying on the
  // text rather than on the index is deliberate — `git rebase -i` and a rebase
  // -merge both replay a whole series of `fix: <same subject>`, and that is the
  // common case, not the exotic one.
  const subjects = new Map();
  for (const commit of commits ?? []) {
    const message = commit?.commit?.message;
    if (typeof message !== 'string') continue;
    const firstLine = message.split('\n')[0];
    if (subjects.has(firstLine)) continue;
    subjects.set(firstLine, [...findAll(firstLine, separated), ...findAll(firstLine, compact)]);
  }
  const commitHits = [...subjects.values()].flat();
  if (commitHits.length > 0) {
    const first = [...subjects.entries()].find(([, hits]) => hits.length > 0);
    report('A commit subject', first?.[0].trim().slice(0, 80), commitHits, SUBJECT_REMEDY);
  }
  for (const [firstLine, hits] of subjects) {
    // Re-derived here rather than carried from a per-commit loop: the one-pass
    // shape above no longer binds a `location`, and the two calls below both
    // need one. Omit it and the file still parses and the suite still passes —
    // the address check on this surface just stops firing.
    const location = firstLine.trim().slice(0, 80);
    unknownReport('A commit subject', location, firstLine, owned, hits, SUBJECT_REMEDY);
    if (findInstanceHosts(firstLine).length > 0) {
      hostReport('A commit subject', location, firstLine, SUBJECT_REMEDY);
    }
  }

  // The body, on the identifier half only. `lines.slice(1)` deliberately
  // excludes the subject, so one identifier in the subject is one finding and
  // not two.
  //
  // The address half stops before this surface, and the reason is the one the
  // header states for the diff: a commit body is where an instance address is
  // usually the *subject matter*. `b83e14ad` is "stop the readiness probe from
  // stealing the guest exposure port" and its body is the sentence describing
  // the `127.0.0.1:42000` that collided. There is no rewording that keeps that
  // commit, which is the test the address half fails and the identifier half
  // passes — "the delegation-guard issue was the live instance" loses nothing,
  // "the loopback port was the live instance" is not the same commit. Measured
  // over the 4670 commits on `master`, the address half flags 31 bodies and
  // every one of them is that case; the identifier half's bodies are real ids.
  // See the header's "the address half stops before the commit body".
  //
  // What that costs, stated rather than assumed: a branch commit body naming an
  // instance address on a merge or rebase PR is no longer flagged, because the
  // PR description is a different string. Every other authored surface keeps
  // the half — title, description, branch, and the commit subject, which under
  // a squash merge *is* the PR title, so the string that becomes permanent
  // history is still covered on both the surface it is written on and the
  // surface it lands on.
  //
  // Same one-pass shape as the subject, and for the same reason: the open tier
  // needs the configured tier's hits *for this body*. A body that says
  // `chore: tidy\n\ncarries on from the configured prefix` is visible to both
  // matchers exactly as the subject is, and handing the open tier an empty
  // `alreadyFound` there produces the same second, false paragraph this surface
  // was split off to avoid. The split that #105 made is subject-versus-body for
  // the *remedy*; it is not a licence for the two surfaces to disagree about
  // de-duplication.
  const bodies = new Map();
  for (const commit of commits ?? []) {
    const message = commit?.commit?.message;
    if (typeof message !== 'string') continue;
    const body = message.split('\n').slice(1).join('\n');
    if (!body.trim()) continue;
    if (bodies.has(body)) continue;
    const sha = commit?.sha ? String(commit.sha).slice(0, 8) : 'a commit';
    bodies.set(body, {
      hits: [...findAll(body, separated), ...findAll(body, compact)],
      location: `${sha}: ${body.trim().slice(0, 72)}`,
    });
  }
  const commitBodyHits = [...bodies.values()].flatMap((b) => b.hits);
  if (commitBodyHits.length > 0) {
    const first = [...bodies.values()].find((b) => b.hits.length > 0);
    report('A commit message body', first?.location, commitBodyHits, BODY_REMEDY);
  }
  for (const [body, { hits, location }] of bodies) {
    // The one surface that masks inline code spans before the open tier reads
    // it. See `maskInlineCodeSpans`.
    unknownReport('A commit message body', location, body, owned, hits, BODY_REMEDY, { maskInlineCode: true });
  }

  // --- Surface 5: pull request comments ------------------------------------
  //
  // The surface `CONTRIBUTING.md` names and the gate did not read, and the one
  // that carries the most findings on this repository by a wide margin: 131 of
  // 367 comments across the 100 most recently updated pull requests. The header
  // section "Pull request comments: the seventh surface" has the table and the
  // reasoning; what is here is the scan.
  //
  // One surface, three report shapes, because the caller has flattened the
  // three comment endpoints (issue comments, inline review comments, review
  // bodies) into one list and a finding has to name which kind it came from.
  // Each comment is reported on its own rather than pooled: the remedy is
  // "edit that comment", and a pooled finding with one location tells the
  // author to go and find which of four comments the gate meant.
  if (commentsUnavailable) {
    failures.push(
      'The comment list could not be read, so the comment surface was not scanned and this result is not a clean scan. ' +
      'The comment fetch is allowed to fail so that a transient 5xx cannot take down the gates that do block; the cost ' +
      'is that this gate then has nothing to read. Re-run the gate once the API is reachable. This is the surface ' +
      'with the most findings on it on this repository, so it is the one where a silent empty list would cost the ' +
      'most. Do not read `passed: true` here as "no internal references found".'
    );
  }
  if (comments.length >= MAX_PR_COMMENTS) {
    failures.push(
      `The comment list reached this gate's ${MAX_PR_COMMENTS}-comment cap, so the comment surface could not be ` +
      'fully scanned. This gate reports failure rather than a clean result it did not earn. Close or resolve the ' +
      'outdated comments, or raise MAX_PR_COMMENTS deliberately.'
    );
  }

  const COMMENT_REMEDY =
    'Edit the comment on github.com (every comment is editable, and the edit is what removes the reference). ' +
    '**Do not reply about the leak** — a reply that quotes the identifier is itself a comment carrying it, so it ' +
    'becomes a new finding on the next run. If the comment is not yours, you cannot edit it: ask the person who ' +
    'wrote it, and the finding stays until they do.';

  for (const comment of comments ?? []) {
    const body = comment?.body;
    if (typeof body !== 'string' || !body.trim()) continue;
    // The one exclusion, and it is an identity rather than a path: see the
    // header's "the one comment the gate does not read". `SELF_EXEMPT_PATHS`
    // does not grow, because a comment has no path.
    if (isGateComment(comment, commentLogins)) continue;

    const kind = typeof comment.kind === 'string' && comment.kind ? comment.kind : 'comment';
    const author = typeof comment.user?.login === 'string' && comment.user.login ? comment.user.login : 'an unknown author';
    const where = typeof comment.html_url === 'string' && comment.html_url ? comment.html_url : null;
    // The location carries the author and the link, because the two cases the
    // author has to act on are different and the finding has to tell them
    // apart: a comment of theirs they can edit in a click, and a comment of
    // somebody else's they cannot.
    const article = /^[aeiou]/i.test(kind) ? 'an' : 'a';
    const location = `${article} ${kind} by ${author}${where ? ` (${where})` : ''}: "${body.trim().slice(0, 72).replace(/\s+/g, ' ')}"`;

    const hits = [...findAll(body, separated), ...findAll(body, compact), ...findAll(body, link)];
    if (hits.length > 0) {
      report('A pull request comment', location, hits, COMMENT_REMEDY);
    }
    unknownReport('A pull request comment', location, body, owned, hits, COMMENT_REMEDY);
    hostReport('A pull request comment', location, body, COMMENT_REMEDY);
  }

  // --- Surface 6: the diff, and the paths it touches -----------------------
  //
  // The instance-address rule stops here, on purpose. 664 files on master use
  // `localhost` in the e2e and dev surface, and a test that asserts a service
  // binds `127.0.0.1` is the code working. A diff line is where the address is
  // usually the subject matter. Only the identifier half of the rule applies to
  // the diff — and the address half's other two stopping points are this one
  // and the commit body, each for the same reason reached separately. See the
  // header's "the address half stops before the commit body".

  const allowReasons = allowReasonsMap();
  const allowless = ALLOWLIST.filter((e) => !e || !e.path || !e.reason);
  if (allowless.length > 0) {
    failures.push(
      `The gate's own ALLOWLIST has ${allowless.length} entry that carries no \`path\`/\`reason\` pair, so it cannot be ` +
      'reviewed. Every exemption must state why the path is exempt. Remove the entry or give it a reason.'
    );
  }

  if (files.length >= MAX_PR_FILES) {
    failures.push(
      `The changed-file list reached GitHub's ${MAX_PR_FILES}-file cap, so the diff could not be fully scanned. ` +
      'This gate reports failure rather than a clean result it did not earn. Split the change.'
    );
  }

  const diffHits = [];
  const diffLocations = [];
  const unscannable = [];
  // The files the patch could not carry, which the caller's whole-content read
  // covered instead. Reported when something is found in one, so an author
  // reading a finding in a file the gate admits it could not see as a diff knows
  // the line it is pointed at is a line in the published file rather than in
  // the change.
  const wholeFileScans = [];

  /**
   * Scan a published file's whole content, and say so in the location.
   *
   * Every line counts, where the patch path counts only added lines, and the
   * asymmetry is the safe direction: a whole-file read cannot know which lines
   * this pull request added, and a file the pull request publishes publishes
   * all of it. The only files that reach here are files the gate would otherwise
   * have refused to certify, so this can turn a hard failure into a scan and
   * never the reverse — no file that is scannable from its patch today changes
   * verdict.
   */
  const scanWholeFile = (filename, content, reason) => {
    wholeFileScans.push(filename);
    for (const line of content.split('\n')) {
      const hits = [...findAll(line, separated), ...findAll(line, link), ...findAll(line, compact)];
      if (hits.length === 0) continue;
      diffHits.push(...hits);
      diffLocations.push(
        `\`${filename}\` (${reason}): ${line.trim().slice(0, 72)}`
      );
    }
  };

  for (const file of files ?? []) {
    const filename = file?.filename ?? '(unnamed)';
    // A file's own name is part of the change and can carry the id, which is
    // how `pet9002-blocker-edge-one-way-door.test.ts` reached the tree. A rename
    // publishes its new name, so the path is checked even where the *content*
    // is exempt — which is why this sits above the exemption checks.
    const pathHits = [...findAll(filename, separated), ...findAll(filename, compact)];
    if (pathHits.length > 0) {
      diffHits.push(...pathHits);
      diffLocations.push(`the file name \`${filename}\` (status \`${file?.status ?? 'unknown'}\`)`);
    }

    // The gate and its test contain the literals they search for, and the rule
    // text has to quote the banned shapes to define them. Both are exempt from
    // the *content* scan only: an id in a PR title still fails regardless. The
    // predicate is the exported one, so the whole-file fetch and this `continue`
    // cannot disagree about which files are ever looked inside.
    if (isContentExempt(filename, allowReasons)) continue;

    const changes = typeof file?.changes === 'number' ? file.changes : 0;
    const patch = typeof file?.patch === 'string' ? file.patch : null;
    const whole = wholeFileContent(fileContents, filename);

    if (patch === null) {
      // No patch with no reported line changes is a binary file or a pure
      // rename: there is no text to scan, which is a true negative.
      if (changes > 0) {
        if (whole === null) {
          unscannable.push(`${filename} (${changes} changed lines, no patch in the API response)`);
        } else {
          scanWholeFile(filename, whole, 'whole file, the patch was not delivered');
        }
      }
      continue;
    }

    const completeness = patchIsComplete(patch);
    if (!completeness.complete) {
      if (whole === null) {
        unscannable.push(`${filename} (patch truncated by the GitHub API)`);
      } else {
        // A cut-short patch is still worth reading — it is the start of the
        // change — but only alongside the whole file, because a partial read is
        // the case this gate refuses to certify.
        for (const line of patch.split('\n')) {
          if (!isAddedLine(line)) continue;
          const hits = [...findAll(line, separated), ...findAll(line, link), ...findAll(line, compact)];
          if (hits.length === 0) continue;
          diffHits.push(...hits);
          diffLocations.push(`${filename}: ${line.replace(/^\+/, '').trim().slice(0, 80)}`);
        }
        scanWholeFile(filename, whole, 'whole file, the patch was truncated');
        continue;
      }
    }

    for (const line of patch.split('\n')) {
      if (!isAddedLine(line)) continue;
      const hits = [...findAll(line, separated), ...findAll(line, link), ...findAll(line, compact)];
      if (hits.length === 0) continue;
      diffHits.push(...hits);
      diffLocations.push(`${filename}: ${line.replace(/^\+/, '').trim().slice(0, 80)}`);
    }
  }

  if (diffHits.length > 0) {
    report('The diff', diffLocations[0], diffHits,
      'A code comment lands in the tree permanently and reads as a public reference; say what the defect was, not which ticket it came from.');
  }

  if (unscannable.length > 0) {
    failures.push(
      `The diff could not be completely scanned, so this gate cannot certify it. ` +
      `${unscannable.length} changed file${unscannable.length === 1 ? '' : 's'} arrived without readable patch content ` +
      'and this run could not read the published file either: ' +
      `${unscannable.slice(0, 5).map((u) => `\`${u}\``).join(', ')}${unscannable.length > 5 ? ` (and ${unscannable.length - 5} more)` : ''}. ` +
      'Reported as a failure because "no internal references found" is a claim this run cannot make. ' +
      `A file larger than ${MAX_SCANNED_FILE_BYTES} bytes is not read whole, so a generated file at that size needs a smaller ` +
      'form to be certifiable — split it, or reduce what the change publishes.'
    );
  }

  return { passed: failures.length === 0, failures, wholeFileScans };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkInternalRefs({
    prTitle: process.env.PR_TITLE ?? '',
    prBody: process.env.PR_BODY ?? '',
    prBranch: process.env.PR_BRANCH ?? '',
    commits: JSON.parse(process.env.PR_COMMITS ?? '[]'),
    commitsUnavailable: process.env.PR_COMMITS_UNAVAILABLE === '1',
    comments: JSON.parse(process.env.PR_COMMENTS ?? '[]'),
    commentsUnavailable: process.env.PR_COMMENTS_UNAVAILABLE === '1',
    files: JSON.parse(process.env.PR_FILES ?? '[]'),
    fileContents: JSON.parse(process.env.PR_FILE_CONTENTS ?? '{}'),
    prefixes: process.env.INTERNAL_REF_PREFIXES,
    productOwnedPrefixes: process.env.PRODUCT_OWNED_REF_PREFIXES,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
