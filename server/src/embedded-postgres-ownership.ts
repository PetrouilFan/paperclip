import {
  resolveLiveServerOwner,
  type LiveServerProcess,
} from "./services/instance-database-guard.js";

/**
 * Whether a starting server may take over an embedded PostgreSQL that is
 * already running.
 *
 * The reuse path used to answer this with a single WARN and move on, which is
 * how a second `paperclipai run` came to serve the board with a database it did
 * not own. A service log from that incident reads:
 *
 *     WARN: Embedded PostgreSQL already running; reusing existing process (pid=2160889, port=54329)
 *     WARN: Requested port is busy; using next free port (requestedPort=3100, selectedPort=3101)
 *
 * Two warnings that together describe a split instance, and nothing above WARN.
 * The second server had no database of its own, so its availability depended on
 * a process somebody happened to leave open in a terminal tab, and the
 * operator had no pid to act on.
 *
 * The refusal is deliberately narrower than "the postmaster is not mine".
 * Requiring the postmaster to be this process's own descendant would break the
 * supported recovery: when a server is killed without stopping the database,
 * the postmaster is reparented to `systemd --user` and the next server is
 * expected to reclaim it. That is the only correct answer when no other server
 * is alive to own it, so ancestry decides, not parenthood -- see
 * `resolveLiveServerOwner`, which draws exactly that line.
 *
 * The move to another HTTP port is *not* part of that decision. Binding a free
 * port is recoverable on its own, and two instances with two data directories
 * is a supported layout; what is not recoverable is a second instance sharing
 * one database. The port collision is therefore still a WARN naming its owner,
 * and the borrowed database is fatal before the listen port is ever chosen.
 */

export type EmbeddedPostgresReuseOutcome =
  | {
      /** No live database to reuse: start one. */
      action: "start";
      postmasterPid: null;
      liveServerOwner: null;
      message: null;
    }
  | {
      /**
       * A live database with no other live server above it. The documented
       * reclaim path; the caller keeps its single WARN.
       */
      action: "adopt";
      postmasterPid: number;
      liveServerOwner: null;
      message: null;
    }
  | {
      /** A different live `paperclipai run` server owns the database. */
      action: "refuse";
      postmasterPid: number;
      liveServerOwner: LiveServerProcess;
      /** Operator-facing refusal, naming the pid, its cgroup, and the port. */
      message: string;
    };

/**
 * The refusal an operator has to be able to act on without reading the source.
 *
 * It names the owning pid, that process's cgroup (so a supervised owner is
 * traceable to its unit) and the port the database is actually serving on, and
 * it does not offer a port move: there is no port to move to that would make
 * borrowing this database correct.
 */
export function formatDatabaseOwnershipRefusal(input: {
  dataDir: string;
  port: number | null;
  owner: LiveServerProcess;
}): string {
  const { dataDir, port, owner } = input;
  return [
    `Refusing to reuse the embedded PostgreSQL in ${dataDir}: a different live Paperclip server owns it`,
    `(pid=${owner.pid}, cgroup=${owner.cgroup ?? "unknown"}, port=${port ?? "unknown"}).`,
    "Adopting it would make this process a second instance with no database of its own, and its availability",
    "would depend on that process staying alive. Stop that server first, or start this one against a",
    "different instance so it gets its own data directory.",
  ].join(" ");
}

export function decideEmbeddedPostgresReuse(input: {
  dataDir: string;
  /** The live postmaster, or null when the caller found no pid file. */
  postmasterPid: number | null;
  /** The port the running database serves on, for the refusal message. */
  port?: number | null;
  /** Defaults to this process; a server never collides with itself. */
  selfPid?: number;
}): EmbeddedPostgresReuseOutcome {
  const postmasterPid = input.postmasterPid;
  if (postmasterPid === null) {
    return { action: "start", postmasterPid: null, liveServerOwner: null, message: null };
  }

  // The pid file was already read and its identity checked by the caller, so
  // this walk starts from the pid the caller proved rather than re-reading the
  // file and racing a postmaster that exits in between.
  const liveServerOwner = resolveLiveServerOwner(postmasterPid, { selfPid: input.selfPid });
  if (liveServerOwner) {
    return {
      action: "refuse",
      postmasterPid,
      liveServerOwner,
      message: formatDatabaseOwnershipRefusal({
        dataDir: input.dataDir,
        port: input.port ?? null,
        owner: liveServerOwner,
      }),
    };
  }

  return { action: "adopt", postmasterPid, liveServerOwner: null, message: null };
}
