import { spawn } from 'node:child_process';

// Strip ANSI SGR escape sequences (the yap compiler colorizes its error
// output unconditionally).
export function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Spawn a process, feed it optional stdin, and capture stdout/stderr up to
 * a byte cap. Kills the process if it runs past `timeoutMs` or exceeds the
 * output cap, so a runaway compiled program can't hang the server or exhaust
 * its memory.
 */
export function runCapture(cmd, args, { cwd, env, stdin = '', timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    function collect(chunk, chunks, lenRef, isStdout) {
      const remaining = maxBytes - lenRef.value;
      if (remaining <= 0) {
        if (isStdout) stdoutTruncated = true;
        else stderrTruncated = true;
      } else if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        lenRef.value += remaining;
        if (isStdout) stdoutTruncated = true;
        else stderrTruncated = true;
      } else {
        chunks.push(chunk);
        lenRef.value += chunk.length;
      }
      if (stdoutTruncated || stderrTruncated) {
        outputExceeded = true;
        child.kill('SIGKILL');
      }
    }

    const stdoutLenRef = { value: 0 };
    const stderrLenRef = { value: 0 };

    child.stdout.on('data', (chunk) => collect(chunk, stdoutChunks, stdoutLenRef, true));
    child.stderr.on('data', (chunk) => collect(chunk, stderrChunks, stderrLenRef, false));

    child.stdin.on('error', () => {
      // Program may exit/close stdin early (e.g. it never reads input); ignore EPIPE.
    });
    child.stdin.end(stdin);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        code,
        signal,
        timedOut,
        outputExceeded,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}
