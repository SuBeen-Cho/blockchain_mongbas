#!/usr/bin/env bash
# build-showcase.sh — 소개 페이지 배포 폴더 생성 (Netlify 자동배포/수동 드래그 공용)
#   frontend/public/showcase4.html → showcase-dist/index.html
#   + frontend/public/showcase (JS·글꼴·도식 PNG·포스터) + logo + icons
#   글꼴과 라이브러리를 모두 폴더 안에 담아서 외부 서버 없이 뜬다. npm 빌드 불필요.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
OUT="showcase-dist"
PAGE="frontend/public/showcase4.html"
asset_dirs=(showcase logo icons)
[ -s "${PAGE}" ] || { echo "필수 입력 누락: ${PAGE}" >&2; exit 1; }
for d in "${asset_dirs[@]}"; do
  [ -d "frontend/public/${d}" ] || { echo "필수 입력 누락: frontend/public/${d}" >&2; exit 1; }
done

staging="$(mktemp -d "${OUT}.tmp.XXXXXX")"
cleanup() { [ -z "${staging:-}" ] || [ ! -d "${staging}" ] || rm -rf -- "${staging}"; }
trap cleanup EXIT
cp "${PAGE}" "${staging}/index.html"
for d in "${asset_dirs[@]}"; do cp -R "frontend/public/${d}" "${staging}/"; done
find "${staging}" -name '.DS_Store' -delete

# 페이지가 가리키는 파일이 모두 들어 있는지 확인
missing=0
while IFS= read -r ref; do
  [ -e "${staging}${ref}" ] || { echo "빠진 파일: ${ref}" >&2; missing=1; }
done < <(grep -oE '(src|href)="/[^"#]+"' "${staging}/index.html" | sed -E 's/^(src|href)="//; s/"$//' | sort -u)
[ "${missing}" -eq 0 ] || exit 1

rm -rf -- "${OUT}"
mv "${staging}" "${OUT}"
staging=""
echo "✓ ${OUT} 생성 (Netlify publish 폴더 / 또는 이 폴더를 드래그)"
