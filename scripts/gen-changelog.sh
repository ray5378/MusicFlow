#!/usr/bin/env bash
#
# 自动生成一个版本区间(默认自上一个 tag 到当前 tag/HEAD)的变更日志。
#
# 用法:
#   scripts/gen-changelog.sh                  # <首tag>..HEAD(无历史 tag 时取当前 tag 全部提交)
#   scripts/gen-changelog.sh <since> [until]  # <since>..<until>(如 v1.5.0 HEAD)
#
# 提交规范(见 CONTRIBUTING.md):`<type>(<scope>): <subject>`,如
# `feat(plugins): ...` / `fix(rest): ...` / `docs: ...` / `ci: ...`。
# 带 `!` 的后缀(`feat(api)!:`)或正文含 `BREAKING CHANGE:` 视为破坏性变更;
# `chore: release` 与 merge 提交不进入日志。
#
# 输出按类型分组的 Markdown(无类别则整体略去该小节),供 CI 在打 v* tag 建
# Release 时直接作为变更正文,把「提交发版 → 自动生成变更日志」闭环。
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
# 若从子目录调用也能正确进到仓库根。
cd "$repo"

last_tag="$(git tag --sort=-version:refname | sed -n '1p' || true)"
this_tag="${1:-}"
until="${2:-HEAD}"

if [ -n "$this_tag" ]; then
  # 显式给定目标版本:区间「上一个与它不同的 tag..该 tag」;无历史 tag 时取该 tag 全部提交。
  prev="$(git tag --sort=-version:refname | while IFS= read -r t; do [ "$t" != "$this_tag" ] && { echo "$t"; break; }; done)"
  if [ -n "$prev" ]; then
    range="${prev}..${this_tag}"
  else
    range="${this_tag}"
  fi
elif [ -n "$last_tag" ]; then
  # 无目标(预览 next):上一个 tag..HEAD
  range="${last_tag}..${until}"
else
  range="${until}"
fi

# 过滤 merge 与 `chore: release`(发版自身打 tag 的提交不入日志)。
log_lines="$(git log --oneline --no-merges --grep='^chore: release' --invert-grep "$range" 2>/dev/null || true)"
[ -z "${log_lines// /}" ] && log_lines="(暂无变更)"

# 各分类保留顺序;小写 type 决定归属,`!` 或 BREAKING CHANGE 归入破坏性变更。
breaking=(); feat=(); fix=(); refactor=(); docs=(); other=()

if [ "$log_lines" = "(暂无变更)" ]; then
  printf '%s\n' "# 变更日志" "" "(暂无变更)"
  exit 0
fi

while IFS= read -r line; do
  [ -z "$line" ] && continue
  # 兼容 `<type(scope)!: body` / `<type(scope): body` / `<type!: body` / `<type: body`。
  # 无冒号前缀(不规范)归入其他。正则存入变量再用于 =~,避免 [[ ]] 直接解析字面
  # `[`(含括号表达式)报语法错。
  pat_with_scope='^[0-9a-f]{4,40}[[:space:]]+([A-Za-z]+)\([^)]*\)([!]?):[[:space:]]*(.*)$'
  pat_no_scope='^[0-9a-f]{4,40}[[:space:]]+([A-Za-z]+)([!]?):[[:space:]]*(.*)$'
  if [[ "$line" =~ $pat_with_scope ]]; then
    type="${BASH_REMATCH[1],,}"
    bang="${BASH_REMATCH[2]}"
    rest="${BASH_REMATCH[3]}"
  elif [[ "$line" =~ $pat_no_scope ]]; then
    type="${BASH_REMATCH[1],,}"
    bang="${BASH_REMATCH[2]}"
    rest="${BASH_REMATCH[3]}"
  else
    type=""
    bang=""
    rest="${line#* }"
  fi
  has_breaking="$bang"
  if [ -z "$has_breaking" ] && [ -n "$rest" ] && [[ "$rest" == *"BREAKING CHANGE"* ]]; then
    has_breaking="!"
  fi
  if [ -n "$has_breaking" ]; then
    breaking+=("- $line")
    continue
  fi
  case "$type" in
    feat)              feat+=("- $line") ;;
    fix|hotfix)        fix+=("- $line") ;;
    perf|refactor|style|build|deps|chore) refactor+=("- $line") ;;
    docs)              docs+=("- $line") ;;
    *)                 other+=("- $line") ;;
  esac
done <<<"$log_lines"

out="# 变更日志"
# 首行小节标题注明区间,便于人读。
[ -n "$last_tag" ] && out="$out ($range)"

if [ "${#breaking[@]}" -gt 0 ]; then
  out="$out"$'\n'$'\n'"## 破坏性变更(需注意升级影响)"$'\n'
  out="$out$(printf '%s\n' "${breaking[@]}")"
fi
if [ "${#feat[@]}" -gt 0 ]; then
  out="$out"$'\n'$'\n'"## 新功能"$'\n'
  out="$out$(printf '%s\n' "${feat[@]}")"
fi
if [ "${#fix[@]}" -gt 0 ]; then
  out="$out"$'\n'$'\n'"## Bug 修复"$'\n'
  out="$out$(printf '%s\n' "${fix[@]}")"
fi
if [ "${#refactor[@]}" -gt 0 ]; then
  out="$out"$'\n'$'\n'"## 优化 / 重构 / 依赖"$'\n'
  out="$out$(printf '%s\n' "${refactor[@]}")"
fi
if [ "${#docs[@]}" -gt 0 ]; then
  out="$out"$'\n'$'\n'"## 文档"$'\n'
  out="$out$(printf '%s\n' "${docs[@]}")"
fi
if [ "${#other[@]}" -gt 0 ]; then
  out="$out"$'\n'$'\n'"## 其他"$'\n'
  out="$out$(printf '%s\n' "${other[@]}")"
fi

printf '%s\n' "$out"