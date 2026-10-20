import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { runCapture, stripAnsi } from './exec.js';
import { sandboxCommand } from './sandbox.js';

// A process sandboxed via bwrap that dies to a signal (crash, ulimit,
// OOM-kill) doesn't deliver that signal to the bwrap process we actually
// spawned — bwrap reports it as its own exit code 128+signal instead. Decode
// that back into a signal name for a useful error message.
const SIGNAL_NAMES_BY_NUMBER = Object.fromEntries(
  Object.entries(os.constants.signals).map(([name, num]) => [num, name]),
);

function describeNonZeroExit(code) {
  if (code > 128 && SIGNAL_NAMES_BY_NUMBER[code - 128]) {
    return `Program terminated by signal ${SIGNAL_NAMES_BY_NUMBER[code - 128]} (exit code ${code}).`;
  }
  return `Program exited with code ${code}.`;
}

// `ulimit`, then `exec` so the limits apply to the actual target process
// rather than the short-lived shell wrapping it.
//
// Uses `sh`, not `bash`: inside the bwrap sandbox, a bare `bash` ends up
// with some other PATH entirely (NixOS-default-looking paths like
// /run/current-system/sw/bin, which isn't even bound into the sandbox)
// instead of the one actually passed to it, while `sh` (the very same
// underlying binary, just invoked under that name) reliably keeps the PATH
// it's given. Confirmed by direct testing; root cause not fully identified,
// but it's consistent and `sh` is all `ulimit`+`exec` need anyway (both are
// POSIX builtins).
//
// A memoryKb of 0 means no `-v` at all. That is not laziness: `ulimit -v` caps the
// address space, and V8 -- which emscripten shells out to for its compiler and
// optimizer passes -- reserves vastly more of that than it ever commits, so any -v
// small enough to be a meaningful memory budget kills node outright at startup
// (SIGTRAP, before it runs a line). Builds that need node are bounded by CPU time, the
// wall-clock timeout and the concurrency cap instead.
function ulimited(cpuSeconds, memoryKb, maxProcesses, cmd, args) {
  const limits = [`-t ${cpuSeconds}`, memoryKb ? `-v ${memoryKb}` : null, `-u ${maxProcesses}`]
    .filter(Boolean)
    .join(' ');
  const script = `ulimit ${limits} 2>/dev/null; exec "$0" "$@"`;
  return ['sh', ['-c', script, cmd, ...args]];
}

function parseCompileError(stderr) {
  const cleaned = stripAnsi(stderr).trim();
  if (!cleaned) return ['yap exited with an error but produced no diagnostic output.'];
  // The compiler stops at the first error and prints one "Error in <file> at
  // <line>:<col>" block (message + source snippet). Kept as a single entry
  // since there is currently never more than one per invocation.
  return [cleaned];
}

async function writeFiles(rootDir, files) {
  for (const file of files) {
    const target = path.join(rootDir, file.name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, 'utf8');
  }
}

// A module registry entry is often a symlink out of YAP_HOME rather than a directory in
// it -- modules/laydoh and modules/raylib both point at their own checkouts. The sandbox
// binds YAP_HOME, so unless whatever those links resolve to is bound too they dangle
// inside it, and the compile fails with an unresolved import rather than anything that
// names the real cause.
async function linkedModuleBinds() {
  const modulesDir = path.join(config.yapHome, 'modules');
  const entries = await fs.readdir(modulesDir, { withFileTypes: true }).catch(() => []);
  const binds = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    const target = await fs.realpath(path.join(modulesDir, entry.name)).catch(() => null);
    if (target && !target.startsWith(config.yapHome)) binds.push(target);
  }
  return binds;
}

// Every mode compiles the same way -- same ulimits, same sandbox, same yap binary --
// and differs only in the flags it passes, how long the compile is allowed to take, and
// what else has to be visible inside the sandbox (emcc needs its cache).
async function compileProgram({
  workDir,
  args,
  timeoutMs,
  cpuSeconds = config.compileCpuSeconds,
  memoryKb = config.compileMemoryKb,
  extraEnv = {},
  extraRoBinds = [],
}) {
  const [cmd, argsUlimited] = ulimited(
    cpuSeconds,
    memoryKb,
    config.compileMaxProcesses,
    config.yapBin,
    args,
  );
  const sandboxed = sandboxCommand(cmd, argsUlimited, {
    workDir,
    roBinds: [config.yapHome, config.yapBin, ...(await linkedModuleBinds()), ...extraRoBinds],
  });

  const started = performance.now();
  const result = await runCapture(sandboxed.cmd, sandboxed.args, {
    cwd: workDir,
    env: { ...process.env, YAP_HOME: config.yapHome, ...extraEnv },
    timeoutMs,
    maxBytes: config.maxOutputBytes,
  });
  return { ...result, compileMs: Math.round(performance.now() - started) };
}

export async function runYapProgram({ files, entry, input, flags }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yap-run-'));
  try {
    await writeFiles(workDir, files);

    const binPath = path.join(workDir, 'a.out.bin');
    const compile = await compileProgram({
      workDir,
      args: [...flags, entry, '-o', binPath],
      timeoutMs: config.compileTimeoutMs,
    });
    const compileMs = compile.compileMs;

    if (compile.timedOut) {
      return {
        was_ok: false,
        errors: [`Compilation timed out after ${config.compileTimeoutMs}ms.`],
        compile_ms: compileMs,
      };
    }
    if (compile.code !== 0) {
      return { was_ok: false, errors: parseCompileError(compile.stderr), compile_ms: compileMs };
    }

    const binExists = await fs
      .access(binPath)
      .then(() => true)
      .catch(() => false);
    if (!binExists) {
      return {
        was_ok: false,
        errors: [
          'Compilation reported success but produced no executable ' +
            '(check for backend flags that change the output mode, e.g. -bc).',
        ],
        compile_ms: compileMs,
      };
    }
    await fs.chmod(binPath, 0o700);

    const [runCmd, runArgsUlimited] = ulimited(
      config.runCpuSeconds,
      config.runMemoryKb,
      config.runMaxProcesses,
      binPath,
      [],
    );
    // yapHome is still needed here (not just at compile time): the compiled
    // binary dynamically links against any native module it imports (e.g.
    // modules/io/libio.so) by absolute path under YAP_HOME.
    const sandboxedRun = sandboxCommand(runCmd, runArgsUlimited, {
      workDir,
      roBinds: [config.yapHome, ...(await linkedModuleBinds())],
    });

    const runStart = performance.now();
    const run = await runCapture(sandboxedRun.cmd, sandboxedRun.args, {
      cwd: workDir,
      stdin: input,
      timeoutMs: config.runTimeoutMs,
      maxBytes: config.maxOutputBytes,
    });
    const runMs = Math.round(performance.now() - runStart);
    const timings = { compile_ms: compileMs, run_ms: runMs };

    if (run.timedOut) {
      return { was_ok: false, errors: [`Program timed out after ${config.runTimeoutMs}ms.`], ...timings };
    }
    if (run.outputExceeded) {
      return {
        was_ok: false,
        errors: [`Program output exceeded the ${config.maxOutputBytes}-byte limit.`],
        ...timings,
      };
    }
    if (run.signal) {
      return { was_ok: false, errors: [`Program terminated by signal ${run.signal}.`], ...timings };
    }
    if (run.code !== 0) {
      const errors = [describeNonZeroExit(run.code)];
      const stderrText = run.stderr.trim();
      if (stderrText) errors.push(stderrText);
      return { was_ok: false, errors, ...timings };
    }

    return { was_ok: true, output: run.stdout, ...timings };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// The name the generated factory is exported under. The playground's frame calls it to
// start the program, so both sides have to agree on it; it travels in the response so
// the client never has to hardcode it.
export const RAYLIB_EXPORT_NAME = 'createRaylibModule';

// What turns a raylib program into a browser program. Fixed here rather than accepted
// from the caller: `-bf=` forwards its value verbatim to the backend C compiler, which
// is exactly the hole validate.js's exact-match allowlist exists to close. None of these
// is a matter of taste either -- without them the build either fails to link or wedges
// the tab.
const RAYLIB_FLAGS = [
  '-bcc=emcc',
  // raylib's web backend draws through emscripten's own GLFW rather than a real one.
  '-bf=-sUSE_GLFW=3',
  // On web, raylib's WindowShouldClose() is emscripten_sleep(12) followed by `return
  // false` (raylib's platforms/rcore_web.c), and emscripten_sleep only works under
  // Asyncify. Without this the ordinary `while (!WindowShouldClose())` loop never hands
  // control back: nothing paints and the tab locks. With it, source that runs natively
  // runs here unchanged -- which is the whole point of the mode. The cost is a bigger,
  // slower binary, paid so the playground isn't teaching a browser-only dialect of the
  // bindings.
  '-bf=-sASYNCIFY',
  '-bf=-sALLOW_MEMORY_GROWTH',
  // One artifact rather than two: the wasm is embedded in the JS, so the response is a
  // single string and the frame has no second URL to fetch.
  '-bf=-sSINGLE_FILE=1',
  // A factory instead of a global Module, so the frame can hand in its own canvas and
  // know when the runtime is ready.
  '-bf=-sMODULARIZE=1',
  `-bf=-sEXPORT_NAME=${RAYLIB_EXPORT_NAME}`,
];

/**
 * Compiles a raylib program to wasm and hands the JS back instead of running anything.
 * The program runs in the caller's browser, which is both the only place a GL window
 * means anything and a better place to spend the frames: this server pays one compile
 * and nothing after it, where /run pays for every second the program is alive.
 */
export async function buildRaylibProgram({ files, entry, flags }) {
  if (!config.emCache || !config.emccBin) {
    return {
      was_ok: false,
      errors: [
        'This server is not set up for raylib builds: it needs emcc on PATH (or YAP_EMCC) ' +
          'and a prebuilt emscripten cache in YAP_EM_CACHE. See the README.',
      ],
    };
  }

  const emccDir = path.dirname(config.emccBin);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yap-build-'));
  try {
    await writeFiles(workDir, files);

    const outPath = path.join(workDir, 'raylib_app.js');
    const compile = await compileProgram({
      workDir,
      args: [...RAYLIB_FLAGS, ...flags, entry, '-o', outPath],
      timeoutMs: config.raylibCompileTimeoutMs,
      cpuSeconds: config.raylibCompileCpuSeconds,
      memoryKb: 0,
      // The cache is bound read-only, so emcc has to treat it as complete rather than
      // building a system library into it on demand -- that is what EM_FROZEN_CACHE
      // means. It must therefore be warmed, outside the sandbox, with the same flag set
      // this builds with (see the README); a cold cache fails the build rather than
      // silently taking a minute.
      // PATH: yap invokes the backend compiler by name, so emcc's real directory has to
      // be on it inside the sandbox. EM_FROZEN_CACHE: the cache is bound read-only, so
      // emcc must treat it as complete rather than building a system library into it on
      // demand. It therefore has to be warmed outside the sandbox with the same flags
      // this builds with (see the README) -- a cold cache fails the build outright
      // rather than silently taking a minute.
      extraEnv: {
        PATH: `${emccDir}:${process.env.PATH ?? ''}`,
        EM_CACHE: config.emCache,
        EM_FROZEN_CACHE: '1',
      },
      extraRoBinds: [config.emCache, emccDir],
    });
    const compileMs = compile.compileMs;

    if (compile.timedOut) {
      return {
        was_ok: false,
        errors: [`Compilation timed out after ${config.raylibCompileTimeoutMs}ms.`],
        compile_ms: compileMs,
      };
    }
    if (compile.code !== 0) {
      return { was_ok: false, errors: parseCompileError(compile.stderr), compile_ms: compileMs };
    }

    const js = await fs.readFile(outPath, 'utf8').catch(() => null);
    if (!js) {
      return {
        was_ok: false,
        errors: ['The build reported success but produced no JavaScript.'],
        compile_ms: compileMs,
      };
    }

    return { was_ok: true, js, export_name: RAYLIB_EXPORT_NAME, compile_ms: compileMs };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
