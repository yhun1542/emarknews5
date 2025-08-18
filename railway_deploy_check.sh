#!/usr/bin/env bash
set -euo pipefail

# === 사용자 입력 섹션 ===
# 프로젝트/서비스를 지정하면 정확도가 높다. 미지정 시 현재 디렉토리/연결 기준.
PROJECT_NAME="${PROJECT_NAME:-}"
SERVICE_NAME="${SERVICE_NAME:-}"      # ex) "web" 또는 "backend"
EXPECTS_HEALTH_PATH="${EXPECTS_HEALTH_PATH:-/healthz}"
EXPECTS_RUNTIME_PORT_VAR="${EXPECTS_RUNTIME_PORT_VAR:-PORT}"

echo "▷ Railway 배포 자동 점검 시작"

# 0) 로그인/컨텍스트
if ! command -v railway >/dev/null 2>&1; then
  echo "✗ railway CLI 미설치. 설치 후 재실행 요망."
  exit 1
fi

if ! railway whoami >/dev/null 2>&1; then
  echo "✗ railway 로그인 필요: railway login"
  exit 1
fi

# 1) 프로젝트/서비스 확인
echo "→ 프로젝트/서비스 확인"
railway status || true

if [[ -n "$PROJECT_NAME" ]]; then
  railway link --project "$PROJECT_NAME" >/dev/null 2>&1 || true
fi
if [[ -n "$SERVICE_NAME" ]]; then
  railway link --service "$SERVICE_NAME" >/dev/null 2>&1 || true
fi

# 2) 환경변수 점검
echo
echo "→ 환경변수 확인"
railway variables --json | tee .railway_env.json >/dev/null || true

missing_env=()
need_env=("NODE_ENV" "$EXPECTS_RUNTIME_PORT_VAR")
for key in "${need_env[@]}"; do
  if ! jq -e --arg k "$key" '.[] | select(.key==$k)' .railway_env.json >/dev/null 2>&1; then
    missing_env+=("$key")
  fi
done

if ((${#missing_env[@]} > 0)); then
  echo "⚠️  누락된 환경변수: ${missing_env[*]}"
  echo "   예) railway variables set ${missing_env[0]}=production"
else
  echo "✓ 필수 환경변수 존재"
fi

# 3) 최근 배포 로그 스캔
echo
echo "→ 최근 로그(마지막 200줄) 확인"
railway logs --lines 200 | tee .railway_logs_tail.txt || true

echo
echo "→ 흔한 오류 패턴 진단"
if grep -Eiq "Unable to detect|Nixpacks|build plan" .railway_logs_tail.txt; then
  echo "✗ 빌드 탐지 실패: Procfile 또는 NIXPACKS_* 설정 필요"
fi
if grep -Eiq "EADDRINUSE|address already in use" .railway_logs_tail.txt; then
  echo "✗ 포트 충돌: 단일 프로세스만 listen, ${EXPECTS_RUNTIME_PORT_VAR} 사용 확인"
fi
if grep -Eiq "Health check failed|ECONNREFUSED" .railway_logs_tail.txt; then
  echo "✗ 헬스체크 실패: ${EXPECTS_HEALTH_PATH} 200 응답 제공 및 초기 지연 고려(HEALTHCHECK_TIMEOUT)"
fi
if grep -Eiq "OOMKilled|out of memory" .railway_logs_tail.txt; then
  echo "✗ 메모리 부족: 리소스 상향 또는 메모리 최적화 필요"
fi
if grep -Eiq "permission denied|401|403|invalid api key|ENOTFOUND" .railway_logs_tail.txt; then
  echo "✗ 자격증명/네트워크 이슈: 환경변수/시크릿/사설 네트워크 점검"
fi

# 4) 포트 바인딩 자동 점검(선택)
echo
echo "→ 포트 바인딩 가이드"
cat <<'TIP'
- 앱은 반드시 환경변수 PORT로 listen 해야 합니다.
  Node 예: server.listen(process.env.PORT || 3000, '0.0.0.0')
TIP

# 5) Redis/Internal URL 안내
echo
echo "→ Redis/Internal URL 체크 가이드"
cat <<'REDIS'
- 같은 프로젝트 내 Redis와 App이 모두 'Running'이어야 내부 URL이 노출됩니다.
- Railway 대시보드 > Redis > Connection에서 제공하는 URL을 그대로 사용하세요.
- 다른 프로젝트/환경이면 내부 URL이 보이지 않습니다.
REDIS

echo
echo "▷ 기본 점검 완료. 위 권고대로 수정 후 재배포 권장: railway up"
