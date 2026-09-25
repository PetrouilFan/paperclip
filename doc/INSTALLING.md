# Installing Paperclip

Paperclip supports a managed installation, an ephemeral `npx` tryout, a
traditional global npm installation, and development from a source checkout.
The managed installation is recommended because it provides atomic updates,
rollback, git-ref installs, and a stable entrypoint for the background service.

## Recommended Install

On macOS, Linux, or WSL2:

```sh
curl -fsSLO https://paperclip.ing/install.sh
curl -fsSLO https://paperclip.ing/install.sh.sha256
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c install.sh.sha256
else
  shasum -a 256 -c install.sh.sha256
fi
bash install.sh
```

The bootstrap script:

1. verifies that the platform is supported;
2. ensures Node.js 24.11 or newer is available;
3. delegates installation to `paperclipai install`;
4. starts interactive onboarding when stdin and stdout are terminals.

The script prints and confirms any command that requires elevated privileges.
Third-party Node.js bootstrap scripts are pinned and SHA-256 verified before
execution; the installer stops if a published script changes unexpectedly.
The `paperclip.ing` checksum detects transfer or publishing mistakes, but it is
served from the same origin as the script and is not an independent
authenticity proof. For an independently hosted source, download a release-tag
or commit-pinned copy from GitHub, review it, and run that local file.

Use `--no-prompt` for automation and `--no-onboard` to stop after installing.
The piped form only proceeds when supported Node.js, npm, and npx are already
installed; if Node.js bootstrap is required, download the script first so the
privileged commands are inspectable before execution:

```sh
curl -fsSL https://paperclip.ing/install.sh | bash -s -- --no-prompt --no-onboard
paperclipai onboard --yes
```

If the vanity installer endpoint is unavailable, fetch the same
release-controlled source from GitHub raw content:

```sh
raw_base=https://raw.githubusercontent.com/paperclipai/paperclip
curl -fsSL "$raw_base/master/scripts/install.sh" | bash
```

For audits or incident response, pin the raw URL to a release tag or commit SHA
instead of `master` and download it first. That immutable GitHub URL provides a
separate delivery path from `paperclip.ing`; do not treat a checksum served by
the same origin as the artifact as an independent trust anchor.

Each installer flag also has a `PAPERCLIP_INSTALL_*` environment-variable
equivalent. This helps where passing arguments through a pipe is awkward.

Codex ACP workspace sessions enable networking so agents can report task outcomes.
To disable it explicitly, set `extraArgs` to
`["-c", "sandbox_workspace_write.network_access=false"]`, or set
`env.PAPERCLIP_CODEX_ACP_NETWORK_ACCESS="false"`. Execution-target network denial
also remains enforced. Read-only ACP mode remains read-only.

## Node runtime used by background services

Check the Node executable used by the running service, not only `node --version`
in an interactive shell. Systemd and launchd do not load shell version-manager
configuration. A newer Node installed elsewhere does not upgrade a running
service or change a custom startup script's `PATH`.

Managed installs pin the validated Node executable in the `paperclipai` shim
and prepend its directory to `PATH` for child tools, including ACP servers with
an `/usr/bin/env node` shebang. Re-run the installer using the supported
Node runtime after changing runtime installations, then restart the service.
For example, put the supported Node's bin directory first on `PATH` and run
`npx paperclipai@latest install --yes`. Do not use the old managed shim to
re-pin Node: it intentionally continues launching its previously pinned runtime.
Installs and updates refresh existing managed shims in place. Updates reject an
unsupported running Node before installing or activating a payload; read-only
update checks and rollback remain available for recovery. Global npm installs and
source checkout services must configure their own executable and child-process `PATH`.

For custom service wrappers, use an absolute, supported Node executable and put
that executable's directory first on `PATH`. Keep required existing PATH entries.
On Linux, verify the running executable with `/proc/<server-pid>/exe`; an
interactive shell version check alone is insufficient. Use the guarded restart
procedure in [DEVELOPING.md](DEVELOPING.md#hot-restart-deploys) when jobs are active.

Legacy local adapters default to ACP, including configurations with no `engine`
field or the old `auto` value. An unavailable ACP runtime fails the run and the
agent environment test with a setup error; it never silently changes engines.
Repair the reported prerequisite or explicitly select `engine: cli`. Local
filesystem/network confinement and in-place Codex workspaces require explicit
CLI selection. CLI sandbox defaults and explicit restrictions are described in
the adapter configuration documentation.

## Managed Install Layout

Managed code is separate from instance data:

```text
~/.paperclip/cli/
├── install.json
├── current -> installs/npm/2026.720.0
└── installs/
    ├── npm/<version>/
    └── git/<sha12>/

~/.local/bin/paperclipai
```

The `paperclipai` shim remains stable while `current` switches atomically
between complete payloads. Paperclip keeps the two previous managed payloads
for rollback. Configuration, databases, uploads, logs, secrets, and workspaces
remain under `~/.paperclip/instances/` and are not stored inside CLI payloads.

If `~/.local/bin` is not on `PATH`, the installer offers to update the relevant
shell startup file when running interactively. Non-interactive installs print
the exact `export PATH` command instead of editing shell files silently.

## Install Sources

Install the current stable release:

```sh
npx --registry https://registry.npmjs.org paperclipai install
```

Install canary or pin an exact published version:

```sh
npx --registry https://registry.npmjs.org paperclipai install --canary
npx --registry https://registry.npmjs.org paperclipai install --version 2026.720.0
```

Install a branch, tag, or commit from GitHub:

```sh
npx --registry https://registry.npmjs.org paperclipai install --ref master
npx --registry https://registry.npmjs.org paperclipai install --ref v2026.720.0
npx --registry https://registry.npmjs.org paperclipai install --ref <commit-sha>
```

Use a fork by adding `--repo owner/repository`:

```sh
npx --registry https://registry.npmjs.org paperclipai install \
  --repo your-org/paperclip \
  --ref your-branch
```

Git-ref installs resolve the requested ref to an exact commit before building.
Review and trust the repository and ref: installing a git ref executes that
revision's package installation and release build scripts on your machine.

## Onboarding And The Service

Run onboarding after a non-interactive installation:

```sh
paperclipai onboard
```

Interactive onboarding asks whether Paperclip should run as a background
service when the platform supports one. Automated onboarding deliberately does
not install a service unless explicitly requested:

```sh
paperclipai onboard --yes                    # configure only; no service install
paperclipai onboard --yes --install-service  # explicit automation opt-in
paperclipai onboard --yes --no-install-service
```

After onboarding installs and starts the service, it waits for the service to
report its selected runtime port and then prints the dashboard URL. Interactive
terminals open that URL in the default browser; headless and non-interactive
runs print the URL without trying to launch a browser.

Service commands are namespaced:

```sh
paperclipai service install
paperclipai service status
paperclipai service start
paperclipai service stop
paperclipai service restart
paperclipai service logs -f
paperclipai service uninstall
```

Paperclip uses a systemd user service on Linux and WSL2 systems with user
systemd, and a LaunchAgent on macOS. Containers, WSL1, and systems without a
supported user service manager receive foreground `paperclipai run` guidance
instead of a hard failure.

The service uses the stable managed-install shim, restarts after crashes, and
can start on login. On Linux, service installation may offer to enable user
lingering so it can continue without an active login session. The command
explains and confirms that system-level action before running it.

Use one server process per instance. `paperclipai run` refuses to start when
the same instance is already supervised; stop the service first or use
`--force` only when you intentionally accept the single-writer risk.

## Update And Rollback

Update according to the source and channel recorded in the install manifest:

```sh
paperclipai update
```

Select a different release source explicitly:

```sh
paperclipai update --latest
paperclipai update --canary
paperclipai update --version 2026.720.0
```

Managed updates create a database backup before switching payloads, verify the
new CLI, atomically flip `current`, and restart an installed service. A failed
install or verification leaves the previous payload active.

If the service is stopped, start it with `paperclipai service start` before
updating so Paperclip can take the safety backup. Use
`paperclipai update --no-backup` only when you intentionally accept updating
without that rollback safeguard. A never-onboarded instance with no config or
instance data skips the backup automatically because there is nothing to save.

Roll back to the previous retained payload:

```sh
paperclipai update --rollback
```

The `upgrade` command is an alias for `update`. Exact versions and commit SHAs
are pinned; provide a new target when you want them to move.

## Other Installation Methods

Ephemeral tryout with no managed install:

```sh
npx --registry https://registry.npmjs.org paperclipai onboard --yes
```

Traditional global npm install:

```sh
npm install --global --registry https://registry.npmjs.org paperclipai
paperclipai onboard
```

Source checkout for development:

```sh
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
pnpm dev
```

The managed `paperclipai update` command can update managed and global npm
installs. For source checkouts it reports the appropriate git workflow instead
of modifying the checkout automatically.

## Diagnose An Installation

Run:

```sh
paperclipai doctor
paperclipai service status
```

`doctor` checks the managed install store, manifest, `current` link, shim,
`PATH`, Node.js version, and service state. Service diagnostics cover unit-file
presence and drift, running state, configured port ownership, and the running
server version.

The CLI and server also print a non-blocking startup warning when Node.js is
below the supported minimum. Upgrade Node.js with a version manager or follow
the downloaded `install.sh` workflow under **Recommended Install**. Do not use
the piped form for this repair because it requires a supported Node.js runtime
before it starts.

## Recover A Broken Service Unit

`paperclipai service install`, `start`, and `restart` re-render
`~/.config/systemd/user/paperclipai.service` *before* they talk to systemd. The
renderer derives `ExecStart` from the current environment, so a host whose
service was installed under a different prefix — an `npm install -g` binary, a
hand-edited unit, a `PAPERCLIP_SHIM_PATH` that was never exported in the shell
that ran the restart — can be rewritten onto a path that does not exist.
systemd then answers `status=203/EXEC` on every start attempt, reaches the
start limit after five tries, and parks the unit in `failed`.

The API and the embedded PostgreSQL live in that unit's cgroup, so the whole
instance goes down for as long as the unit is broken. Every in-flight agent
write is dropped with it. Before this fix there was no CLI command that
repairs the unit, so the recovery below is manual; with the current CLI,
`paperclipai service install` rewrites a broken unit once `paperclipai install`
has restored a runnable shim, and the doctor prints that refusal with the same
hint. The steps below still apply when you want the unit back without running
the installer.

Recognise it:

```sh
systemctl --user status paperclipai --no-pager
journalctl --user -u paperclipai -n 20 --no-pager
grep -n '^ExecStart=' "$HOME/.config/systemd/user/paperclipai.service"
```

`status` reports `failed` with `start-limit-hit`, the journal shows
`Unable to locate executable ...` five times in a row, and `ExecStart` points
at a file that is not there.

Repair it in place:

```sh
unit="$HOME/.config/systemd/user/paperclipai.service"
binary="$(command -v paperclipai)"        # the CLI that is actually installed
test -x "$binary" || echo "no runnable CLI on PATH"

cp -a "$unit" "$unit.bak"
sed -i 's|^ExecStart=.*|ExecStart="'"$binary"'" run --instance "default"|' "$unit"

systemctl --user daemon-reload
systemctl --user reset-failed paperclipai
systemctl --user start paperclipai
```

Use `systemctl --user edit --full paperclipai` instead of `sed` when you prefer
a real editor.

For an instance other than `default`, change every name below, not only the
`--instance` argument: the unit file is
`~/.config/systemd/user/paperclipai-<id>.service`, each `systemctl --user`
command targets `paperclipai-<id>.service`, and `ExecStart` keeps
`--instance "<id>"`. Editing only `--instance` repairs `ExecStart` while the
`reset-failed` and `start` commands keep hitting the default unit and leave the
failed instance down.

While you are in the unit, check the `Environment=` lines. The renderer only
owns `PAPERCLIP_SERVICE_MANAGED`, `PAPERCLIP_INSTANCE_ID`, and
`PAPERCLIP_HOME`; a rewrite performed by an older CLI also drops
operator-supplied lines such as `PATH` and `PAPERCLIP_OPENCODE_PROVIDERS`. The
service starts without them, but adapter dispatch and provider selection are
wrong, which looks like a healthy process serving broken runs. Restore those
lines from `$unit.bak`.

`paperclipai doctor` and `paperclipai service status` report unit-file drift
but do not repair it. On a CLI older than this fix, no `ExecStart` validation
runs before a write, so copy the unit aside (`cp -a "$unit" "$unit.bak"`) before
every `paperclipai service restart` on a host with a hand-patched unit. The
current CLI keeps an installed executable that still works and refuses a rewrite
that would land on a missing one, so the backup is a precaution for older
installs rather than a step on the current upgrade path.

## Uninstall

Remove the background service and managed CLI payloads:

```sh
paperclipai service uninstall
paperclipai uninstall
```

`paperclipai uninstall` removes the managed shim, manifest, and CLI payloads.
It deliberately preserves `~/.paperclip/instances/`, including configuration,
databases, uploads, logs, secrets, backups, and workspaces. Back up and remove
that data separately only when you intend to delete the Paperclip instance.
