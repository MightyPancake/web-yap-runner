#!/usr/bin/env bash
# Starts web-yap-runner inside a Kata Containers VM and keeps it in the
# foreground so systemd can supervise it (see yap-runner-vm.service).
#
# The VM is the real sandbox boundary here: a /run request compiles and then
# executes arbitrary submitted code, and bubblewrap alone (YAP_SANDBOX_PROC)
# is a namespace trick inside the same kernel. Kata gives it a separate
# kernel, so this is deliberately not a plain container runtime.
#
# Until this unit existed the identical command was started by hand, in the
# foreground, with --rm -- so a crash or a reboot took the playground down
# until somebody noticed. This file is that command, under supervision and in
# version control.
set -euo pipefail

NERDCTL="${NERDCTL:-/nix/store/sdxfl9vil9522ad00l62xsa71lvrjfw6-nerdctl-2.3.1/bin/nerdctl}"
CNI_PATH="${CNI_PATH:-/nix/store/mcssx6fay93jbkf58b43r51xlwbi5a47-cni-plugins-1.9.1/bin}"
NODE="${NODE:-/nix/store/5a8ysg1jnj8jmzzyfcfw7rvpvnp5rfpa-nodejs-24.15.0/bin/node}"
HOME_DIR="${HOME_DIR:-/home/mightypancake}"
NAME=yap-runner-vm
PORT_SPEC="127.0.0.1:25116:25116"

# The guest PATH, captured from the yap dev shell
# (`cd ~/yap && nix develop --command printenv PATH`) and pinned here because
# the yap compiler needs its whole toolchain visible inside the VM, not just
# node: tcc runs comptime macros during compilation, and gcc/clang back the
# native codegen. Deriving it from THIS repo's flake instead would silently
# drop those and every /run would fail to compile. Regenerate it the same way
# after a nixpkgs bump.
GUEST_PATH="${GUEST_PATH:-/nix/store/5a8ysg1jnj8jmzzyfcfw7rvpvnp5rfpa-nodejs-24.15.0/bin:/nix/store/zp6rsi809fx5h7dccn7aidg1mj8zgn52-bubblewrap-0.11.2/bin:/nix/store/788mx070y81zjlg5ipcl0cra3afviw9k-gcc-wrapper-15.2.0/bin:/nix/store/874j5xydsj6nr6i1zdrjvhln5gmxvvrr-clang-wrapper-21.1.8/bin:/nix/store/3pgknlzk3vf39nb530gfii0ikrcln7ds-tcc-0.9.27-unstable-2025-01-06/bin:/nix/store/mbyy19mdwnfvfwmdi0gqgggx0njvpl1w-binutils-wrapper-2.46/bin:/nix/store/9ypz3flqsrl5xl495mm8h645gadjsxi1-coreutils-9.11/bin:/nix/store/cgjr3kj3hs7ngznyws5qfg16c8scpys0-bash-interactive-5.3p9/bin:/nix/store/c1cjgg6p8m8fssivzrc2p13mwwml3p3v-findutils-4.10.0/bin:/nix/store/d3bwqm6bymhy3pdgbvf7vxjqfp31m3j1-gnumake-4.4.1/bin:/usr/bin:/bin}"

# Browser origins allowed to call /run. Both sites' playgrounds are served
# from their own origin, and a CORS response may name only one, so the server
# echoes back whichever of these a request came from (see src/server.js).
CORS_ORIGINS="${YAP_CORS_ORIGIN:-https://nullptr.free,https://yap.nullptr.free}"

# A leftover VM from an unclean stop would hold the port. Ignore failures:
# not existing is the normal case.
"$NERDCTL" rm -f "$NAME" >/dev/null 2>&1 || true

exec "$NERDCTL" run --rm --name "$NAME" \
  --runtime io.containerd.kata.v2 \
  --cni-path "$CNI_PATH" \
  -p "$PORT_SPEC" \
  -v /nix:/nix:ro \
  -v "$HOME_DIR/yap:$HOME_DIR/yap:ro" \
  -v "$HOME_DIR/web-yap-runner:$HOME_DIR/web-yap-runner:ro" \
  -w "$HOME_DIR/web-yap-runner" \
  -e "PATH=$GUEST_PATH" \
  -e "YAP_HOME=$HOME_DIR/yap" \
  -e "YAP_BIN=$HOME_DIR/web-yap-runner/yap_compiler" \
  -e YAP_SANDBOX_PROC=bind \
  -e PORT=25116 \
  -e HOST=0.0.0.0 \
  -e "YAP_CORS_ORIGIN=$CORS_ORIGINS" \
  docker.io/library/alpine:latest \
  "$NODE" src/server.js
