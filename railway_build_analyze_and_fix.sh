#!/usr/bin/env bash
set -euo pipefail

# === 사용자/프로젝트 고정값 (요청하신 값 반영) ===
PROJECT_NAME="${PROJECT_NAME:-emarknews5}"
SERVICE_NAME="${SERVICE_NAME:-emarknews5}"
ENV_NAME="${ENV_NAME:-production}"
PROJECT_ID_DEFAULT="d02d4bbd-03ad-42fb-8ce9-e122b4bc0127"
SERVICE_ID_DEFAULT="83f6a239-528a-4366-9924-d80ed97841d8"

# === 옵션 ===
APPLY_FIXES=0           # --apply-fixes 주면 1
LINES="${LINES:-500}"   # 로그 라인 수

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply-fixes) APPLY_FIXES=1; shift;;
    --lines) LINES="$2"; shift 2;;
    -p|--project) PROJECT_NAME="$2"; shift 2;;
    -s|--service) SERVICE_NAME="$2"; shift 2;;
    *) echo "Unknown option: $1"; exit 1;;
  esac
done

# === 선행체크 ===
need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "필수 명령어 미설치: $1"; exit 1; }; }
need_cmd railway
need_cmd jq || { echo "jq 설치 필요 (brew install jq / apt-get install -y jq)"; exit 1; }

if ! railway whoami >/dev/null 2>&1; then
  echo "Railway 로그인이 필요합니다: railway login"
  exit 1
fi

echo "▶ 컨텍스트 링크"
railway link --project "$PROJECT_NAME" >/dev/null 2>&1 || true
railway link --service "$SERVICE_NAME" >/dev/null 2>&1 || true

echo "▶ 상태/변수/로그 수집"
railway status --json > .railway_status.json 2>/dev/null || echo "{}" > .railway_status.json
railway variables --json > .railway_vars.json 2>/dev/null || echo "[]"  > .railway_vars.json
railway logs --service "$SERVICE_NAME" --lines "$LINES" | tee .railway_logs.txt >/dev/null || true

APP_HEALTH=$(jq -r --arg s "$SERVICE_NAME" '.services[]?|select(.name==$s)|.health // empty' .railway_status.json || true)
APP_URL=$(jq -r --arg s "$SERVICE_NAME" '.services[]?|select(.name==$s)|.domain // empty' .railway_status.json || true)
echo "  서비스 상태: ${APP_HEALTH:-?} / 도메인: ${APP_URL:-?}"

# === 오류 패턴 정의 ===
declare -A HITS
pattern() { grep -Eiq "$1" .railway_logs.txt && HITS["$2"]=1 || true; }

# Build/Detect
pattern "Unable to detect build plan|Nixpacks.*detect|No build plan found" DETECT_FAIL
pattern "no such file or directory.*node|node: not found" NODE_NOT_FOUND
pattern "Command.*build.*not found|missing script: build" BUILD_SCRIPT_MISSING
pattern "npm ERR!|yarn ERR!|pnpm.*ERR" NPM_YARN_PNPM_ERR
pattern "node-gyp|gyp ERR|python|make: not found|build-essential" NATIVE_DEPS

# Start/PORT/Health
pattern "No start command found|did you mean start|Start command not found" START_MISSING
pattern "EADDRINUSE|address already in use" PORT_IN_USE
pattern "listening on 3000|Listening on 3000" LISTEN_3000
pattern "Health check failed|ECONNREFUSED|connect ECONNREFUSED|timed out waiting for" HEALTH_FAIL

# Runtime/Env/Network
pattern "Cannot find module|MODULE_NOT_FOUND" MODULE_NOT_FOUND
pattern "Out of memory|OOMKilled" OOM
pattern "ENOTFOUND|getaddrinfo|Name or service not known" DNS_FAIL
pattern "permission denied|EACCES" PERMISSION
pattern "401|403|Invalid API key|unauthorized" AUTH
pattern "REDIS|Redis.*(ECONNREFUSED|NOAUTH|WRONGPASS|getaddrinfo)" REDIS_CONN

# === 진단 결과 출력 ===
echo
echo "=== 진단 리포트 ==="
showhit() { [[ ${HITS[$1]+_} ]] && echo "• $2"; }
showhit DETECT_FAIL       "빌드 탐지 실패 (Nixpacks가 언어/프로젝트 감지 못함)"
showhit NODE_NOT_FOUND    "Node 실행환경 문제 (node 미발견)"
showhit BUILD_SCRIPT_MISSING "build 스크립트 누락/오류"
showhit NPM_YARN_PNPM_ERR "패키지 매니저 오류 (npm/yarn/pnpm)"
showhit NATIVE_DEPS       "네이티브 의존성 빌드 실패 (node-gyp/python/make 등)"
showhit START_MISSING     "Start 커맨드 누락/오설정"
showhit PORT_IN_USE       "PORT 충돌 (이중 프로세스/다중 리슨)"
showhit LISTEN_3000       "고정 포트(3000) 리슨 감지 → \$PORT 미사용 가능성"
showhit HEALTH_FAIL       "헬스체크 실패 (경로/지연/응답코드)"
showhit MODULE_NOT_FOUND  "런타임 모듈 누락 (의존성 설치/경로)"
showhit OOM               "메모리 부족/누수로 종료"
showhit DNS_FAIL          "DNS/네트워크 실패 (외부 API/DB)"
showhit PERMISSION        "권한 문제 (파일 실행/퍼미션/FS 권한)"
showhit AUTH              "자격증명/권한(401/403)"
showhit REDIS_CONN        "Redis 연결 이슈 (내부URL/패스워드/네트워크)"

if [[ ${#HITS[@]} -eq 0 ]]; then
  echo "• 특이 오류 패턴 미검출 — 로그를 더 늘려 확인하거나 대시보드 빌드로그도 확인 권장"
fi

# === 솔루션 매핑 ===
declare -a FIX_CMDS
addfix() { FIX_CMDS+=("$1"); }

# 공통 권장 변수
addfix "railway variables set NODE_ENV=production"

# 빌드 탐지 실패 → Procfile/Nixpacks 지정
[[ ${HITS[DETECT_FAIL]+_} ]] && addfix "railway variables set NIXPACKS_BUILD_CMD=\"npm run build\" NIXPACKS_START_CMD=\"npm run start\""

# Node/패키지 매니저
[[ ${HITS[NODE_NOT_FOUND]+_} ]] && addfix "railway variables set NIXPACKS_NODE_VERSION=\"20\""  # 필요 시 18/20 고정
[[ ${HITS[NPM_YARN_PNPM_ERR]+_} ]] && addfix "railway variables set NIXPACKS_PACKAGE_MANAGER=\"npm\""

# build 스크립트 누락
[[ ${HITS[BUILD_SCRIPT_MISSING]+_} ]] && addfix "👉 package.json의 scripts.build 를 정의하세요. 예: \"build\": \"next build\" 또는 \"tsc -p .\""

# Start/PORT/Health
[[ ${HITS[START_MISSING]+_} ]] && addfix "railway variables set NIXPACKS_START_CMD=\"npm run start\""
[[ ${HITS[PORT_IN_USE]+_} || ${HITS[LISTEN_3000]+_} ]] && addfix "👉 서버가 반드시 \$PORT로 listen 하도록 코드 수정 (0.0.0.0 바인딩)"
[[ ${HITS[HEALTH_FAIL]+_} ]] && addfix "railway variables set HEALTHCHECK_PATH=/healthz HEALTHCHECK_TIMEOUT=120"

# 네이티브 의존성
[[ ${HITS[NATIVE_DEPS]+_} ]] && addfix "railway variables set NIXPACKS_INSTALL_PKGS=\"python3 build-essential\""

# 모듈 누락
[[ ${HITS[MODULE_NOT_FOUND]+_} ]] && addfix "👉 package.json 의존성 확인 후 재빌드 (devDependencies→dependencies 이동 필요 여부 확인)"

# OOM
[[ ${HITS[OOM]+_} ]] && addfix "👉 메모리 사용량 감소 / 캐시 전략 / 플랜 상향. 임시로 RAILWAY_MEM_MB 상향(플랜별 가용치 확인)."

# DNS/권한/Auth/Redis
[[ ${HITS[DNS_FAIL]+_} ]] && addfix "👉 외부 호스트/포트/방화벽 및 VPC 설정 확인. 도메인 철자/프로토콜 확인."
[[ ${HITS[PERMISSION]+_} ]] && addfix "👉 실행 파일 권한 +x, 런타임 경로 권한 점검."
[[ ${HITS[AUTH]+_} ]] && addfix "👉 API 키/토큰/권한 범위 확인. Railway Variables 재등록 후 재배포."
[[ ${HITS[REDIS_CONN]+_} ]] && addfix "👉 동일 프로젝트 내 Redis Running 확인, 내부 URL 변수(REDIS_INTERNAL_URL) 설정 후 사용."

echo
echo "=== 권장 조치(명령어/가이드) ==="
i=1
for cmd in "${FIX_CMDS[@]}"; do
  printf "%2d) %s\n" "$i" "$cmd"
  ((i++))
done
[[ ${#FIX_CMDS[@]} -eq 0 ]] && echo "조치 목록 없음"

# === 자동 적용 ===
if [[ $APPLY_FIXES -eq 1 ]]; then
  echo
  echo "▶ 자동 변수 적용 시작 (--apply-fixes)"
  for cmd in "${FIX_CMDS[@]}"; do
    if [[ "$cmd" == 👉* ]]; then
      echo "$cmd"
    else
      echo "$cmd"
      bash -lc "$cmd" || true
    fi
  done
  echo "▶ 변수 적용 후 재배포"
  railway up --service "$SERVICE_NAME" --ci || true
fi

echo
echo "✅ 완료: .railway_status.json / .railway_vars.json / .railway_logs.txt 생성"
echo "   대시보드: https://railway.com/project/${PROJECT_ID_DEFAULT}/service/${SERVICE_ID_DEFAULT}"
echo "   공개도메인: emarknews.com"
