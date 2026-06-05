#!/usr/bin/env bash
# build-showcase.sh — 쇼케이스 배포 폴더 생성 (Netlify 자동배포/수동 드래그 공용)
#   frontend/public/showcase3.html → showcase-dist/index.html + 에셋(logo·icons·shapes·shots)
#   정적 파일이라 npm 빌드 불필요.
set -e
cd "$(dirname "$0")/.."
OUT="showcase-dist"
rm -rf "$OUT"; mkdir -p "$OUT"
cp frontend/public/showcase3.html "$OUT/index.html"
cp -R frontend/public/logo frontend/public/icons frontend/public/shapes frontend/public/shots "$OUT/" 2>/dev/null || true
echo "✓ $OUT 생성 (Netlify publish 폴더 / 또는 이 폴더를 드래그)"
