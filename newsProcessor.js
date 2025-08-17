/*
 * EmarkNews News Processor Module (v1.0)
 * 뉴스 수집, AI 요약, 번역 등의 무거운 처리 로직을 담당하는 별도 모듈
 * 비동기 아키텍처를 위한 백그라운드 처리 전용
 */

"use strict";

// Load environment variables
require('dotenv').config();

const axios = require("axios");
const math = require("mathjs");
const cheerio = require("cheerio");

// 3rd Party APIs
const OpenAI = require("openai");
const { TranslationServiceClient } = require("@google-cloud/translate").v3;
const redis = require("redis");
const NewsAPI = require("newsapi");
const Parser = require("rss-parser");
const fs = require('fs');

/* 환경 변수 로드 */
const {
  NEWS_API_KEY = "",
  NEWS_API_KEYS = "",
  OPENAI_API_KEY = "",
  OPENAI_MODEL = "gpt-4o-mini",
  GOOGLE_PROJECT_ID = "",
  TRANSLATE_API_KEY = "",
  REDIS_URL = "",
  NAVER_CLIENT_ID = "",
  NAVER_CLIENT_SECRET = "",
  YOUTUBE_API_KEY = "",
  NODE_ENV = "development",
  LOG_LEVEL = "info",
  GOOGLE_APPLICATION_CREDENTIALS_JSON = ""
} = process.env;

// 로그 레벨 설정
const isDebug = LOG_LEVEL === 'debug';
const isVerbose = LOG_LEVEL === 'verbose' || isDebug;

console.log(`📊 [NewsProcessor] Starting with LOG_LEVEL: ${LOG_LEVEL}`);

/* 상수/유틸 */
const NOW = () => Date.now();
const HOUR = 3600 * 1000;
const TIME_DECAY_TAU_HOURS = 48;
const SIGNATURE_TOPK = 12;
const MAX_CLUSTER_SIZE = 100;

const STOP_WORDS = new Set([
  "그","이","저","것","수","등","및","에서","으로","하다","했다","지난","오늘","내일",
  "대한","관련","위해","그리고","하지만","또한","모든","기사","속보","단독",
  "the","a","an","and","or","but","is","are","was","were","to","of","in","on","for","with","by","from",
  "at","as","that","this","these","those","be","been","it","its","into","about","their","his","her",
  "you","your","we","our","they","them","he","she"
]);

const SOURCE_QUALITY = {
  "reuters.com": 1.15,
  "apnews.com": 1.12,
  "bbc.com": 1.10,
  "nytimes.com": 1.10,
  "wsj.com": 1.08,
  "bloomberg.com": 1.08,
  "chosun.com": 1.15,
  "joins.com": 1.12,
  "donga.com": 1.11,
  "hani.co.kr": 1.10,
  "kbs.co.kr": 1.10,
  "ytn.co.kr": 1.08,
  "imbc.com": 1.08,
  "yonhapnewstv.co.kr": 1.09,
  "nhk.or.jp": 1.15,
  "asahi.com": 1.12,
  "mainichi.jp": 1.10,
  "yomiuri.co.jp": 1.08,
  "nypost.com": 1.12,
  "cnbc.com": 1.11,
  "youtube.com": 1.05
};

// OpenAI 클라이언트 초기화
let openai = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  console.log('✅ [NewsProcessor] OpenAI client initialized');
} else {
  console.warn('⚠️ [NewsProcessor] OPENAI_API_KEY not found');
}

// Google Translate 클라이언트 초기화
let translateClient = null;
if (GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    const credentials = JSON.parse(GOOGLE_APPLICATION_CREDENTIALS_JSON);
    translateClient = new TranslationServiceClient({ credentials });
    console.log('✅ [NewsProcessor] Google Translate client initialized from JSON');
  } catch (e) {
    console.error('❌ [NewsProcessor] Google Translate initialization error:', e.message);
  }
}

// Redis 클라이언트 초기화
let redisClient = null;
const CACHE_DISABLED = process.env.DISABLE_CACHE === '1';

if (!CACHE_DISABLED && REDIS_URL) {
  console.log('ℹ️ [NewsProcessor] Attempting to connect to Redis...');
  try {
    const client = redis.createClient({ url: REDIS_URL });
    client.on('error', (err) => {
      console.warn('⚠️ [NewsProcessor] Redis Runtime Error:', err.message);
    });

    client.connect().then(() => {
      console.log('✅ [NewsProcessor] Redis connected');
      redisClient = client;
    }).catch((err) => {
      console.warn('❌ [NewsProcessor] Redis connection failed:', err.message);
    });
  } catch (err) {
    console.warn('❌ [NewsProcessor] Redis client creation failed:', err.message);
  }
}

// RSS Parser 초기화
const rssParser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "EmarkNewsBot/1.0 (+https://emarknews.com)"
  }
});

// NewsAPI 클라이언트 초기화
let newsapi = null;
if (NEWS_API_KEY) {
  newsapi = new NewsAPI(NEWS_API_KEY);
  console.log('✅ [NewsProcessor] NewsAPI client initialized');
}

/* 유틸리티 함수들 */
function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return "";
  }
}

function freshnessWeight(publishedAt) {
  if (!publishedAt) return 0.9;
  const ts = typeof publishedAt==="string" ? Date.parse(publishedAt) : +publishedAt;
  if (!Number.isFinite(ts)) return 0.9;
  
  // 동적 시간 감쇠 로직: 주중/주말 구분
  const now = new Date();
  const currentDay = now.getUTCDay(); // 0:일요일, 1:월요일, ..., 6:토요일

  // 주말(토, 일)에는 시간 감쇠를 완화하여 기사가 더 오래 높은 점수를 유지하도록 함
  const isWeekend = (currentDay === 0 || currentDay === 6);
  const TIME_DECAY_TAU_HOURS = isWeekend ? 120 : 72; // 주말: 120시간(5일), 주중: 72시간(3일)

  const hours = (now.getTime() - ts) / (1000 * 60 * 60);
  const w = Math.exp(-Math.max(0, hours) / TIME_DECAY_TAU_HOURS);
  return Math.min(1.0, Math.max(0.2, w));
}

function sourceWeight(url) {
  const d = getDomain(url);
  return SOURCE_QUALITY[d] || 1.0;
}

/* 뉴스 수집 함수들 */
const { fetchArticlesForSection: fetchArticlesWithFallback } = require('./services/fetchArticles');

/* 지능형 재시도 헬퍼 함수 */
const openaiRequestWithRetry = async (payload, attempt = 1) => {
  const MAX_ATTEMPTS = parseInt(process.env.AI_RETRY_ATTEMPTS, 10) || 3;
  try {
    // 실제 OpenAI API 호출 부분
    return await openai.chat.completions.create(payload);
  } catch (error) {
    if (error.status === 429 && attempt <= MAX_ATTEMPTS) {
      const waitSeconds = Math.pow(2, attempt);
      console.warn(`🔄 [OpenAI] 429 Rate Limit. ${waitSeconds}초 후 재시도합니다... (시도 ${attempt}/${MAX_ATTEMPTS})`);
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
      return openaiRequestWithRetry(payload, attempt + 1);
    } else {
      // 재시도를 초과했거나 다른 종류의 에러일 경우, 에러를 던져서 상위 로직이 처리하게 함
      throw error;
    }
  }
};

/* AI 요약 함수 (개선된 버전) */
async function generateAISummary(text, lang = 'en') {
  if (!openai || !text) return null;
  
  try {
    const prompt = lang === 'ko' 
      ? `다음 뉴스 기사를 3-4개의 핵심 포인트로 요약해주세요. 각 포인트는 한 줄로 작성하고 "•"로 시작하세요:\n\n${text}`
      : `Summarize the following news article into 3-4 key bullet points. Each point should be one line starting with "•":\n\n${text}`;

    const payload = {
      model: OPENAI_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0.3
    };

    const response = await openaiRequestWithRetry(payload);
    return response.choices[0]?.message?.content?.trim() || null;
  } catch (error) {
    console.error('❌ [NewsProcessor] AI summary error:', error.message);
    return null;
  }
}

/* 번역 함수 */
async function translateText(text, targetLang = 'ko') {
  if (!translateClient || !text || text.length < 10) return text;
  
  try {
    const [response] = await translateClient.translateText({
      parent: `projects/${GOOGLE_PROJECT_ID}/locations/global`,
      contents: [text],
      mimeType: 'text/plain',
      sourceLanguageCode: 'en',
      targetLanguageCode: targetLang,
    });

    return response.translations[0]?.translatedText || text;
  } catch (error) {
    console.error('❌ [NewsProcessor] Translation error:', error.message);
    return text;
  }
}

/* 방어적 점수 계산 함수 */
const calculateScore = (article) => {
  try {
    const freshness = (article.freshnessWeight || 0) * 100;
    const buzz = article.buzzScore || 0;
    const sourceReputation = article.source?.reputationScore || 0;

    const weights = { freshness: 0.5, buzz: 0.3, source: 0.2 };

    const finalScore = freshness * weights.freshness + buzz * weights.buzz + sourceReputation * weights.source;

    return {
      finalScore: Math.round(finalScore),
      breakdown: {
        freshness: Math.round(freshness * weights.freshness),
        buzz: Math.round(buzz * weights.buzz),
        source: Math.round(sourceReputation * weights.source),
      },
    };
  } catch (error) {
    console.error(`🚨 점수 계산 중 오류 발생: article.title = ${article.title}`, error);
    return {
      finalScore: 0,
      breakdown: { error: error.message },
    };
  }
};

/* Buzz 점수 계산 함수 */
async function getBuzzScore(url) {
  try {
    // 간단한 buzz 점수 계산 (실제로는 소셜 미디어 API 등을 사용)
    const domain = getDomain(url);
    const buzzMultiplier = {
      'reuters.com': 0.8,
      'bbc.com': 0.7,
      'cnn.com': 0.6,
      'techcrunch.com': 0.9,
      'default': 0.5
    };
    
    return (buzzMultiplier[domain] || buzzMultiplier.default) * 100;
  } catch (error) {
    console.error('❌ [NewsProcessor] Buzz score calculation error:', error.message);
    return 0;
  }
}

/* 소스 정보 가져오기 함수 */
function getSourceInfo(sourceName) {
  const sourceDatabase = {
    'Reuters': { reputationScore: 95 },
    'BBC': { reputationScore: 90 },
    'CNN': { reputationScore: 85 },
    'NPR': { reputationScore: 88 },
    'TechCrunch': { reputationScore: 75 },
    'Japan Times': { reputationScore: 80 },
    'Financial Times': { reputationScore: 92 }
  };
  
  return sourceDatabase[sourceName] || { reputationScore: 70 };
}

/* 개선된 기사 처리 파이프라인 */
async function processSingleArticle(article) {
  try {
    // 기존 AI 요약, 번역 로직
    if (article.content || article.summary) {
      const textToSummarize = article.content || article.summary;
      article.aiSummary = await generateAISummary(textToSummarize, article.sourceLang || 'en');
    }

    // 번역 (영어 기사만)
    if (article.sourceLang === 'en') {
      if (article.title) {
        article.titleKo = await translateText(article.title, 'ko');
      }
      if (article.summary) {
        article.summaryKo = await translateText(article.summary, 'ko');
      }
    }

    // Buzz 점수 계산
    const buzzScore = await getBuzzScore(article.link || article.url);

    // 기사 데이터 보강
    const enrichedArticle = {
      ...article,
      freshnessWeight: freshnessWeight(article.publishedAt || article.timestamp),
      buzzScore: buzzScore,
      source: getSourceInfo(article.sourceName || article.source?.name || 'Unknown'),
    };

    // 점수 계산
    const scoreResult = calculateScore(enrichedArticle);

    // 최종 기사 객체 생성
    const finalArticle = {
      ...enrichedArticle,
      score: scoreResult.finalScore,
      rating: Math.round(scoreResult.finalScore / 20),
      scoreBreakdown: scoreResult.breakdown,
    };

    // 낮은 점수 경고
    if (finalArticle.score < 10 && finalArticle.scoreBreakdown.error === undefined) {
      console.warn(`⚠️ 낮은 점수(${finalArticle.score}) 기사 발견: ${finalArticle.title}`, { 
        breakdown: finalArticle.scoreBreakdown 
      });
    }

    return finalArticle;
  } catch (error) {
    console.error('❌ [NewsProcessor] Single article processing error:', error.message);
    // 에러 발생 시에도 기본 점수 할당
    return {
      ...article,
      score: 1,
      rating: 1,
      scoreBreakdown: { error: error.message },
      freshnessWeight: 0.1,
      buzzScore: 0,
      source: { reputationScore: 0 }
    };
  }
}

/* 기사 처리 파이프라인 (기존 함수 대체) */
async function processArticle(article, targetLang = 'ko') {
  return await processSingleArticle(article);
}

/* 클러스터링 함수 */
function clusterArticles(articles) {
  if (!articles || articles.length === 0) return [];

  // 간단한 제목 기반 클러스터링
  const clusters = [];
  const processed = new Set();

  for (let i = 0; i < articles.length; i++) {
    if (processed.has(i)) continue;

    const cluster = {
      id: clusters.length + 1,
      articles: [articles[i]],
      mainTitle: articles[i].title,
      totalScore: articles[i].score || 0,
      rating: articles[i].rating || 0
    };

    // 유사한 기사 찾기
    for (let j = i + 1; j < articles.length; j++) {
      if (processed.has(j)) continue;

      const similarity = calculateTitleSimilarity(articles[i].title, articles[j].title);
      if (similarity > 0.6 && cluster.articles.length < MAX_CLUSTER_SIZE) {
        cluster.articles.push(articles[j]);
        cluster.totalScore += (articles[j].score || 0);
        processed.add(j);
      }
    }

    // 클러스터 최종 점수 및 rating 계산
    cluster.averageScore = cluster.totalScore / cluster.articles.length;
    cluster.rating = Math.round(cluster.averageScore / 20);
    cluster.score = cluster.averageScore; // API 호환성을 위해 score 필드도 추가
    
    clusters.push(cluster);
    processed.add(i);
  }

  // 점수순 정렬 (averageScore 기준)
  return clusters.sort((a, b) => b.averageScore - a.averageScore);
}

function calculateTitleSimilarity(title1, title2) {
  if (!title1 || !title2) return 0;
  
  const words1 = title1.toLowerCase().split(/\s+/).filter(w => !STOP_WORDS.has(w));
  const words2 = title2.toLowerCase().split(/\s+/).filter(w => !STOP_WORDS.has(w));
  
  const intersection = words1.filter(w => words2.includes(w));
  const union = [...new Set([...words1, ...words2])];
  
  return union.length > 0 ? intersection.length / union.length : 0;
}

/* 배치 처리 상수 */
const BATCH_SIZE = parseInt(process.env.AI_BATCH_SIZE, 10) || 10;
const CACHE_TTL = parseInt(process.env.AI_CACHE_TTL_SECONDS, 10) || 86400;

/* 지능형 AI 배치 처리 함수 */
async function processArticlesWithAI(articles) {
  const processedArticles = [];
  
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    console.log(`🔄 [AI Processor] AI 요약 배치 처리 시작: ${i + 1}-${i + batch.length} / ${articles.length}`);

    const batchPromises = batch.map(async (article) => {
      const cacheKey = `ai_summary:${Buffer.from(article.link || article.url || article.title).toString('base64').slice(0, 50)}`;

      // 1. 캐시 확인
      try {
        const cachedSummary = await redisClient.get(cacheKey);
        if (cachedSummary) {
          console.log(`⚡️ [Cache HIT] '${article.title?.slice(0, 30)}...'의 AI 요약을 캐시에서 가져옵니다.`);
          article.aiSummary = cachedSummary;
          return article;
        }
      } catch (cacheError) {
        console.warn(`⚠️ [Cache] 캐시 조회 실패: ${cacheError.message}`);
      }

      // 2. 캐시가 없으면 API 호출 (재시도 로직 포함)
      try {
        const textToSummarize = article.content || article.summary || article.description || '';
        if (!textToSummarize || textToSummarize.length < 50) {
          article.aiSummary = null;
          return article;
        }

        const prompt = article.sourceLang === 'ko' 
          ? `다음 뉴스 기사를 3-4개의 핵심 포인트로 요약해주세요. 각 포인트는 한 줄로 작성하고 "•"로 시작하세요:\n\n${textToSummarize}`
          : `Summarize the following news article into 3-4 key bullet points. Each point should be one line starting with "•":\n\n${textToSummarize}`;

        const payload = {
          model: OPENAI_MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 200,
          temperature: 0.3
        };

        const response = await openaiRequestWithRetry(payload);
        const summary = response.choices[0]?.message?.content?.trim() || null;

        article.aiSummary = summary;

        // 3. 성공 시 결과 캐싱
        if (summary) {
          try {
            await redisClient.setex(cacheKey, CACHE_TTL, summary);
            console.log(`💾 [Cache SAVE] '${article.title?.slice(0, 30)}...' AI 요약 캐시 저장 완료`);
          } catch (cacheError) {
            console.warn(`⚠️ [Cache] 캐시 저장 실패: ${cacheError.message}`);
          }
        }

        return article;

      } catch (error) {
        console.error(`🚨 [AI Processor] '${article.title?.slice(0, 30)}...' 요약 최종 실패:`, error.message);
        article.aiSummary = null; // 실패 시 null로 설정
        return article;
      }
    });

    const results = await Promise.all(batchPromises);
    processedArticles.push(...results);
    
    // 배치 간 잠시 대기 (Rate Limit 방지)
    if (i + BATCH_SIZE < articles.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  return processedArticles;
}

/* 메인 처리 함수 (배치 처리 적용) */
async function fetchAndProcessNewsForAllSections() {
  const sections = ['world', 'korea', 'business', 'japan', 'buzz'];
  const results = {};
  
  console.log('🔄 [NewsProcessor] Starting news processing for all sections...');
  
  for (const section of sections) {
    try {
      if (isDebug) {
        console.log(`🔍 [DEBUG] Processing section: ${section}`);
      }
      
      // 뉴스 수집
      const rawArticles = await fetchArticlesWithFallback(section);
      
      if (isVerbose) {
        console.log(`📝 [VERBOSE] Collected ${rawArticles.length} articles for ${section}`);
      }
      
      // 기사 기본 처리 (점수 계산, 번역 등 - AI 요약 제외)
      const basicProcessedArticles = [];
      for (const article of rawArticles.slice(0, 50)) { // 최대 50개 처리
        const processed = await processSingleArticle(article);
        basicProcessedArticles.push(processed);
      }
      
      // AI 요약 배치 처리
      const fullyProcessedArticles = await processArticlesWithAI(basicProcessedArticles);
      
      // 클러스터링
      const clusters = clusterArticles(fullyProcessedArticles);
      
      results[section] = {
        articles: fullyProcessedArticles.slice(0, 20), // 최대 20개 반환
        clusters: clusters.slice(0, 10), // 최대 10개 클러스터
        lastUpdated: new Date().toISOString(),
        totalProcessed: rawArticles.length
      };
      
      console.log(`✅ [NewsProcessor] ${section}: ${fullyProcessedArticles.length} articles processed, ${clusters.length} clusters created`);
      
    } catch (error) {
      console.error(`❌ [NewsProcessor] Error processing ${section}:`, error.message);
      results[section] = {
        articles: [],
        clusters: [],
        lastUpdated: new Date().toISOString(),
        error: error.message
      };
    }
  }
  
  console.log('🎉 [NewsProcessor] All sections processed successfully');
  return results;
}

/* 캐시 저장 함수 */
async function saveToCache(key, data, ttl = 3600) {
  if (!redisClient) return false;
  
  try {
    await redisClient.setEx(key, ttl, JSON.stringify(data));
    return true;
  } catch (error) {
    console.error('❌ [NewsProcessor] Cache save error:', error.message);
    return false;
  }
}

/* 캐시 로드 함수 */
async function loadFromCache(key) {
  if (!redisClient) return null;
  
  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('❌ [NewsProcessor] Cache load error:', error.message);
    return null;
  }
}

module.exports = {
  fetchAndProcessNewsForAllSections,
  saveToCache,
  loadFromCache,
  processArticle,
  clusterArticles
};

