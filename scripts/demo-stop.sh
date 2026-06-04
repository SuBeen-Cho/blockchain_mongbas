#!/usr/bin/env bash
# demo-stop.sh — 백엔드 + 공개터널 중지 (블록체인 네트워크는 유지)
echo "백엔드/터널 중지..."
pkill -f "node src/app.js"     2>/dev/null && echo "  ✓ 백엔드 중지" || echo "  - 백엔드 이미 꺼짐"
pkill -f "cloudflared tunnel"  2>/dev/null && echo "  ✓ 공개터널 중지" || echo "  - 터널 이미 꺼짐"
echo "블록체인 네트워크는 그대로 둡니다."
echo "(블록체인까지 완전히 내리려면: cd network && ./scripts/network.sh down)"
