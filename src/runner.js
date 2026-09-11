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
function ulimited(cpuSeconds, memoryKb, maxProcesses, cmd, args) {
  const script = `ulimit -t ${cpuSeconds} -v ${memoryKb} -u ${maxProcesses} 2>/dev/null; exec "$0" "$@"`;
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

export async function runYapProgram({ files, entry, input, flags }) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yap-run-'));
  try {
    await writeFiles(workDir, files);

    const binPath = path.join(workDir, 'a.out.bin');
    const compileArgs = [...flags, entry, '-o', binPath];

    const [compileCmd, compileArgsUlimited] = ulimited(
      config.compileCpuSeconds,
      config.compileMemoryKb,
      config.compileMaxProcesses,
      config.yapBin,
      compileArgs,
    );
    const sandboxedCompile = sandboxCommand(compileCmd, compileArgsUlimited, {
      workDir,
      roBinds: [config.yapHome, config.yapBin],
    });

    const compile = await runCapture(sandboxedCompile.cmd, sandboxedCompile.args, {
      cwd: workDir,
      env: { ...process.env, YAP_HOME: config.yapHome },
      timeoutMs: config.compileTimeoutMs,
      maxBytes: config.maxOutputBytes,
    });

    if (compile.timedOut) {
      return { was_ok: false, errors: [`Compilation timed out after ${config.compileTimeoutMs}ms.`] };
    }
    if (compile.code !== 0) {
      return { was_ok: false, errors: parseCompileError(compile.stderr) };
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
      roBinds: [config.yapHome],
    });

    const run = await runCapture(sandboxedRun.cmd, sandboxedRun.args, {
      cwd: workDir,
      stdin: input,
      timeoutMs: config.runTimeoutMs,
      maxBytes: config.maxOutputBytes,
    });

    if (run.timedOut) {
      return { was_ok: false, errors: [`Program timed out after ${config.runTimeoutMs}ms.`] };
    }
    if (run.outputExceeded) {
      return { was_ok: false, errors: [`Program output exceeded the ${config.maxOutputBytes}-byte limit.`] };
    }
    if (run.signal) {
      return { was_ok: false, errors: [`Program terminated by signal ${run.signal}.`] };
    }
    if (run.code !== 0) {
      const errors = [describeNonZeroExit(run.code)];
      const stderrText = run.stderr.trim();
      if (stderrText) errors.push(stderrText);
      return { was_ok: false, errors };
    }

    return { was_ok: true, output: run.stdout };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
