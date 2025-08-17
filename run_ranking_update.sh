#!/bin/bash

# =================================================================================
# EmarkNews 랭킹 알고리즘 업데이트 및 배포 스크립트 (버전 4.0)
# =================================================================================
# 1. 'freshnessWeight' 함수를 새로운 동적 시간 감쇠 로직으로 교체합니다.
# 2. 변경사항이 적용되도록 PM2로 관리되는 애플리케이션을 재시작합니다.
#
# 사용법: 이 스크립트를 서버에 업로드하고 ./run_ranking_update.sh 를 실행하세요.
# =================================================================================

# --- 기본 설정 및 색상 코드 ---
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
TARGET_FILE="/home/ubuntu/_deploy_emarknews5/index.js" # 실제 파일 경로로 수정 완료
BACKUP_FILE="${TARGET_FILE}.bak.$(date +%F-%T)"

echo -e "${YELLOW}랭킹 알고리즘 업데이트를 시작합니다...${NC}"

# --- 1단계: 대상 파일 존재 여부 및 백업 ---
if [ ! -f "$TARGET_FILE" ]; then
  echo -e "${RED}오류: 대상 파일 '$TARGET_FILE'을 찾을 수 없습니다. 스크립트를 종료합니다.${NC}"
  exit 1
fi

echo "  - 원본 파일을 '$BACKUP_FILE' 이름으로 백업합니다..."
cp "$TARGET_FILE" "$BACKUP_FILE"
echo -e "${GREEN}  - 백업 완료.${NC}"

# --- 2단계: 새로운 freshnessWeight 함수 코드로 교체 ---
echo "  - 'freshnessWeight' 함수를 새로운 로직으로 교체합니다..."

# sed를 사용하여 기존 함수를 찾아 교체합니다.
# 참고: 이 sed 명령어는 제공된 이미지의 코드 형식을 기반으로 하며, 실제 코드에 따라 미세 조정이 필요할 수 있습니다.
sed -i "/const freshnessWeight = (ts) => {/,/};/c\
const freshnessWeight = (ts) => {\n\
  const now = new Date();\n\
  const currentDay = now.getUTCDay(); \/\/ 0:일요일, 1:월요일, ..., 6:토요일\n\
\n\
  \/\/ 주말(토, 일)에는 시간 감쇠를 완화하여 기사가 더 오래 높은 점수를 유지하도록 함\n\
  const isWeekend = (currentDay === 0 || currentDay === 6);\n\
  const TIME_DECAY_TAU_HOURS = isWeekend ? 120 : 72; \/\/ 주말: 120시간(5일), 주중: 72시간(3일)\n\
\n\
  const hours = (now.getTime() - ts) \/ (1000 * 60 * 60);\n\
  return Math.exp(-Math.max(0, hours) \/ TIME_DECAY_TAU_HOURS);\n\
};" "$TARGET_FILE"

echo -e "${GREEN}  - 코드 교체 완료.${NC}"

# --- 3단계: 서비스 재시작 ---
echo "  - 변경사항 적용을 위해 PM2 서비스를 재시작합니다..."
# PM2로 실행 중인 서비스 이름을 'emarknews'로 가정
if pm2 list | grep -q 'emarknews'; then
  pm2 reload emarknews
  echo -e "${GREEN}  - 서비스가 성공적으로 재시작되었습니다.${NC}"
else
  echo -e "${RED}  - 'emarknews' PM2 프로세스를 찾을 수 없습니다. 수동으로 재시작이 필요합니다.${NC}"
fi

echo -e "\n${GREEN}===================================================================${NC}"
echo -e "${GREEN}✅ 모든 작업이 완료되었습니다.${NC}"
echo -e "새로운 랭킹 알고리즘이 성공적으로 배포되었습니다."
echo -e "${GREEN}===================================================================${NC}"
