import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: intFromEnv('PORT', 3000),

  // Loopback by default: the only intended caller is the cloudflared process
  // on this same host (see cloudflared.yml, which points at localhost), so
  // there is no reason to accept connections from the rest of the LAN.
  host: process.env.HOST || '127.0.0.1',

  // Path to the yap compiler binary. It's a self-contained copy (see
  // yap_compiler in the repo root) — yap resolves the "components/",
  // "modules/", "lib/" directories it needs from YAP_HOME below rather than
  // its own on-disk location, so this binary doesn't need to live next to
  // a yap source checkout.
  yapBin: process.env.YAP_BIN || path.join(repoRoot, 'yap_compiler'),

  // Directory yap treats as its install root (must contain components/,
  // modules/, lib/). Only the yap compiler process gets this env var — it's
  // irrelevant to the compiled program it produces.
  yapHome: process.env.YAP_HOME || path.join(os.homedir(), 'yap'),

  // Wall-clock timeouts.
  compileTimeoutMs: intFromEnv('YAP_COMPILE_TIMEOUT_MS', 15_000),
  runTimeoutMs: intFromEnv('YAP_RUN_TIMEOUT_MS', 10_000),

  // yap's comptime macros execute arbitrary code via an embedded TCC during
  // compilation itself (not just at runtime), so the compile step gets its
  // own ulimits too — roomier than the run step's, since a real compile
  // (gcc -O2 on generated C, TCC in-process) needs more headroom than a
  // toy program.
  //
  // *MaxProcesses maps to `ulimit -u` (RLIMIT_NPROC), which the kernel
  // enforces per REAL UID, system-wide — it is NOT scoped to bwrap's PID
  // namespace or this process's own tree. On a shared desktop/dev machine
  // where the same user also runs a browser, IDE, etc., the *ambient*
  // process count can already be in the hundreds, so a low value here
  // doesn't bound the sandboxed program at all — it just spuriously fails
  // forks inside the sandbox (e.g. TCC's own popen() calls) the moment the
  // host's ordinary usage happens to push the total over the limit. Keep
  // this well above the host's normal process count; it's a backstop
  // against a real fork bomb, not a tight per-request cap (that's what the
  // concurrency limiter in server.js is for).
  compileCpuSeconds: intFromEnv('YAP_COMPILE_CPU_SECONDS', 20),
  compileMemoryKb: intFromEnv('YAP_COMPILE_MEMORY_KB', 1024 * 1024),
  compileMaxProcesses: intFromEnv('YAP_COMPILE_MAX_PROCESSES', 2048),

  // Resource limits applied (via `ulimit`) to the compiled program's process.
  runCpuSeconds: intFromEnv('YAP_RUN_CPU_SECONDS', 5),
  runMemoryKb: intFromEnv('YAP_RUN_MEMORY_KB', 256 * 1024),
  runMaxProcesses: intFromEnv('YAP_RUN_MAX_PROCESSES', 2048),

  // Sandbox both the compiler and the compiled program with bubblewrap
  // (namespace isolation: no network, no view of the host's processes,
  // filesystem access limited to /nix (read-only, for the toolchain/libc),
  // YAP_HOME (read-only), and the request's own scratch directory).
  // Disabling this is only for environments where bwrap genuinely can't run
  // (e.g. no unprivileged user namespaces) — it removes a real isolation
  // layer, not just a convenience.
  sandboxEnabled: process.env.YAP_SANDBOX !== '0',
  bwrapBin: process.env.YAP_BWRAP_BIN || 'bwrap',

  // Caps on captured output so a runaway program can't exhaust server memory.
  maxOutputBytes: intFromEnv('YAP_MAX_OUTPUT_BYTES', 1024 * 1024),
  maxInputBytes: intFromEnv('YAP_MAX_INPUT_BYTES', 1024 * 1024),

  // Request body limits.
  maxFiles: intFromEnv('YAP_MAX_FILES', 32),
  maxFlags: intFromEnv('YAP_MAX_FLAGS', 32),
  jsonBodyLimit: process.env.YAP_JSON_BODY_LIMIT || '4mb',

  // The caller is a static site (GitHub Pages) calling this API directly
  // from browser JS, so any embedded secret would be public too — an API
  // key would be theater, not a real access control. What actually bounds
  // abuse here: a CORS allowlist (stops *other* sites' browser JS from
  // calling this directly; doesn't stop non-browser clients, but raises the
  // bar for casual drive-by use), per-IP rate limiting, and a global
  // concurrency cap (each request compiles+runs native code, which is real
  // CPU/memory cost regardless of how many distinct IPs it comes from).
  corsOrigin: process.env.YAP_CORS_ORIGIN || 'https://nullptr.free',
  rateLimitWindowMs: intFromEnv('YAP_RATE_LIMIT_WINDOW_MS', 60_000),
  rateLimitMax: intFromEnv('YAP_RATE_LIMIT_MAX', 20),
  maxConcurrentRuns: intFromEnv('YAP_MAX_CONCURRENT_RUNS', 4),
};
