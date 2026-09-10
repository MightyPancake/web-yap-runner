# web-yap-runner

A small REST API that compiles and runs [yap](https://github.com/mightypancake/yap)
programs.

## Setup

```sh
nix develop   # provides bubblewrap (sandboxing) and nodejs_24; see shell.nix for non-flake nix-shell
npm install
npm start
```

By default the server runs `./yap_compiler` (a copy of the `yap` binary, gitignored
since it's a machine-specific release build) with `YAP_HOME` pointed at `~/yap`. Both
are overridable via the `YAP_BIN` and `YAP_HOME` env vars. See `src/config.js` for
every other tunable (timeouts, resource limits, output caps).

The server refuses to start with sandboxing on (the default) if `bwrap` isn't runnable
— that's what `nix develop`/`nix-shell` is for. Set `YAP_SANDBOX=0` to run without it
if you understand the tradeoff (see "Notes on isolation" below).

`yap` requires a build of `~/yap` with the `YAP_HOME`-env-var fallback in
`yap_get_yap_home_path()` (`src/compiler.c`) — without it, the binary locates its
`components/`/`modules/`/`lib/` relative to its own on-disk path instead, so it would
need to live inside a full `~/yap` checkout rather than being copied out standalone.
To (re)build and refresh the copy after pulling yap changes:

```sh
cd ~/yap && nix develop --command make release
cp ~/yap/yap ~/web-yap-runner/yap_compiler
```

## API

### `POST /run`

Request body:

```json
{
  "files": [
    { "name": "main.yp", "content": "import io\n\ni32 fn main() {\n    io->print:(c\"Hello, world!\");\n    ret 0;\n}\n" }
  ],
  "input": "",
  "flags": ["-bO2"]
}
```

- `files` (required, non-empty array): each entry is `{ "name": "<relative path>", "content": "<source>" }`.
  Files are written to a scratch directory preserving their relative paths/names, so
  local imports (`import "./helper.yp"`) between files in the array resolve correctly.
- `entry` (optional string): which file name to pass to the compiler. Defaults to a
  file named `main.yp` if present, otherwise the first entry in `files`.
- `input` (optional string, default `""`): piped to the compiled program's stdin.
- `flags` (optional array of strings): forwarded to the compiler. Only backend/frontend
  tuning flags are accepted (`-b...`, `-f...`, `--backend-flag=...`, `--frontend-flag=...`),
  e.g. `-bO2`, `-bcc=clang`, `-bf=-Wall`. Flags that change the compiler's mode of
  operation (`-o`, `-g`, `-r`, `-s`, `-c`, `-C`, `-h`) are rejected.

Response body, on success:

```json
{ "was_ok": true, "output": "Hello, world!" }
```

On a compile error, runtime crash, non-zero exit, or timeout:

```json
{ "was_ok": false, "errors": ["Error in main.yp at 4:4\n  ..."] }
```

## Trying it out

```sh
./scripts/test.sh            # starts the server itself if one isn't already running
./scripts/test.sh --verbose  # same, but prints the full request/response JSON for every case
```

Covers the golden path, stdin, multi-file local imports, a compile error, a crashing
program, an infinite loop getting killed, and two rejected requests (a disallowed
flag, a path-traversal file name).

## Notes on isolation

Both the `yap` compile step and the compiled program run inside a
[bubblewrap](https://github.com/containers/bubblewrap) sandbox (`src/sandbox.js`):
fresh mount/pid/net/ipc/uts namespaces, no network, no view of the host's processes,
and filesystem access limited to `/nix`, `/etc`, `/bin` (read-only, needed for the
toolchain and dynamic linker), `YAP_HOME` (read-only), and the request's own scratch
directory (read-write). The compile step is sandboxed too, not just the run step:
yap's comptime macros execute arbitrary code via an embedded TCC *during compilation
itself* (see `components/yap-c/src/build_state.c` in `~/yap`), so untrusted source can
run code before a single line of the "output" program does. Both steps also get
`ulimit` CPU/memory/process caps on top of the namespace isolation, plus wall-clock
timeouts and output-size caps in `src/exec.js`.

This is meaningfully more isolated than plain `ulimit` alone, but it's still one
mount namespace away from the host rather than a VM — treat it as solid for
trusted/semi-trusted use, and add a stronger boundary (a container, nsjail, or gVisor)
if this is ever exposed to fully untrusted/adversarial callers at scale.
