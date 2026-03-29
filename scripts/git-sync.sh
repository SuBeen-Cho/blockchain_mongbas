#!/bin/bash
# =============================================================
# git-sync.sh — 팀 몽바스 GitHub 동기화 자동화 스크립트
# 사용법: ./scripts/git-sync.sh "커밋 메시지"
# 예시:   ./scripts/git-sync.sh "feat: Merkle Tree 체인코드 구현"
# =============================================================

set -e  # 오류 발생 시 즉시 중단

# ─── 색상 코드 ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ─── 로그 함수 ───
log_info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ─── 커밋 메시지 확인 ───
COMMIT_MSG="$1"
if [ -z "$COMMIT_MSG" ]; then
  echo ""
  echo "사용법: ./scripts/git-sync.sh \"커밋 메시지\""
  echo ""
  echo "커밋 메시지 컨벤션:"
  echo "  feat:     새로운 기능 추가"
  echo "  fix:      버그 수정"
  echo "  test:     테스트 추가/수정"
  echo "  docs:     문서 수정"
  echo "  perf:     성능 개선"
  echo "  refactor: 리팩토링"
  echo ""
  log_error "커밋 메시지를 입력하세요."
fi

# ─── Git 레포 확인 ───
if ! git rev-parse --is-inside-work-tree &>/dev/null; then
  log_error "Git 레포지토리가 아닙니다. blockchain_mongbas 루트 디렉토리에서 실행하세요."
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
log_info "레포 루트: $REPO_ROOT"

# ─── 원격 저장소 확인 ───
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")
if [ -z "$REMOTE_URL" ]; then
  log_warn "원격 저장소(origin)가 설정되지 않았습니다."
  echo ""
  echo "원격 저장소를 연결하려면:"
  echo "  git remote add origin https://github.com/SuBeen-Cho/blockchain_mongbas.git"
  echo ""
  read -p "계속 진행하시겠습니까? (로컬 커밋만 생성됩니다) [y/N]: " CONT
  [ "$CONT" != "y" ] && exit 0
  SKIP_PUSH=true
else
  log_info "원격 저장소: $REMOTE_URL"
  SKIP_PUSH=false
fi

# ─── Step 1: 현재 상태 확인 ───
echo ""
log_info "현재 브랜치: $(git branch --show-current)"
log_info "변경된 파일:"
git status --short

# ─── Step 2: Pull (rebase) ───
if [ "$SKIP_PUSH" != "true" ]; then
  echo ""
  log_info "원격 저장소에서 최신 변경사항 가져오는 중..."

  if git pull origin "$(git branch --show-current)" --rebase; then
    log_ok "Pull 성공"
  else
    echo ""
    log_warn "Rebase 충돌이 발생했습니다!"
    echo ""
    echo "해결 방법:"
    echo "  1. 충돌 파일 수정 후: git add <파일> && git rebase --continue"
    echo "  2. Rebase 취소:       git rebase --abort"
    echo ""
    log_error "충돌을 해결한 후 다시 실행하세요."
  fi
fi

# ─── Step 3: 스테이징 ───
echo ""
log_info "변경 파일 스테이징..."

# 민감한 파일 확인 (실수 방지)
SENSITIVE_PATTERNS=(
  "*.pem" "*.key" "*.crt" "*.p12"
  ".env" "*.secret"
  "*/keystore/*" "*/signcerts/*" "*/cacerts/*"
)

FOUND_SENSITIVE=false
for PATTERN in "${SENSITIVE_PATTERNS[@]}"; do
  FILES=$(git ls-files --others --exclude-standard "$PATTERN" 2>/dev/null || true)
  if [ -n "$FILES" ]; then
    log_warn "민감한 파일 감지: $FILES"
    FOUND_SENSITIVE=true
  fi
done

if [ "$FOUND_SENSITIVE" = "true" ]; then
  echo ""
  echo "⚠️  위 파일들은 Git에 추가하지 않는 것을 권장합니다."
  echo "   crypto-config/ 및 개인키는 .gitignore에 포함되어야 합니다."
  read -p "계속 진행하시겠습니까? [y/N]: " CONT2
  [ "$CONT2" != "y" ] && exit 0
fi

git add -A
log_ok "스테이징 완료"

# 스테이징된 파일이 없으면 종료
if git diff --cached --quiet; then
  log_warn "커밋할 변경사항이 없습니다."
  exit 0
fi

echo ""
log_info "스테이징된 파일:"
git diff --cached --name-only | head -20

# ─── Step 4: 커밋 ───
echo ""
log_info "커밋 생성: $COMMIT_MSG"
git commit -m "$COMMIT_MSG"
log_ok "커밋 완료: $(git log --oneline -1)"

# ─── Step 5: Push ───
if [ "$SKIP_PUSH" != "true" ]; then
  echo ""
  CURRENT_BRANCH=$(git branch --show-current)
  log_info "원격 저장소로 푸시 중: origin/$CURRENT_BRANCH"

  if git push origin "$CURRENT_BRANCH"; then
    log_ok "푸시 완료!"
    echo ""
    echo "GitHub: https://github.com/SuBeen-Cho/blockchain_mongbas"
  else
    echo ""
    log_warn "푸시 실패. 다음 명령어로 수동 푸시하세요:"
    echo "  git push origin $CURRENT_BRANCH"
  fi
else
  log_warn "원격 저장소 미설정으로 Push를 건너뜁니다."
  echo "로컬 커밋만 생성되었습니다."
fi

echo ""
log_ok "완료! 최근 커밋:"
git log --oneline -3
