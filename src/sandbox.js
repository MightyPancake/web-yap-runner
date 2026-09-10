import { config } from './config.js';

/**
 * Builds a bubblewrap invocation that isolates `cmd`/`args` into fresh
 * mount/pid/net/ipc/uts namespaces: no network, no view of the host's
 * processes, and filesystem access limited to /nix + /etc + /bin (read-only,
 * for the toolchain and dynamic linker), whatever extra `roBinds` paths the
 * caller needs (read-only), and `workDir` (read-write, since that's where
 * source/output files live).
 *
 * `/nix`, `/etc`, `/bin` are all NixOS-specific requirements: gcc/TCC/ld and
 * the dynamic linker live under /nix/store, and TCC's include-path discovery
 * (components/yap-c/src/build_state.c) shells out via popen() — which
 * hardcodes /bin/sh — to ask gcc for its default search paths.
 */
export function sandboxCommand(cmd, args, { workDir, roBinds = [] }) {
  if (!config.sandboxEnabled) {
    return { cmd, args };
  }

  const bwrapArgs = [
    '--unshare-all',
    '--die-with-parent',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--ro-bind', '/nix', '/nix',
    '--ro-bind-try', '/etc', '/etc',
    '--ro-bind-try', '/bin', '/bin',
  ];
  for (const p of roBinds) {
    bwrapArgs.push('--ro-bind', p, p);
  }
  bwrapArgs.push('--bind', workDir, workDir, '--chdir', workDir, '--', cmd, ...args);

  return { cmd: config.bwrapBin, args: bwrapArgs };
}
