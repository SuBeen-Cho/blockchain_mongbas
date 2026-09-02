#!/usr/bin/env bash
# build-showcase.sh — 쇼케이스 배포 폴더 생성 (Netlify 자동배포/수동 드래그 공용)
#   frontend/public/showcase3.html → showcase-dist/index.html + 에셋(logo·icons·shapes·shots)
#   정적 파일이라 npm 빌드 불필요.
set -Eeuo pipefail
cd "$(dirname "$0")/.."
OUT="showcase-dist"
inputs=(frontend/public/showcase3.html frontend/public/logo frontend/public/icons frontend/public/shots)
for input in "${inputs[@]}"; do
  [ -e "${input}" ] || { echo "필수 showcase 입력 누락: ${input}" >&2; exit 1; }
done

staging="$(mktemp -d "${OUT}.tmp.XXXXXX")"
cleanup() { [ -z "${staging:-}" ] || [ ! -d "${staging}" ] || rm -rf -- "${staging}"; }
trap cleanup EXIT
cp frontend/public/showcase3.html "${staging}/index.html"
cp -R frontend/public/logo frontend/public/icons frontend/public/shots "${staging}/"
[ -s "${staging}/index.html" ] || { echo "showcase index가 비어 있습니다." >&2; exit 1; }
for asset_dir in logo icons shots; do
  find "${staging}/${asset_dir}" -type f -print -quit | grep -q . || {
    echo "showcase 에셋 디렉터리가 비어 있습니다: ${asset_dir}" >&2
    exit 1
  }
done
rm -rf -- "${OUT}"
mv "${staging}" "${OUT}"
staging=""
echo "✓ $OUT 생성 (Netlify publish 폴더 / 또는 이 폴더를 드래그)"
