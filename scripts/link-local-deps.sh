#!/bin/sh
# Link a DeepSeek Harness checkout's built packages into this package's
# node_modules, replacing the published packages `npm install` supplies.
#
# The package itself is standalone: `npm install` provides the toolchain and
# the published harness packages, and `npm test` / `npm run build` need no
# checkout. Run this only to test against a checkout's build output (after
# building that checkout). The checkout root comes from DSH_CHECKOUT, or from
# the parent directory when this package sits directly inside one.
set -eu

package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
modules="$package_dir/node_modules"

if [ ! -d "$modules" ]; then
  printf 'error: %s is missing; run npm install first\n' "$modules" >&2
  exit 1
fi

checkout=${DSH_CHECKOUT:-}
if [ -n "$checkout" ]; then
  requested=$checkout
  checkout=$(CDPATH= cd -- "$checkout" && pwd) || {
    printf 'error: DSH_CHECKOUT=%s is not a directory\n' "$requested" >&2
    exit 1
  }
else
  parent=$(CDPATH= cd -- "$package_dir/.." && pwd)
  if [ -f "$parent/tsconfig.base.json" ] && [ -d "$parent/packages/boot/app-boot" ]; then
    checkout=$parent
  else
    printf 'error: no DeepSeek Harness checkout found.\n' >&2
    printf 'Set DSH_CHECKOUT to the checkout root, for example:\n' >&2
    printf '  DSH_CHECKOUT=/path/to/deepseek-harness npm run link\n' >&2
    exit 1
  fi
fi

if [ ! -f "$checkout/tsconfig.base.json" ] || [ ! -d "$checkout/packages/boot/app-boot" ]; then
  printf 'error: %s does not look like a DeepSeek Harness checkout\n' "$checkout" >&2
  exit 1
fi

mkdir -p "$modules/@deepseek-ai"
link() {
  if [ ! -e "$checkout/$1" ]; then
    printf 'error: %s is missing from %s\n' "$1" "$checkout" >&2
    exit 1
  fi
  # `npm install` puts real directories here; replace the package wholesale.
  rm -rf "$modules/$2"
  ln -s "$checkout/$1" "$modules/$2"
}

link vendor/cordis @deepseek-ai/cordis
link vendor/schemastery @deepseek-ai/schemastery
link vendor/loader @deepseek-ai/cordis-plugin-loader
link vendor/include @deepseek-ai/cordis-plugin-include
link packages/boot/app-boot @deepseek-ai/dsh-app-boot
link packages/bundle/base @deepseek-ai/dsh-base
link packages/sandbox/sandbox @deepseek-ai/dsh-sandbox
link packages/sandbox/sandbox-policy @deepseek-ai/dsh-sandbox-policy
link packages/llm/llm @deepseek-ai/dsh-llm
link packages/core/session @deepseek-ai/dsh-session
link packages/core/agent @deepseek-ai/dsh-agent
link packages/session/session-projection @deepseek-ai/dsh-session-projection
link packages/fs/fs @deepseek-ai/dsh-fs
link packages/fs/fs-local @deepseek-ai/dsh-fs-local
link packages/fs/fs-sandbox @deepseek-ai/dsh-fs-sandbox
link packages/client/connection @deepseek-ai/dsh-client-connection

printf 'linked %s from %s\n' "$modules" "$checkout"
