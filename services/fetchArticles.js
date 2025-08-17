const Parser = require('rss-parser');
const feeds = require('../config/feeds.json');
const { fetchArticlesFromNewsAPI } = require('./newsApiService');

const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'EmarkNews/4.7.0 (+https://emarknews.com)'
  }
});

/**
 * RSS 피드에서 기사를 가져오는 함수
 * @param {string} feedUrl - RSS 피드 URL
 * @param {string} feedName - 피드 이름 (로깅용)
 * @returns {Array|null} - 기사 배열 또는 null (실패 시)
 */
async function fetchFromRSS(feedUrl, feedName) {
  try {
    console.log(`🔍 [RSS] '${feedName}' 피드 연결 시도: ${feedUrl}`);
    const feed = await parser.parseURL(feedUrl);
    
    if (!feed.items || feed.items.length === 0) {
      console.warn(`⚠️ [RSS] '${feedName}' 피드에서 기사를 찾을 수 없습니다.`);
      return null;
    }

    const articles = feed.items.slice(0, 20).map(item => ({
      title: item.title || 'No Title',
      link: item.link || item.guid || '',
      publishedAt: item.pubDate || item.isoDate || new Date().toISOString(),
      summary: item.contentSnippet || item.summary || item.content || '',
      content: item.content || item.contentSnippet || '',
      source: feedName,
      sourceLang: detectLanguage(item.title || ''),
      urgency: 0,
      buzz: 0
    }));

    console.log(`✅ [RSS] '${feedName}'에서 기사 ${articles.length}개 수집 성공.`);
    return articles;
    
  } catch (error) {
    console.warn(`⚠️ [RSS] '${feedName}' RSS 피드 연결 실패: ${feedUrl}. 오류: ${error.message}`);
    return null;
  }
}

/**
 * 언어 감지 함수 (간단한 휴리스틱)
 * @param {string} text - 분석할 텍스트
 * @returns {string} - 언어 코드 (ko, ja, en)
 */
function detectLanguage(text) {
  if (!text) return 'en';
  
  // 한국어 감지 (한글 문자)
  if (/[가-힣]/.test(text)) return 'ko';
  
  // 일본어 감지 (히라가나, 가타카나, 한자)
  if (/[ひらがなカタカナ一-龯]/.test(text)) return 'ja';
  
  // 기본값은 영어
  return 'en';
}

/**
 * 특정 섹션의 기사를 수집하는 메인 함수
 * @param {string} section - 뉴스 섹션 (world, business, korea, japan, buzz)
 * @returns {Array} - 수집된 기사 배열
 */
async function fetchArticlesForSection(section) {
  const feedList = feeds[section] || [];
  
  if (feedList.length === 0) {
    console.warn(`⚠️ [RSS] '${section}' 섹션에 대한 RSS 피드가 설정되지 않았습니다.`);
    return await fallbackToNewsAPI(section);
  }

  console.log(`🚀 [RSS] '${section}' 섹션 기사 수집 시작. ${feedList.length}개 피드 시도...`);

  // RSS 피드들을 순차적으로 시도
  for (const feed of feedList) {
    const articles = await fetchFromRSS(feed.url, feed.name);
    if (articles && articles.length > 0) {
      console.log(`✅ [RSS] '${section}' 섹션 수집 완료: ${articles.length}개 기사`);
      return articles;
    }
  }

  // 모든 RSS 피드가 실패한 경우 NewsAPI로 폴백
  console.error(`❌ [RSS] '${section}' 섹션의 모든 RSS 피드 실패. NewsAPI로 전환합니다.`);
  return await fallbackToNewsAPI(section);
}

/**
 * NewsAPI로 폴백하는 함수
 * @param {string} section - 뉴스 섹션
 * @returns {Array} - 수집된 기사 배열
 */
async function fallbackToNewsAPI(section) {
  try {
    console.log(`🔄 [Fallback] NewsAPI를 통한 '${section}' 섹션 기사 수집 시도...`);
    const articlesFromNewsAPI = await fetchArticlesFromNewsAPI(section);
    
    if (articlesFromNewsAPI && articlesFromNewsAPI.length > 0) {
      console.log(`✅ [Fallback] NewsAPI에서 기사 ${articlesFromNewsAPI.length}개 수집 성공.`);
      return articlesFromNewsAPI;
    } else {
      console.warn(`⚠️ [Fallback] NewsAPI에서도 '${section}' 섹션의 기사를 가져오지 못했습니다.`);
      return [];
    }
  } catch (error) {
    console.error(`🚨 [Fallback] NewsAPI 호출 중 심각한 오류 발생: ${error.message}`);
    return [];
  }
}

/**
 * 모든 RSS 피드의 상태를 진단하는 함수
 * @returns {Object} - 피드별 상태 정보
 */
async function diagnoseFeedHealth() {
  const healthReport = {};
  
  for (const [section, feedList] of Object.entries(feeds)) {
    healthReport[section] = [];
    
    for (const feed of feedList) {
      const startTime = Date.now();
      const articles = await fetchFromRSS(feed.url, feed.name);
      const responseTime = Date.now() - startTime;
      
      healthReport[section].push({
        name: feed.name,
        url: feed.url,
        status: articles ? 'healthy' : 'failed',
        articleCount: articles ? articles.length : 0,
        responseTime: responseTime,
        lastChecked: new Date().toISOString()
      });
    }
  }
  
  return healthReport;
}

module.exports = { 
  fetchArticlesForSection,
  diagnoseFeedHealth,
  fetchFromRSS
};

