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
 * master, `\b(PAP|PAPA)-[0-9]+` matches 734 files including the whole `ui/`
 * tree, because `PAP-1/child` is a canonical test fixture in
 * `cli/src/__tests__/common.test.ts` and a canonical route in 90+ files
 * (`/PAP/issues/...`). A gate written as "PET, PAP or PAPA" is born failing on
 * the product, gets disabled within a day, and a disabled gate reads as "we
 * checked". So the default list is the instance prefix alone, and a deployment
 * that wants more prefixes names them.
 *
 * ## Instance-local addresses: why authored text only
 *
 * CONTRIBUTING.md's section also bans `localhost`, private-IP and tailnet URLs,
 * and that rule *is* checked here — but only in the text an author writes: the
 * PR title, the description, the branch name, the commit subjects. It is
 * deliberately not applied to the diff, and the difference is the whole
 * design.
 *
 * The evidence for the restriction is the measurement this file's identifier
 * half already records: `\b(localhost|127\.0\.0\.1)` matches 664 files on
 * master, and every one of them is the code working. A test asserting a
 * service binds `127.0.0.1` is a test doing its job; the e2e harness reaches
 * its fixtures over loopback by design. Scan the source and the gate is born
 * failing on correct work, and a gate that fails on correct work gets
 * disabled within a day — and a disabled gate reads as "we checked".
 *
 * The same string in a PR *body* is never correct. Nobody needs `127.0.0.1` to
 * understand a change, and a reviewer on github.com cannot use the coordinate
 * anyway. So the shape is split by surface: prose that merely names the
 * loopback interface passes, and a URL that points at it fails.
 *
 * Replayed over the 60 most recent pull requests on this fork, the matcher
 * below flags exactly two — #22 (`http://127.0.0.1:8099/v1` in the body) and
 * #25 (`http://localhost:3101/api/companies/...` in the body) — and no
 * correctly-authored body. Both are the class this rule exists for: an
 * instance coordinate, copy-pasted, permanent.
 *
 * `agent://` is likewise a canonical product feature (structured agent
 * mentions, `packages/shared/src/project-mentions.ts`), so only `agent://`
 * followed by a configured instance prefix is treated as a link to an internal
 * issue — a bare `agent://` is not.
 *
 * ## Failing closed
 *
 * Every way this gate can be unable to answer "does this PR leak an id?"
 * produces a failure, never a pass:
 *
 * - the prefix list resolves to nothing, or holds a malformed entry;
 * - a changed file reports line changes but carries no patch to scan;
 * - a patch hunk is shorter than its own header declares (GitHub truncates
 *   large diffs and the truncation is not flagged anywhere in the payload);
 * - the changed-file list reached GitHub's 3000-file cap.
 *
 * A gate that answers "passed" because it could not look is worse than no gate,
 * because it is evidence.
 */
import { fileURLToPath } from 'node:url';

/** The instance prefix this repository's own board issues carry. */
export const DEFAULT_INTERNAL_REF_PREFIXES = ['PET'];

/** GitHub's hard ceiling on a pull request's changed-file list. */
export const MAX_PR_FILES = 3000;

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
 * Builds the matchers for one prefix.
 *
 * Two shapes per prefix, because the identifier is written both ways and a
 * branch-name check that only knows the separated form misses the one shape
 * that actually lands in git: `fix/pet392-blocker-edge-one-way-door` carries
 * no hyphen after the prefix at all, so `PET-\d+` cannot see it.
 */
function buildMatchers(prefixes) {
  const alternation = prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join('|');
  return {
    // `PET-123`, `#PET-123`, `/PET-123`
    separated: new RegExp(`${NOT_IN_WORD}(${alternation})-\\d+\\b`, 'gi'),
    // `pet392-blocker`, `pet392_blocker`, `pet392`. Two digits minimum: with no
    // separator a single trailing digit is far more likely to be a coincidence,
    // and on master the compact form has exactly two occurrences, both real.
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
 * @param {object} input
 * @param {string} input.prTitle
 * @param {string} input.prBody
 * @param {string} input.prBranch
 * @param {Array<{commit?: {message?: string}}>} [input.commits]
 * @param {Array<object>} [input.files]  entries of `/pulls/{n}/files`
 * @param {string|string[]|undefined} [input.prefixes]
 * @returns {{passed: boolean, failures: string[]}}
 */
export function checkInternalRefs({
  prTitle = '',
  prBody = '',
  prBranch = '',
  commits = [],
  files = [],
  prefixes,
} = {}) {
  const { prefixes: resolved, configError } = resolvePrefixes(prefixes);
  if (configError) return { passed: false, failures: [configError] };

  const { separated, compact, link } = buildMatchers(resolved);
  const prefixLabel = resolved.map((p) => `${p}-<number>`).join(', ');
  const failures = [];

  const report = (surface, location, hits, extra = '') => {
    const listed = [...new Set(hits)].slice(0, 8).map((h) => `\`${h}\``).join(', ');
    failures.push(
      `${surface} carries ${listed}${hits.length > 8 ? ` (and ${hits.length - 8} more)` : ''} — ` +
      `internal issue identifier${hits.length > 1 ? 's' : ''} from this instance's namespace. ` +
      `CONTRIBUTING.md ("No Internal Issue References") bans \`{PREFIX}-{NUMBER}\` that is not a public GitHub issue number, ` +
      `because a reviewer on github.com cannot open it. Restate the context in plain English instead.` +
      (extra ? ` ${extra}` : '')
    );
    if (location) {
      failures.push(`  ↳ found in ${location}`);
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
    const listed = [...hits].slice(0, 8).map((h) => `\`${h}\``).join(', ');
    failures.push(
      `${surface} carries ${listed}${hits.length > 8 ? ` (and ${hits.length - 8} more)` : ''} — ` +
      'an address that resolves to one machine, not to a repository. ' +
      'CONTRIBUTING.md ("No Internal Issue References") bans `localhost`, private-IP and tailnet URLs ' +
      'pointing at your own instance, because a reviewer on github.com has no route to them. ' +
      'Write the endpoint as a shape — `scheme://<host>:<port>` — and say what it is, not where it happened to run.' +
      (extra ? ` ${extra}` : '')
    );
    if (location) {
      failures.push(`  ↳ found in ${location}`);
    }
  };

  // --- Surface 1: PR title -------------------------------------------------
  const titleHits = [...findAll(prTitle, separated), ...findAll(prTitle, compact), ...findAll(prTitle, link)];
  if (titleHits.length > 0) {
    report('The PR title', null, titleHits,
      'A squash merge takes the PR title as the commit subject, so this becomes permanent history and cannot be cleaned up afterwards without a rewrite.');
  }
  hostReport('The PR title', null, prTitle,
    'A squash merge takes the PR title as the commit subject, so an instance address in a title is permanent history.');

  // --- Surface 2: PR body --------------------------------------------------
  const bodyHits = [...findAll(prBody, separated), ...findAll(prBody, compact), ...findAll(prBody, link)];
  if (bodyHits.length > 0) {
    report('The PR description', null, bodyHits,
      'The description should carry the reasoning, not the coordinates of a ticket nobody outside this instance can open.');
  }
  hostReport('The PR description', null, prBody,
    'A curl line or a config snippet pasted verbatim is where these arrive: the endpoint is the one thing a reader cannot reconstruct.');

  // --- Surface 3: branch name ---------------------------------------------
  const branchHits = [...findAll(prBranch, separated), ...findAll(prBranch, compact)];
  if (branchHits.length > 0) {
    report(`The branch name \`${prBranch}\``, null, branchHits,
      'CONTRIBUTING.md ("Branch Naming") asks for a name describing the change, and ships the rename snippet for exactly this case.');
  }
  hostReport(`The branch name \`${prBranch}\``, null, prBranch,
    'A branch name is published on the PR and outlives the merge.');

  // --- Surface 4: commit subjects ----------------------------------------
  // A squash collapses the branch into the PR title, but a merge or a rebase
  // preserves these subjects, and a reviewer reading `git log` before merging
  // reads them today.
  const commitHits = [];
  const commitLocations = [];
  for (const commit of commits ?? []) {
    const message = commit?.commit?.message;
    if (typeof message !== 'string') continue;
    const firstLine = message.split('\n')[0];
    const hits = [...findAll(firstLine, separated), ...findAll(firstLine, compact)];
    if (hits.length === 0) continue;
    commitHits.push(...hits);
    commitLocations.push(firstLine.trim().slice(0, 80));
  }
  if (commitHits.length > 0) {
    report('A commit subject', commitLocations[0], commitHits,
      'Rewrite the subject (`git rebase -i`, `reword`); a merged subject is permanent history.');
  }
  for (const commit of commits ?? []) {
    const message = commit?.commit?.message;
    if (typeof message !== 'string') continue;
    const firstLine = message.split('\n')[0];
    if (findInstanceHosts(firstLine).length > 0) {
      hostReport('A commit subject', firstLine.trim().slice(0, 80), firstLine,
        'Rewrite the subject (`git rebase -i`, `reword`); a merged subject is permanent history.');
    }
  }

  // --- Surface 5: the diff, and the paths it touches -----------------------
  //
  // The instance-address rule stops here, on purpose. 664 files on master use
  // `localhost` in the e2e and dev surface, and a test that asserts a service
  // binds `127.0.0.1` is the code working. Authored text is where the address
  // is a leak; a diff line is where it is usually the subject matter. Only the
  // identifier half of the rule applies to the diff.

  const allowReasons = new Map(ALLOWLIST.filter((e) => e && e.path && e.reason).map((e) => [e.path, e.reason]));
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

  for (const file of files ?? []) {
    const filename = file?.filename ?? '(unnamed)';
    // A file's own name is part of the change and can carry the id, which is
    // how `pet392-blocker-edge-one-way-door.test.ts` reached the tree. A rename
    // publishes its new name, so the path is checked even where the *content*
    // is exempt — which is why this sits above the exemption checks.
    const pathHits = [...findAll(filename, separated), ...findAll(filename, compact)];
    if (pathHits.length > 0) {
      diffHits.push(...pathHits);
      diffLocations.push(`the file name \`${filename}\` (status \`${file?.status ?? 'unknown'}\`)`);
    }

    // The gate and its test contain the literals they search for, and the rule
    // text has to quote the banned shapes to define them. Both are exempt from
    // the *content* scan only: an id in a PR title still fails regardless.
    if (allowReasons.has(filename) || SELF_EXEMPT_PATHS.includes(filename)) continue;

    const changes = typeof file?.changes === 'number' ? file.changes : 0;
    const patch = typeof file?.patch === 'string' ? file.patch : null;

    if (patch === null) {
      // No patch with no reported line changes is a binary file or a pure
      // rename: there is no text to scan, which is a true negative.
      if (changes > 0) {
        unscannable.push(`${filename} (${changes} changed lines, no patch in the API response)`);
      }
      continue;
    }

    const completeness = patchIsComplete(patch);
    if (!completeness.complete) {
      unscannable.push(`${filename} (patch truncated by the GitHub API)`);
    }

    for (const line of patch.split('\n')) {
      if (!isAddedLine(line)) continue;
      const hits = [...findAll(line, separated), ...findAll(line, link)];
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
      `${unscannable.length} changed file${unscannable.length === 1 ? '' : 's'} arrived without readable patch content: ` +
      `${unscannable.slice(0, 5).map((u) => `\`${u}\``).join(', ')}${unscannable.length > 5 ? ` (and ${unscannable.length - 5} more)` : ''}. ` +
      'Reported as a failure because "no internal references found" is a claim this run cannot make.'
    );
  }

  return { passed: failures.length === 0, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkInternalRefs({
    prTitle: process.env.PR_TITLE ?? '',
    prBody: process.env.PR_BODY ?? '',
    prBranch: process.env.PR_BRANCH ?? '',
    commits: JSON.parse(process.env.PR_COMMITS ?? '[]'),
    files: JSON.parse(process.env.PR_FILES ?? '[]'),
    prefixes: process.env.INTERNAL_REF_PREFIXES,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
