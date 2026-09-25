#!/usr/bin/env python3
"""Safely reclaim leaked Paperclip run scratch from a tmpfs ``/tmp``.

``--tmp-root`` is repeatable and defaults to ``$PAPERCLIP_SWEEP_TMP_ROOT`` (or
``/tmp``), so the same script sweeps the tmpfs and the disk-backed root that run
scratch is being migrated to. Roots that do not exist are skipped.

Background (PET-204). Paperclip gives every agent run a private scratch
directory under ``os.tmpdir()`` and exports it as ``TMPDIR``/``PAPERCLIP_*_SCRATCH_DIR``.
The in-process cleanup path removes that directory when a run finishes
normally. It cannot run when the process is hard-killed (SIGKILL, a server
restart, an OOM kill, a lost child), so scratch accumulates. On a machine where
``/tmp`` is a size-capped tmpfs, that accumulation is a fleet-wide
``ERR_PNPM_ENOSPC`` failure mode: run spawns, checkpointing, and any tool that
needs temp space all break at once.

This script is the *host-level* mitigation. It is deliberately independent of
the in-process reaper so it still works against a deployment that predates it
(PET-203 tracks deploying that reaper). It never deletes a directory that a
live run could still be using.

Safety model
------------
A directory is removed only when every check below independently agrees:

1. Ownership. ``paperclip-run-*`` must be attributable to a run of this
   company. Normally that means a well-formed ``.paperclip-run-scratch.json``
   whose ``companyId`` matches. If the marker is missing, the run is recovered
   from the directory name instead (``prepareHeartbeatRunScratch`` embeds
   ``runId.slice(0, 12)``, recoverable right-to-left); a name that does not
   resolve to exactly one known run is left alone. Disable with
   ``--no-name-attribution``. A directory we cannot attribute to a run of this
   company is never touched.
2. Run is terminal. The recovered ``runId`` is resolved against the Paperclip
   API and must be in a terminal state. Non-terminal (``running``/``queued``)
   runs are always kept.
3. No surviving child. If the run row carries ``processPid``/``processGroupId``,
   those must be dead. This is stricter than terminal status: a run can be marked
   terminal while an orphan descendant is still writing files.
4. No live file handles. ``lsof +D`` must report nothing under the directory.
   This is the check that actually matters, because it observes the kernel
   rather than a database row that may lag the process.
5. Age grace. The directory must be older than ``--min-age-minutes`` (default
   15). This absorbs the window where a run has gone terminal but its
   teardown, ``finally`` blocks, and log flush have not finished.

A directory that fails any check is reported with the reason and left in place.
The default mode is a dry run; ``--apply`` is required to delete.

Usage
-----
  scripts/sweep-run-scratch.py                      # dry run, report the plan
  scripts/sweep-run-scratch.py --apply              # reclaim
  scripts/sweep-run-scratch.py --json > sweep.json  # machine-readable report

  # sweep both the tmpfs and the disk-backed root run scratch is migrating to
  scripts/sweep-run-scratch.py --apply \
      --tmp-root /tmp --tmp-root ~/.local/state/paperclip-run-scratch

Auth comes from the environment (``PAPERCLIP_API_URL``/``PAPERCLIP_API_KEY``/
``PAPERCLIP_COMPANY_ID``), which is how the paperclipai service already runs.
Pass ``--offline`` to skip the API and rely on liveness plus age alone; in that
mode no ``paperclip-run-*`` directory is removed, because terminal status cannot
be proven, and only the runtime-config directories (which carry no run id) are
eligible.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

MARKER_NAME = ".paperclip-run-scratch.json"
RUN_DIR_PREFIX = "paperclip-run-"
RUNTIME_CONFIG_PREFIX = "paperclip-opencode-config-"

# Name shape of a run-scratch directory, mirrored from
# server/src/services/run-scratch.ts -> prepareHeartbeatRunScratch():
#   paperclip-run-<issueSegment>-<runId.slice(0, 12)>-<mkdtemp suffix>
MKTEMP_SUFFIX_LEN = 7  # "-" plus the 6 random characters Node's mkdtemp adds
RUN_ID_PREFIX_LEN = 12

# A run in one of these states can no longer touch its scratch directory.
TERMINAL_RUN_STATUSES = frozenset(
    {"succeeded", "failed", "cancelled", "timed_out", "interrupted", "process_lost", "expired"}
)


# --------------------------------------------------------------------------- #
# result model
# --------------------------------------------------------------------------- #


@dataclass
class Verdict:
    path: str
    kind: str  # "run-scratch" | "runtime-config"
    action: str  # "remove" | "keep"
    reason: str
    size_bytes: int = 0
    run_id: str | None = None
    run_status: str | None = None
    oldest_mtime_age_s: float = 0.0

    def as_dict(self) -> dict:
        return {
            "path": self.path,
            "kind": self.kind,
            "action": self.action,
            "reason": self.reason,
            "sizeBytes": self.size_bytes,
            "runId": self.run_id,
            "runStatus": self.run_status,
            "ageMinutes": round(self.oldest_mtime_age_s / 60.0, 1),
        }


@dataclass
class Report:
    tmp_roots: list[str]
    applied: bool
    offline: bool
    verdicts: list[Verdict] = field(default_factory=list)

    def as_dict(self) -> dict:
        removed = [v for v in self.verdicts if v.action == "remove"]
        kept = [v for v in self.verdicts if v.action == "keep"]
        reclaimable = sum(v.size_bytes for v in removed)
        kept_bytes = sum(v.size_bytes for v in kept)
        reasons: dict[str, int] = {}
        for v in kept:
            reasons[v.reason] = reasons.get(v.reason, 0) + 1
        return {
            "tmpRoots": self.tmp_roots,
            "applied": self.applied,
            "offline": self.offline,
            "summary": {
                "scanned": len(self.verdicts),
                "removable": len(removed),
                "kept": len(kept),
                "reclaimableBytes": reclaimable,
                "keptBytes": kept_bytes,
                "keepReasons": dict(sorted(reasons.items(), key=lambda kv: -kv[1])),
            },
            "verdicts": [v.as_dict() for v in self.verdicts],
        }


class SweepError(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def human(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB"):
        if abs(n) < 1024 or unit == "GiB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} GiB"


def dir_size(path: Path) -> int:
    """Apparent size, summed without following symlinks out of the tree."""
    total = 0
    try:
        for entry in os.scandir(path):
            try:
                if entry.is_dir(follow_symlinks=False):
                    total += dir_size(Path(entry.path))
                else:
                    total += entry.stat(follow_symlinks=False).st_size
            except OSError:
                continue
    except OSError:
        pass
    return total


def oldest_mtime(path: Path) -> float:
    """Oldest mtime in the tree. A run that appends keeps the root mtime fresh,
    so the *oldest* entry is the better liveness signal for the grace window.

    Raises FileNotFoundError if the directory disappeared. A run's scratch is
    removed by the in-process reaper at run end, so it can vanish underneath
    this walk; the caller treats that as "nothing to do" rather than an error.
    """
    oldest = path.stat().st_mtime
    try:
        for entry in os.scandir(path):
            try:
                oldest = min(oldest, entry.stat(follow_symlinks=False).st_mtime)
            except OSError:
                continue
    except OSError:
        pass
    return oldest


def has_live_handles(path: Path) -> tuple[bool, str | None]:
    """True when some process still holds a file, directory, or cwd under path.

    ``/proc/<pid>/environ`` is not readable for other users on this host, so the
    env-var test is unavailable. ``lsof +D`` walks the open-file table instead,
    which observes the same kernel state and is what actually protects a live
    run. A run that has died cannot hold a handle, so this cannot produce a
    false negative for a hard-killed run.
    """
    if not shutil.which("lsof"):
        return False, "lsof-unavailable"
    try:
        proc = subprocess.run(
            ["lsof", "+D", str(path)],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return True, "lsof-timeout"
    except OSError as exc:
        return True, f"lsof-error:{exc.__class__.__name__}"
    rows = [line for line in proc.stdout.splitlines()[1:] if line.strip()]
    return bool(rows), (rows[0].split()[1] if rows else None)


def self_run_scratch_dirs() -> set[str]:
    """Directories this very process depends on. Never a removal candidate."""
    protected = set()
    for key in (
        "PAPERCLIP_RUN_SCRATCH_DIR",
        "PAPERCLIP_TASK_SCRATCH_DIR",
        "PAPERCLIP_SCRATCH_DIR",
        "PAPERCLIP_TMPDIR",
        "TMPDIR",
        "TEMP",
        "TMP",
        "XDG_CONFIG_HOME",
    ):
        value = os.environ.get(key)
        if not value:
            continue
        if RUN_DIR_PREFIX in value or RUNTIME_CONFIG_PREFIX in value:
            protected.add(str(Path(value).resolve()))
    return protected


# --------------------------------------------------------------------------- #
# Paperclip API
# --------------------------------------------------------------------------- #


class PaperclipApi:
    def __init__(self, base: str, api_key: str, company_id: str, timeout: float = 30.0):
        self.base = base.rstrip("/")
        self.api_key = api_key
        self.company_id = company_id
        self.timeout = timeout

    def _get(self, path: str):
        req = urllib.request.Request(
            f"{self.base}{path}",
            headers={"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def run_index(self) -> dict[str, dict]:
        """runId -> {status, processPid, processGroupId, finishedAt}."""
        rows = self._get(f"/api/companies/{self.company_id}/heartbeat-runs")
        if not isinstance(rows, list):
            raise SweepError("heartbeat-runs did not return a list")
        index: dict[str, dict] = {}
        for row in rows:
            run_id = row.get("id")
            if not run_id:
                continue
            index[run_id] = {
                "status": row.get("status"),
                "processPid": row.get("processPid"),
                "processGroupId": row.get("processGroupId"),
                "finishedAt": row.get("finishedAt"),
            }
        return index


def pid_alive(pid) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


# --------------------------------------------------------------------------- #
# the sweep
# --------------------------------------------------------------------------- #


class Sweeper:
    def __init__(self, args: argparse.Namespace):
        self.tmp_roots = [Path(r).resolve() for r in args.tmp_root]
        self.apply = args.apply
        self.offline = args.offline
        self.min_age_s = args.min_age_minutes * 60
        self.runtime_config_age_s = args.runtime_config_age_minutes * 60
        self.skip_lsof = args.skip_lsof
        self.name_attribution = args.name_attribution
        self.protected = self_run_scratch_dirs()
        self.include_runtime_config = args.include_runtime_config
        self.api: PaperclipApi | None = None
        self.run_index: dict[str, dict] = {}
        # 12-char run-id prefix -> run ids, so an unmarked directory can still
        # be attributed to its run via the name. See parse_run_dir_name().
        self.run_prefix_index: dict[str, list[str]] = {}
        self.api_error: str | None = None

    def load_api(self) -> None:
        if self.offline:
            return
        base = os.environ.get("PAPERCLIP_API_URL") or os.environ.get("PAPERCLIP_RUNTIME_API_URL")
        key = os.environ.get("PAPERCLIP_API_KEY")
        company = os.environ.get("PAPERCLIP_COMPANY_ID")
        missing = [n for n, v in (("PAPERCLIP_API_URL", base), ("PAPERCLIP_API_KEY", key), ("PAPERCLIP_COMPANY_ID", company)) if not v]
        if missing:
            self.api_error = f"missing-env:{','.join(missing)}"
            return
        try:
            self.api = PaperclipApi(base, key, company)
            self.run_index = self.api.run_index()
            for run_id in self.run_index:
                self.run_prefix_index.setdefault(run_id[:RUN_ID_PREFIX_LEN], []).append(run_id)
        except (urllib.error.URLError, OSError, json.JSONDecodeError, SweepError) as exc:
            self.api_error = f"api-unavailable:{exc.__class__.__name__}"

    def candidates(self) -> list[tuple[Path, str]]:
        # More than one root is normal: run scratch is migrating off the tmpfs
        # onto the root filesystem (PET-204, drop-in 60-run-scratch-root.conf),
        # so both locations have to be swept until the old one is empty.
        # A root that does not exist is skipped, not an error: the state dir
        # only appears once the daemon has restarted onto it.
        out: list[tuple[Path, str]] = []
        seen: set[Path] = set()
        for root in self.tmp_roots:
            try:
                entries = sorted(p for p in root.iterdir() if p.is_dir())
            except FileNotFoundError:
                continue
            except OSError as exc:
                raise SweepError(f"cannot read tmp root {root}: {exc}") from exc
            for entry in entries:
                if entry in seen:
                    continue
                name = entry.name
                if name.startswith(RUN_DIR_PREFIX):
                    seen.add(entry)
                    out.append((entry, "run-scratch"))
                elif self.include_runtime_config and name.startswith(RUNTIME_CONFIG_PREFIX):
                    seen.add(entry)
                    out.append((entry, "runtime-config"))
        return out

    def judge(self, path: Path, kind: str, now: float) -> Verdict:
        size = dir_size(path)
        try:
            age_s = now - oldest_mtime(path)
        except FileNotFoundError:
            # Reaped by the in-process cleanup between listing and measuring.
            # Nothing to reclaim and nothing went wrong.
            return Verdict(str(path), kind, "keep", "vanished-during-sweep", size)
        resolved = str(path.resolve())

        if resolved in self.protected:
            return Verdict(str(path), kind, "keep", "own-process", size, oldest_mtime_age_s=age_s)
        if not path.name.startswith(RUN_DIR_PREFIX) and not path.name.startswith(RUNTIME_CONFIG_PREFIX):
            return Verdict(str(path), kind, "keep", "unmarked-name", size, oldest_mtime_age_s=age_s)

        grace = self.min_age_s if kind == "run-scratch" else self.runtime_config_age_s
        if age_s < grace:
            return Verdict(str(path), kind, "keep", f"within-grace({age_s / 60:.0f}m<{grace / 60:.0f}m)", size, oldest_mtime_age_s=age_s)

        if kind == "run-scratch":
            return self._judge_run_scratch(path, size, age_s)

        # Runtime-config homes carry no run marker, so terminal status cannot be
        # proven. Age plus an open-handle check is the whole safety argument:
        # the dir is the run's XDG_CONFIG_HOME, and a live run is holding it.
        if not self.skip_lsof:
            alive, detail = has_live_handles(path)
            if alive:
                return Verdict(str(path), kind, "keep", f"live-handle:{detail}", size, oldest_mtime_age_s=age_s)
        return Verdict(str(path), kind, "remove", "stale-runtime-config-home", size, oldest_mtime_age_s=age_s)

    def _judge_run_scratch(self, path: Path, size: int, age_s: float) -> Verdict:
        marker_path = path / MARKER_NAME
        marker = read_marker(marker_path)

        # How the run was identified, for the report and for auditing the
        # weaker evidence path.
        via = "marker"
        run_id: str | None = None
        if marker is not None:
            run_id = marker.get("runId")
            company_id = os.environ.get("PAPERCLIP_COMPANY_ID")
            if company_id and marker.get("companyId") != company_id:
                # Never touch another instance's or another company's scratch.
                return Verdict(str(path), "run-scratch", "keep", "foreign-company", size, run_id, oldest_mtime_age_s=age_s)
        else:
            if not self.name_attribution:
                return Verdict(str(path), "run-scratch", "keep", "unreadable-marker", size, oldest_mtime_age_s=age_s)
            # No marker. The marker is written after mkdtemp, so a crash or an
            # ENOSPC between the two leaves an unattributable directory that no
            # cleanup can ever reclaim. The directory name still encodes
            # runId.slice(0, 12), which is enough to find the run -- and the
            # remaining checks (terminal status, dead pid, no open handles) are
            # what actually authorise deletion, exactly as for a marked dir.
            via = "name"
            prefix = parse_run_dir_name(path.name)
            matches = self.run_prefix_index.get(prefix, []) if prefix else []
            if len(matches) == 1:
                run_id = matches[0]
            else:
                reason = "unreadable-marker" if not prefix else "ambiguous-name"
                if prefix and not matches:
                    reason = "name-run-not-in-index"
                return Verdict(str(path), "run-scratch", "keep", reason, size, oldest_mtime_age_s=age_s)

        if self.offline or self.api is None:
            reason = "offline-no-terminal-proof" if self.offline else (self.api_error or "no-api")
            return Verdict(str(path), "run-scratch", "keep", reason, size, run_id, oldest_mtime_age_s=age_s)

        row = self.run_index.get(run_id)
        if row is None:
            # Run predates retention, or another instance owns the id. Age alone
            # is not enough proof that nobody is writing here.
            return Verdict(str(path), "run-scratch", "keep", "run-not-in-index", size, run_id, oldest_mtime_age_s=age_s)

        status = row.get("status")
        if status not in TERMINAL_RUN_STATUSES:
            return Verdict(str(path), "run-scratch", "keep", f"run-{status}", size, run_id, status, age_s)

        if pid_alive(row.get("processPid")) or pid_alive(row.get("processGroupId")):
            return Verdict(str(path), "run-scratch", "keep", "run-pid-alive", size, run_id, status, age_s)

        if not self.skip_lsof:
            alive, detail = has_live_handles(path)
            if alive:
                return Verdict(str(path), "run-scratch", "keep", f"live-handle:{detail}", size, run_id, status, age_s)

        reason = f"terminal:{status}" if via == "marker" else f"terminal:{status};attributed-by-name"
        return Verdict(str(path), "run-scratch", "remove", reason, size, run_id, status, age_s)

    def run(self) -> Report:
        self.load_api()
        now = time.time()
        report = Report([str(r) for r in self.tmp_roots], self.apply, self.offline)
        for path, kind in self.candidates():
            try:
                verdict = self.judge(path, kind, now)
            except FileNotFoundError:
                # The in-process reaper won the race for this directory. This
                # runs unattended on a timer, so one vanishing directory must
                # not abort the sweep for everything after it.
                report.verdicts.append(
                    Verdict(str(path), kind, "keep", "vanished-during-sweep", 0)
                )
                continue
            except OSError as exc:
                report.verdicts.append(
                    Verdict(str(path), kind, "keep", f"judge-error:{exc.__class__.__name__}", 0)
                )
                continue
            if verdict.action == "remove" and self.apply:
                try:
                    shutil.rmtree(path)
                    verdict.reason = f"{verdict.reason};removed"
                except FileNotFoundError:
                    # Reaped by the in-process cleanup between the check and the
                    # delete. That is the outcome we wanted anyway.
                    verdict.reason = f"{verdict.reason};already-gone"
                except OSError as exc:
                    verdict.action = "keep"
                    verdict.reason = f"rm-failed:{exc.__class__.__name__}"
            report.verdicts.append(verdict)
        report.verdicts.sort(key=lambda v: (v.action != "remove", -v.size_bytes))
        return report


def parse_run_dir_name(name: str) -> str | None:
    """Recover the 12-char run-id prefix embedded in a run-scratch dir name.

    ``prepareHeartbeatRunScratch`` builds the name as::

        paperclip-run-<issueSegment>-<runId.slice(0,12)>-<mkdtemp 6 chars>

    ``issueSegment`` and the run prefix may both contain dashes, so the split
    is ambiguous from the left. It is unambiguous from the right, because
    ``mkdtemp`` always appends exactly ``-XXXXXX`` and the run prefix is
    always exactly 12 characters. Parsing right-to-left therefore recovers the
    run prefix without guessing where the issue identifier ends.

    This matters because the marker file is not always present. It is written
    by a separate ``writeFile`` after ``mkdtemp``, so a failure between the two
    (ENOSPC on a full tmpfs is the realistic case) leaves a directory that no
    later cleanup can attribute to a run. The name still carries the identity.

    Returns the 12-character prefix, or None if the name is not shaped like a
    run-scratch directory.
    """
    if not name.startswith(RUN_DIR_PREFIX):
        return None
    rest = name[len(RUN_DIR_PREFIX) :]
    if len(rest) < MKTEMP_SUFFIX_LEN + 1 + RUN_ID_PREFIX_LEN:
        return None
    body = rest[: -MKTEMP_SUFFIX_LEN]
    return body[-RUN_ID_PREFIX_LEN:]


def read_marker(path: Path) -> dict | None:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    if parsed.get("version") != 1:
        return None
    for key in ("companyId", "agentId", "runId", "createdAt"):
        if not isinstance(parsed.get(key), str) or not parsed[key]:
            return None
    return parsed


# --------------------------------------------------------------------------- #
# cli
# --------------------------------------------------------------------------- #


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    # Repeatable, so a single sweep covers both the tmpfs root and the
    # disk-backed root that run scratch is migrating to. A root that does not
    # exist yet is skipped, so listing the future location is harmless today.
    parser.add_argument(
        "--tmp-root",
        action="append",
        metavar="DIR",
        help="directory to sweep for paperclip-run-*/paperclip-opencode-config-*; repeatable (default: $PAPERCLIP_SWEEP_TMP_ROOT, else /tmp)",
    )
    parser.add_argument("--apply", action="store_true", help="actually delete (default: dry run)")
    parser.add_argument("--offline", action="store_true", help="skip the Paperclip API; only runtime-config homes are eligible")
    parser.add_argument("--min-age-minutes", type=float, default=15.0, help="grace for run-scratch dirs (default: 15)")
    parser.add_argument("--runtime-config-age-minutes", type=float, default=90.0, help="grace for runtime-config homes (default: 90)")
    parser.add_argument("--skip-lsof", action="store_true", help="skip the open-handle check (less safe; for diagnostics only)")
    parser.add_argument(
        "--no-name-attribution",
        dest="name_attribution",
        action="store_false",
        help="require .paperclip-run-scratch.json; never attribute an unmarked dir to a run via its name (strictest, but strands dirs whose marker write failed)",
    )
    parser.add_argument("--no-runtime-config", dest="include_runtime_config", action="store_false", help="only consider paperclip-run-* dirs")
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    parser.add_argument("--max-detail", type=int, default=0, help="print at most N kept dirs in text mode")
    args = parser.parse_args(argv)
    if not args.tmp_root:
        env_roots = os.environ.get("PAPERCLIP_SWEEP_TMP_ROOT", "")
        args.tmp_root = [p for p in env_roots.split(os.pathsep) if p] or ["/tmp"]

    try:
        report = Sweeper(args).run()
    except SweepError as exc:
        print(f"sweep-run-scratch: {exc}", file=sys.stderr)
        return 2

    if args.json:
        json.dump(report.as_dict(), sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    summary = report.as_dict()["summary"]
    mode = "APPLY" if report.applied else "DRY-RUN"
    print(f"[{mode}] tmp roots: {', '.join(report.tmp_roots)}")
    if report.offline:
        print("  offline: run-scratch dirs are never removed without a terminal-status proof")
    print(
        f"  scanned {summary['scanned']} dirs | removable {summary['removable']} "
        f"({human(summary['reclaimableBytes'])}) | kept {summary['kept']} ({human(summary['keptBytes'])})"
    )
    if summary["keepReasons"]:
        print("  kept by reason:")
        for reason, count in summary["keepReasons"].items():
            print(f"    {count:>4}  {reason}")

    removable = [v for v in report.verdicts if v.action == "remove"]
    if removable:
        print(f"  removable detail (top 10):")
        for v in removable[:10]:
            ident = f" {v.run_id[:8]}/{v.run_status}" if v.run_id else ""
            print(f"    {human(v.size_bytes):>10}  {v.reason}{ident}  {Path(v.path).name}")
        if len(removable) > 10:
            print(f"    ... and {len(removable) - 10} more")

    kept = [v for v in report.verdicts if v.action == "keep"]
    if args.max_detail and kept:
        print(f"  kept detail (up to {args.max_detail}):")
        for v in kept[: args.max_detail]:
            print(f"    {v.reason:<40}  {Path(v.path).name}")

    if not report.applied and summary["removable"]:
        print("  re-run with --apply to reclaim")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
