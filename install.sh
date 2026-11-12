#!/usr/bin/env bash
# One-shot installer for the ZenTao workbench plugin.
# Usage: ./install.sh [profile-dir]
# Default profile: ~/.dsh/profiles/desktop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/dsh-zentao"
PROFILE="${1:-$HOME/.dsh/profiles/desktop}"
if [ ! -f "$PROFILE/package.json" ]; then
  echo "找不到 DSH profile: $PROFILE"
  echo "请确认 DeepSeek Harness 已安装，或用参数指定 profile 目录"
  exit 1
fi
node - "$PROFILE" "$SRC" <<'NODE'
const fs = require('fs')
const path = require('path')
const [profile, src] = process.argv.slice(2)
const pkgPath = path.join(profile, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies['@local/dsh-zentao'] = 'link:' + src
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
if (!bundles.includes('@local/dsh-zentao')) bundles.push('@local/dsh-zentao')
pkg.dsh.profile.bundles = bundles
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log('已注册到 profile:', pkgPath)
NODE
cd "$PROFILE"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install
else
  echo "未找到 pnpm，请先安装 pnpm（例如 corepack enable），再执行：cd '$PROFILE' && pnpm install"
fi
echo ""
echo "下一步：编辑 $SRC/cordis.patch.yml，填写禅道的 baseUrl / account / password"
echo "然后重启一次 DeepSeek Harness，左侧会出现「禅道 AI 工作台」。"
