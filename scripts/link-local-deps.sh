#!/bin/sh
# Link this checkout's harness packages and zod into new-linux-sandbox/node_modules.
#
# This is a development convenience for loading the built plugin by absolute
# path from a source-checkout profile, without installing the package into a
# profile's dependency tree. It assumes the package lives directly inside a
# DeepSeek Harness checkout; a packaged installation resolves its declared
# dependencies normally instead.
set -eu

package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
checkout=$(CDPATH= cd -- "$package_dir/.." && pwd)
modules="$package_dir/node_modules"

mkdir -p "$modules/@deepseek-ai"
link() {
  ln -sfn "$checkout/$1" "$modules/$2"
}

link vendor/cordis @deepseek-ai/cordis
link vendor/schemastery @deepseek-ai/schemastery
link packages/sandbox/sandbox @deepseek-ai/dsh-sandbox
link packages/llm/llm @deepseek-ai/dsh-llm
link packages/core/session @deepseek-ai/dsh-session
link packages/session/session-projection @deepseek-ai/dsh-session-projection
link node_modules/zod zod

printf 'linked %s\n' "$modules"
