import fs from 'node:fs';
import { config } from './config.js';

// `--tmpfs <dir>` needs the directory to exist inside the sandbox, and /etc is
// bound read-only, so bwrap cannot create it. On a host without /etc/nixos
// (e.g. the minimal guest image the in-VM deployment uses) there is nothing to
// mask in the first place.
const HAS_ETC_NIXOS = fs.existsSync('/etc/nixos');

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
 *
 * `/etc` is bound wholesale (not just the specific files TCC/bash need)
 * because trial and error showed narrower binds kept breaking in
 * NixOS-specific ways. But unlike the rest of /etc, /etc/nixos is not part
 * of the NixOS-managed environment.etc (it's not symlinked from
 * /etc/static) — it's just the host's own plaintext system config
 * (configuration.nix, hardware-configuration.nix), world-readable by
 * default and irrelevant to compiling/running yap programs. A sandboxed
 * yap program can otherwise just open() it, so it's masked out with an
 * empty tmpfs mounted *after* the /etc bind (bwrap applies mounts in
 * order, so the later mount wins for that path).
 */
export function sandboxCommand(cmd, args, { workDir, roBinds = [] }) {
  if (!config.sandboxEnabled) {
    return { cmd, args };
  }

  // Mounting a fresh procfs needs privileges the process does not have when it
  // is itself already inside a VM guest container (bwrap fails with "Can't
  // mount proc on /newroot/proc"), so that deployment binds the guest's /proc
  // read-only instead. Seeing the guest's own processes is not a leak there:
  // the guest exists only to run this service.
  const procArgs =
    config.sandboxProcMode === 'bind' ? ['--ro-bind', '/proc', '/proc'] : ['--proc', '/proc'];

  const bwrapArgs = [
    '--unshare-all',
    '--die-with-parent',
    ...procArgs,
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--ro-bind', '/nix', '/nix',
    '--ro-bind-try', '/etc', '/etc',
    '--ro-bind-try', '/bin', '/bin',
    ...(HAS_ETC_NIXOS ? ['--tmpfs', '/etc/nixos'] : []),
  ];
  for (const p of roBinds) {
    bwrapArgs.push('--ro-bind', p, p);
  }
  bwrapArgs.push('--bind', workDir, workDir, '--chdir', workDir, '--', cmd, ...args);

  return { cmd: config.bwrapBin, args: bwrapArgs };
}
