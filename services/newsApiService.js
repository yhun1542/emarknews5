const NewsAPI = require('newsapi');

// NewsAPI 클라이언트 초기화
let newsapi = null;
if (process.env.NEWS_API_KEY) {
  newsapi = new NewsAPI(process.env.NEWS_API_KEY);
  console.log('✅ [NewsAPI] NewsAPI 클라이언트 초기화 완료');
} else {
  console.warn('⚠️ [NewsAPI] NEWS_API_KEY 환경변수가 설정되지 않았습니다.');
}

/**
 * NewsAPI를 통해 기사를 가져오는 함수
 * @param {string} section - 뉴스 섹션
 * @returns {Array} - 기사 배열
 */
async function fetchArticlesFromNewsAPI(section) {
  if (!newsapi) {
    console.error('❌ [NewsAPI] NewsAPI 클라이언트가 초기화되지 않았습니다.');
    return [];
  }

  try {
    const params = getNewsAPIParams(section);
    console.log(`🔍 [NewsAPI] '${section}' 섹션 기사 요청: ${JSON.stringify(params)}`);
    
    const response = await newsapi.v2.topHeadlines(params);
    
    if (!response.articles || response.articles.length === 0) {
      console.warn(`⚠️ [NewsAPI] '${section}' 섹션에서 기사를 찾을 수 없습니다.`);
      return [];
    }

    const articles = response.articles.slice(0, 20).map(article => ({
      title: article.title || 'No Title',
      link: article.url || '',
      publishedAt: article.publishedAt || new Date().toISOString(),
      summary: article.description || '',
      content: article.content || article.description || '',
      source: article.source?.name || 'NewsAPI',
      sourceLang: getSectionLanguage(section),
      urgency: 0,
      buzz: 0
    }));

    console.log(`✅ [NewsAPI] '${section}' 섹션에서 ${articles.length}개 기사 수집 완료`);
    return articles;

  } catch (error) {
    console.error(`❌ [NewsAPI] '${section}' 섹션 기사 수집 실패: ${error.message}`);
    
    // API 키 관련 오류 힌트 제공
    if (error.message.includes('401')) {
      console.error('-> 힌트: NEWS_API_KEY가 유효하지 않거나 만료되었을 수 있습니다.');
    } else if (error.message.includes('429')) {
      console.error('-> 힌트: NewsAPI 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.');
    }
    
    return [];
  }
}

/**
 * 섹션별 NewsAPI 파라미터 생성
 * @param {string} section - 뉴스 섹션
 * @returns {Object} - NewsAPI 요청 파라미터
 */
function getNewsAPIParams(section) {
  const baseParams = {
    pageSize: 20,
    sortBy: 'publishedAt'
  };

  switch (section) {
    case 'world':
      return {
        ...baseParams,
        category: 'general',
        language: 'en'
      };
    
    case 'business':
      return {
        ...baseParams,
        category: 'business',
        language: 'en'
      };
    
    case 'korea':
      return {
        ...baseParams,
        country: 'kr',
        language: 'ko'
      };
    
    case 'japan':
      return {
        ...baseParams,
        country: 'jp',
        language: 'ja'
      };
    
    case 'buzz':
      return {
        ...baseParams,
        q: 'trending OR viral OR breaking',
        language: 'en',
        sortBy: 'popularity'
      };
    
    default:
      return {
        ...baseParams,
        category: 'general',
        language: 'en'
      };
  }
}

/**
 * 섹션별 언어 코드 반환
 * @param {string} section - 뉴스 섹션
 * @returns {string} - 언어 코드
 */
function getSectionLanguage(section) {
  switch (section) {
    case 'korea': return 'ko';
    case 'japan': return 'ja';
    default: return 'en';
  }
}

module.exports = {
  fetchArticlesFromNewsAPI
};

