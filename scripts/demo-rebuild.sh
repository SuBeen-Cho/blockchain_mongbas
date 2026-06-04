#!/usr/bin/env bash
# demo-rebuild.sh — 화면(프론트) 코드만 바꿨을 때: 빌드만 새로 (백엔드/터널/블록체인 그대로)
#   터널 주소 안 바뀜. 공개 주소 새로고침만 하면 적용됨.
cd "$(dirname "$0")/.."
echo "[빌드] 프론트엔드 재빌드..."
(cd frontend && npm run build) && echo "✓ 완료 — 공개 주소 새로고침하면 적용됩니다 (백엔드/터널 재시작 불필요)"
