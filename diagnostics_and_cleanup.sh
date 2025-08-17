#!/bin/bash

# EmarkNews 진단 및 자동 정리 스크립트 v1.0
# RSS 피드 상태 진단, 정상 피드 선별, 자동 정리 기능

set -euo pipefail

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 로그 함수들
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_debug() { echo -e "${PURPLE}[DEBUG]${NC} $1"; }

# 설정
FEEDS_CONFIG="config/feeds.json"
HEALTHY_FEEDS_OUTPUT="config/feeds.healthy.json"
TIMEOUT=10
MAX_RETRIES=2
TEMP_DIR="/tmp/emarknews_diagnostics"
REPORT_FILE="diagnostics_report_$(date +%Y%m%d_%H%M%S).json"

# 임시 디렉토리 생성
mkdir -p "$TEMP_DIR"

log_info "🚀 EmarkNews RSS 피드 진단 시작..."
log_info "📅 실행 시간: $(date)"
log_info "📁 설정 파일: $FEEDS_CONFIG"
log_info "📊 보고서 파일: $REPORT_FILE"

# Node.js 및 필수 패키지 확인
check_dependencies() {
    log_info "🔍 의존성 확인 중..."
    
    if ! command -v node &> /dev/null; then
        log_error "Node.js가 설치되지 않았습니다."
        exit 1
    fi
    
    if ! command -v curl &> /dev/null; then
        log_error "curl이 설치되지 않았습니다."
        exit 1
    fi
    
    if ! command -v jq &> /dev/null; then
        log_warning "jq가 설치되지 않았습니다. JSON 파싱이 제한됩니다."
    fi
    
    log_success "✅ 모든 의존성 확인 완료"
}

# RSS 피드 테스트 함수
test_rss_feed() {
    local url="$1"
    local name="$2"
    local temp_file="$TEMP_DIR/feed_test_$(echo "$name" | tr ' ' '_').xml"
    
    log_debug "🔍 테스트 중: $name ($url)"
    
    # curl로 RSS 피드 다운로드 시도
    if curl -s --max-time "$TIMEOUT" --retry "$MAX_RETRIES" \
           -H "User-Agent: EmarkNews-Diagnostics/1.0" \
           -o "$temp_file" "$url"; then
        
        # 파일 크기 확인
        if [[ -s "$temp_file" ]]; then
            # XML 유효성 간단 확인
            if grep -q -E "<(rss|feed|channel)" "$temp_file" 2>/dev/null; then
                # 아이템 개수 확인
                local item_count
                item_count=$(grep -c -E "<(item|entry)" "$temp_file" 2>/dev/null || echo "0")
                
                if [[ "$item_count" -gt 0 ]]; then
                    log_success "✅ $name: $item_count개 기사 발견"
                    echo "healthy"
                    return 0
                else
                    log_warning "⚠️ $name: RSS 피드에 기사가 없습니다"
                    echo "empty"
                    return 1
                fi
            else
                log_error "❌ $name: 유효하지 않은 RSS/XML 형식"
                echo "invalid"
                return 1
            fi
        else
            log_error "❌ $name: 빈 응답"
            echo "empty_response"
            return 1
        fi
    else
        log_error "❌ $name: 연결 실패 (타임아웃 또는 네트워크 오류)"
        echo "connection_failed"
        return 1
    fi
}

# 메인 진단 함수
run_diagnostics() {
    log_info "🔬 RSS 피드 진단 실행 중..."
    
    if [[ ! -f "$FEEDS_CONFIG" ]]; then
        log_error "설정 파일을 찾을 수 없습니다: $FEEDS_CONFIG"
        exit 1
    fi
    
    # 진단 결과 저장용 변수들
    local total_feeds=0
    local healthy_feeds=0
    local failed_feeds=0
    local healthy_config="{}"
    
    # 진단 보고서 초기화
    local report="{\"timestamp\":\"$(date -Iseconds)\",\"sections\":{}}"
    
    # 각 섹션별로 피드 테스트
    for section in world business korea japan buzz; do
        log_info "📰 $section 섹션 진단 중..."
        
        # jq가 있으면 사용, 없으면 간단한 파싱
        if command -v jq &> /dev/null; then
            local feeds_in_section
            feeds_in_section=$(jq -r ".$section[]? | @base64" "$FEEDS_CONFIG" 2>/dev/null || echo "")
            
            if [[ -n "$feeds_in_section" ]]; then
                local section_healthy_feeds="[]"
                local section_stats="{\"total\":0,\"healthy\":0,\"failed\":0,\"feeds\":[]}"
                
                while IFS= read -r feed_data; do
                    if [[ -n "$feed_data" ]]; then
                        local feed_json
                        feed_json=$(echo "$feed_data" | base64 -d)
                        local feed_name
                        feed_name=$(echo "$feed_json" | jq -r '.name')
                        local feed_url
                        feed_url=$(echo "$feed_json" | jq -r '.url')
                        
                        ((total_feeds++))
                        local status
                        status=$(test_rss_feed "$feed_url" "$feed_name")
                        
                        local feed_result="{\"name\":\"$feed_name\",\"url\":\"$feed_url\",\"status\":\"$status\",\"tested_at\":\"$(date -Iseconds)\"}"
                        section_stats=$(echo "$section_stats" | jq ".feeds += [$feed_result]")
                        section_stats=$(echo "$section_stats" | jq ".total += 1")
                        
                        if [[ "$status" == "healthy" ]]; then
                            ((healthy_feeds++))
                            section_healthy_feeds=$(echo "$section_healthy_feeds" | jq ". += [$feed_json]")
                            section_stats=$(echo "$section_stats" | jq ".healthy += 1")
                        else
                            ((failed_feeds++))
                            section_stats=$(echo "$section_stats" | jq ".failed += 1")
                        fi
                    fi
                done <<< "$feeds_in_section"
                
                # 정상 피드가 있으면 healthy_config에 추가
                if [[ "$(echo "$section_healthy_feeds" | jq 'length')" -gt 0 ]]; then
                    healthy_config=$(echo "$healthy_config" | jq ".$section = $section_healthy_feeds")
                fi
                
                # 보고서에 섹션 통계 추가
                report=$(echo "$report" | jq ".sections.$section = $section_stats")
            else
                log_warning "⚠️ $section 섹션에 피드가 없거나 파싱할 수 없습니다"
            fi
        else
            log_warning "⚠️ jq가 없어 $section 섹션을 건너뜁니다"
        fi
    done
    
    # 전체 통계 추가
    report=$(echo "$report" | jq ".summary = {\"total_feeds\":$total_feeds,\"healthy_feeds\":$healthy_feeds,\"failed_feeds\":$failed_feeds,\"success_rate\":$(echo "scale=2; $healthy_feeds * 100 / $total_feeds" | bc -l 2>/dev/null || echo "0")}")
    
    # 정상 피드 설정 파일 저장
    echo "$healthy_config" | jq '.' > "$HEALTHY_FEEDS_OUTPUT"
    
    # 진단 보고서 저장
    echo "$report" | jq '.' > "$REPORT_FILE"
    
    # 결과 출력
    log_info "📊 진단 결과 요약:"
    log_info "   총 피드 수: $total_feeds"
    log_success "   정상 피드: $healthy_feeds"
    log_error "   실패 피드: $failed_feeds"
    
    if [[ $total_feeds -gt 0 ]]; then
        local success_rate
        success_rate=$(echo "scale=1; $healthy_feeds * 100 / $total_feeds" | bc -l 2>/dev/null || echo "0")
        log_info "   성공률: ${success_rate}%"
    fi
    
    log_success "✅ 정상 피드 설정 저장: $HEALTHY_FEEDS_OUTPUT"
    log_success "✅ 상세 보고서 저장: $REPORT_FILE"
}

# 정리 함수
cleanup() {
    log_info "🧹 임시 파일 정리 중..."
    rm -rf "$TEMP_DIR"
    log_success "✅ 정리 완료"
}

# 사용법 출력
show_usage() {
    echo "사용법: $0 [옵션]"
    echo ""
    echo "옵션:"
    echo "  -h, --help     이 도움말 표시"
    echo "  -t, --timeout  RSS 피드 테스트 타임아웃 (기본값: 10초)"
    echo "  -r, --retries  재시도 횟수 (기본값: 2)"
    echo "  -v, --verbose  상세 로그 출력"
    echo ""
    echo "예시:"
    echo "  $0                    # 기본 설정으로 진단 실행"
    echo "  $0 -t 15 -r 3        # 15초 타임아웃, 3회 재시도"
    echo "  $0 --verbose         # 상세 로그와 함께 실행"
}

# 명령행 인수 처리
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_usage
            exit 0
            ;;
        -t|--timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        -r|--retries)
            MAX_RETRIES="$2"
            shift 2
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        *)
            log_error "알 수 없는 옵션: $1"
            show_usage
            exit 1
            ;;
    esac
done

# 메인 실행
main() {
    log_info "🎯 EmarkNews RSS 피드 진단 및 정리 도구"
    log_info "⚙️ 설정: 타임아웃=${TIMEOUT}초, 재시도=${MAX_RETRIES}회"
    
    # 의존성 확인
    check_dependencies
    
    # 진단 실행
    run_diagnostics
    
    # 정리
    cleanup
    
    log_success "🎉 진단 완료! 정상 피드 설정을 사용하려면:"
    log_info "   cp $HEALTHY_FEEDS_OUTPUT $FEEDS_CONFIG"
    log_info "   git add $FEEDS_CONFIG && git commit -m 'Update feeds with healthy sources only'"
}

# 스크립트 종료 시 정리
trap cleanup EXIT

# 메인 함수 실행
main "$@"

