
/*
 * EmarkNews — 업그레이드 백엔드 (v4.2: v4 기반 + 통합 안정성 패치: Vector Mutation, Invalid Time Value 수정, 초기화 강화)
 */

"use strict";

// Load environment variables
require('dotenv').config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const OpenAI = require("openai");;
const { TranslationServiceClient } = require("@google-cloud/translate").v3;
const redis = require("redis");
const NewsAPI = require("newsapi");
const { TwitterApi } = require("twitter-api-v2");
const Parser = require("rss-parser");
const rssParser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "EmarkNewsBot/1.0 (+https://emarknews.com)"
  }
});
const math = require("mathjs");
const axios = require("axios");
const cheerio = require("cheerio");
// const zlib = require("zlib"); // compression 라이브러리에서 처리됨
const expressGzip = require("compression");
const app = express();
const fs = require('fs');

app.use(express.json());
app.use(expressGzip()); // Gzip for speed

// 진단 엔드포인트 (정적 파일 서빙 전에 정의)
app.get('/_diag/keys', (req, res) => {
  const keys = {
    NEWS_API_KEY: !!process.env.NEWS_API_KEY || !!process.env.NEWS_API_KEYS,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    GOOGLE_APPLICATION_CREDENTIALS: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
    GOOGLE_PROJECT_ID: !!process.env.GOOGLE_PROJECT_ID,
    TWITTER_BEARER_TOKEN: !!process.env.TWITTER_BEARER_TOKEN,
    REDIS_URL: !!process.env.REDIS_URL,
    NAVER_CLIENT_ID: !!process.env.NAVER_CLIENT_ID,
    NAVER_CLIENT_SECRET: !!process.env.NAVER_CLIENT_SECRET,
    YOUTUBE_API_KEY: !!process.env.YOUTUBE_API_KEY,
  };
  res.json({ status: 'ok', keys, timestamp: new Date().toISOString() });
});

// 정적 파일 루트: ./public (캐시 헤더 포함)
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  etag: true,
  lastModified: true
}));

/* 환경 변수 */
const {
  NEWS_API_KEY = "",
  NEWS_API_KEYS = "",
  TWITTER_BEARER_TOKEN = "",
  OPENAI_API_KEY = "",
  OPENAI_MODEL = "gpt-4o-mini",
  GOOGLE_PROJECT_ID = "",
  TRANSLATE_API_KEY = "",
  REDIS_URL = "redis://localhost:6379",
  NAVER_CLIENT_ID = "",
  NAVER_CLIENT_SECRET = "",
  YOUTUBE_API_KEY = "",
  NODE_ENV = "development"
} = process.env;

// NewsAPI 초기화 - 환경 변수 우선순위: NEWS_API_KEY > NEWS_API_KEYS
let newsApiKey = NEWS_API_KEY;
if (!newsApiKey && NEWS_API_KEYS) {
  const keys = NEWS_API_KEYS.split(",");
  if (keys.length > 0) {
    newsApiKey = keys[0];
  }
}

// GOOGLE_APPLICATION_CREDENTIALS 처리 (PEM/JSON 지원)
let googleCredentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  let gac = process.env.GOOGLE_APPLICATION_CREDENTIALS.trim();
    gac = gac.replace(/\\n/g, "\n");
  let credentialsPath;
  if (gac.startsWith('{')) {
    credentialsPath = path.join(__dirname, 'gcloud_sa.json');
  } else if (gac.startsWith('-----BEGIN PRIVATE KEY-----')) {
    credentialsPath = path.join(__dirname, 'gcloud_sa.pem');
  } else {
    console.warn('⚠️ Invalid Google credentials format. Translation might fail.');
    // googleCredentialsPath = null; // 파일 경로일 수도 있으므로 null 처리 보류
  }

  if (credentialsPath) {
    try {
      fs.writeFileSync(credentialsPath, gac);
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
      googleCredentialsPath = credentialsPath;
      console.log('✅ Google credentials saved to file.');
    } catch (error) {
      console.error('❌ Failed to save Google credentials:', error.message);
      googleCredentialsPath = null;
    }
  }
}

// 초기화 (안정성 강화: 키가 없어도 앱 실행 유지)
let newsapi = null;
if (newsApiKey) {
  newsapi = new NewsAPI(newsApiKey);
  console.log('✅ NewsAPI initialized.');
} else {
  // process.exit(1) 제거됨
  console.warn("⚠️ NewsAPI key not found. NewsAPI features will be disabled.");
}

const twitterClient = TWITTER_BEARER_TOKEN ? new TwitterApi(TWITTER_BEARER_TOKEN) : null;
if (twitterClient) console.log('✅ Twitter API initialized.');

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
if (openai) console.log('✅ OpenAI initialized.');

const GCLOUD_SA_KEY = TRANSLATE_API_KEY || googleCredentialsPath;
let translateClientOptions = {};
let translateClient = null;

if (GOOGLE_PROJECT_ID) {
    try {
        if (GCLOUD_SA_KEY && typeof GCLOUD_SA_KEY === 'string' && GCLOUD_SA_KEY.startsWith('{')) {
            const credentials = JSON.parse(GCLOUD_SA_KEY);
            translateClientOptions = { credentials };
        } else if (GCLOUD_SA_KEY) {
            translateClientOptions = { keyFilename: GCLOUD_SA_KEY };
        }
        translateClient = new TranslationServiceClient(translateClientOptions);
        console.log('✅ Google Translate Client initialized.');
    } catch (e) {
        console.error('❌ Google Translate 인증 정보 파싱 오류:', e);
        translateClient = null;
    }
} else {
    console.warn('⚠️ GOOGLE_PROJECT_ID not set. Translation features disabled.');
}


// Redis 연결 (선택적, 캐시 비활성화 가능)
let redisClient = null;
const CACHE_DISABLED = process.env.DISABLE_CACHE === '1';

if (!CACHE_DISABLED && REDIS_URL) {
  try {
    redisClient = redis.createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => {
        console.warn('Redis Client Error', err.message);
    });
    redisClient.connect().then(() => {
        console.log('✅ Redis connected.');
    }).catch((err) => {
      console.warn('Redis 연결 실패, 캐시 비활성화:', err.message);
      redisClient = null;
    });
  } catch (err) {
    console.warn('Redis 클라이언트 생성 실패, 캐시 비활성화:', err.message);
    redisClient = null;
  }
} else {
  console.log('ℹ️ 캐시가 비활성화되었거나 REDIS_URL이 없습니다.');
}

/* 상수/유틸 */
const NOW = () => Date.now();
const HOUR = 3600 * 1000;
const TIME_DECAY_TAU_HOURS = 48; // 48시간 기준으로 감쇠율 조정
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

const LABEL_RULES = {
  politics: [/election|senate|parliament|white\s*house|의회|총선|대선|정당|의장|외교|국방/i],
  economy:  [/inflation|gdp|interest|bond|market|stock|고용|물가|성장률|경제|수출|환율|증시/i],
  tech:     [/ai|artificial\s*intelligence|chip|semiconductor|iphone|android|구글|애플|삼성|테크|반도체|클라우드/i],
  business: [/merger|acquisition|earnings|ipo|startup|buyback|기업|실적|인수|합병|상장|스타트업/i],
  world:    [/united\s*nations|eu|nato|중동|우크라이나|이스라엘|국제|세계/i],
  sport:    [/world\s*cup|olympic|league|match|경기|리그|올림픽|월드컵/i],
  entertainment: [/film|movie|box\s*office|drama|idol|k-pop|배우|영화|드라마|음원|아이돌/i],
  japan:    [/japan|tokyo|osaka|일본|도쿄|오사카/i],
  korea:    [/korea|seoul|한국|서울|부산|대한민국/i]
};

function detectLabelsForText(text, maxLabels = 2) {
  const hits = [];
  for (const [label, patterns] of Object.entries(LABEL_RULES)) {
    for (const re of patterns) {
      if (re.test(text)) { hits.push(label); break; }
    }
  }
  if (hits.length > maxLabels) {
    const prio = { tech:9, economy:8, business:7, politics:6, world:5, korea:4, japan:3, sport:2, entertainment:1 };
    hits.sort((a,b)=>(prio[b]||0)-(prio[a]||0));
    return hits.slice(0, maxLabels);
  }
  return hits;
}

function normalizeText(s) {
  if (!s) return "";
  return String(s).replace(/https?:\/\/\S+/g," ")
    .replace(/[^\p{L}\p{N}\s]/gu," ")
    .replace(/\s+/g," ").trim().toLowerCase();
}
function tokenize(s) { return s ? s.split(/\s+/).filter(Boolean) : []; }

function extractKeywordsWithTFIDF(docs, topK = SIGNATURE_TOPK) {
  const termFreq = docs.map(doc => {
    const terms = tokenize(normalizeText(doc)).filter(t => !STOP_WORDS.has(t));
    const freq = new Map();
    terms.forEach(t => freq.set(t, (freq.get(t) || 0) + 1 / (terms.length || 1)));
    return freq;
  });
  const docFreq = new Map();
  termFreq.forEach(freq => freq.forEach((_, t) => docFreq.set(t, (docFreq.get(t) || 0) + 1)));
  const idf = new Map(Array.from(docFreq).map(([t, df]) => [t, Math.log(docs.length / (1 + df))]));
  return termFreq.map(freq => {
    const tfidf = Array.from(freq).map(([t, tf]) => [t, tf * (idf.get(t) || 0)]);
    const topKeywords = tfidf.sort((a, b) => b[1] - a[1]).slice(0, topK).map(([t]) => t);
    while (topKeywords.length < topK) {
      topKeywords.push(null); // 길이가 짧으면 null로 패딩
    }
    return topKeywords;
  });
}

function articleSignature(article) {
  const base = [article.title, article.summary, article.content].filter(Boolean).join(" ");
  const keys = extractKeywordsWithTFIDF([base])[0];
  const sig = keys.filter(k => k).sort().join("|");
  return sig || (article.title ? normalizeText(article.title).slice(0,80) : "no-title");
}

function hashId(s) { return crypto.createHash("md5").update(s).digest("hex").slice(0,12); }

function getDomain(url) {
  try {
      const hostname = new URL(url).hostname.replace(/^www\./,"");
      // Naver 뉴스 처리
      if (hostname === 'news.naver.com' || hostname === 'n.news.naver.com') {
          return 'naver.com';
      }
      return hostname;
  }
  catch { return ""; }
}

function freshnessWeight(publishedAt) {
  if (!publishedAt) return 0.9;
  const ts = typeof publishedAt==="string" ? Date.parse(publishedAt) : +publishedAt;
  if (!Number.isFinite(ts)) return 0.9;
  const hours = (NOW()-ts)/HOUR;
  // 최신 기사에 더 높은 가중치 부여
  const w = Math.exp(-Math.max(0,hours)/TIME_DECAY_TAU_HOURS);
  return Math.min(1.0, Math.max(0.2, w));
}

function sourceWeight(url) {
  const d = getDomain(url);
  return d ? (SOURCE_QUALITY[d] || 1.0) : 1.0;
}

// 클러스터 레이팅 계산 로직 (Urgency/Buzz 반영 강화)
function computeRating(cluster) {
  if (!cluster.articles.length) return 0;
  let fSum = 0, sSum = 0, uniqueDomains = new Set();
  let urgencySum = 0, buzzSum = 0;
  for (const a of cluster.articles) {
    fSum += freshnessWeight(a.publishedAt);
    sSum += sourceWeight(a.url);
    uniqueDomains.add(getDomain(a.url));
    urgencySum += a.urgency || 0;
    buzzSum += a.buzz || 0;
  }
  const wF = fSum / cluster.articles.length;
  const wS = (sSum / cluster.articles.length) / 1.15; // Normalize source quality (최대 1.15 기준)
  const sizeBoost = Math.log(1 + cluster.articles.length) / Math.log(1 + MAX_CLUSTER_SIZE);
  const diversity = uniqueDomains.size / cluster.articles.length;

  // Urgency/Buzz 부스트 강화
  const urgencyBoost = (urgencySum / cluster.articles.length) * 0.2;
  const buzzBoost = (buzzSum / cluster.articles.length) * 0.3;

  // 가중치 합계 (최신성(wF) 중요도 상향)
  const raw = 0.45 * wF + 0.25 * wS + 0.1 * sizeBoost + 0.05 * diversity + urgencyBoost + buzzBoost;
  
  // 5점 만점으로 스케일링 및 0.5 단위 반올림
  const rating = Math.round((Math.min(1.5, raw) / 1.5) * 5 * 2) / 2;
  return Math.min(5.0, Math.max(1.0, rating));
}

// [v4.2 Patch] createEmptyCluster 수정: 시간 처리 안정화
function createEmptyCluster(signature) {
  return {
    id: hashId(signature + ":" + Math.random().toString(36).slice(2,8)),
    signature,
    keywords: signature ? signature.split("|").filter(k => k) : [],
    articles: [],
    // validTsCount 추가하여 평균 계산 안정성 확보
    centroid: { titleTokens:new Map(), publishedAtAvg:0, validTsCount: 0 },
    score: 0,
    labels: [],
    rating: 0,
    createdAt: new Date().toISOString()
  };
}

// [v4.2 Patch] updateCentroid 수정: 시간 처리 안정화 (Invalid Time Value 해결)
function updateCentroid(cluster, article) {
  const keys = extractKeywordsWithTFIDF([article.title || ""])[0].filter(k => k);
  for (const k of keys) {
    cluster.centroid.titleTokens.set(k, (cluster.centroid.titleTokens.get(k)||0)+1);
  }
  
  const ts = article.publishedAt ? Date.parse(article.publishedAt) : NaN;

  // 유효한 타임스탬프만 평균 계산에 포함
  if (Number.isFinite(ts)) {
    const prevAvg = cluster.centroid.publishedAtAvg;
    const validTsCount = cluster.centroid.validTsCount; 

    if (!Number.isFinite(prevAvg) || validTsCount === 0) {
        // 클러스터의 첫 번째 유효한 타임스탬프
        cluster.centroid.publishedAtAvg = ts;
        cluster.centroid.validTsCount = 1;
    } else {
        // 평균 업데이트
        cluster.centroid.publishedAtAvg = (prevAvg * validTsCount + ts) / (validTsCount + 1);
        cluster.centroid.validTsCount = validTsCount + 1;
    }
  }
}

function clusterScore(cluster) {
  if (!cluster.articles.length) return 0;
  let fSum=0, sSum=0;
  for (const a of cluster.articles) { fSum+=freshnessWeight(a.publishedAt); sSum+=sourceWeight(a.url); }
  const fAvg = fSum/cluster.articles.length;
  const sAvg = sSum/cluster.articles.length;
  const sizeBoost = Math.log(1+cluster.articles.length);
  // 최신성(fAvg)을 더 중요하게 반영
  return (fAvg * 1.2) * sAvg * sizeBoost;
}

function intersectionSize(aSet, bSet) {
  let count = 0;
  for (const x of aSet) if (bSet.has(x)) count++;
  return count;
}

function mergeNearbyBuckets(buckets) {
  const sigs = Array.from(buckets.keys()).sort((a,b) => (a.length - b.length) || a.localeCompare(b));
  const sigToSet = new Map(sigs.map(s => [s, new Set(s.split("|").filter(k => k))]));
  for (let i = 0; i < sigs.length; i++) {
    const a = sigs[i];
    const aSet = sigToSet.get(a);
    if (!buckets.has(a) || !aSet) continue;
    for (let j = i + 1; j <= Math.min(i + 3, sigs.length - 1); j++) {
      const b = sigs[j];
      if (!buckets.has(b)) continue;
      const bSet = sigToSet.get(b);
      if (!bSet) continue;

      const inter = intersectionSize(aSet, bSet);
      const minSize = Math.min(aSet.size, bSet.size);

      if (minSize > 0 && inter >= Math.ceil(minSize * 0.5)) {
        const A = buckets.get(a), B = buckets.get(b);
        const into = (A.articles.length >= B.articles.length) ? A : B;
        const from = (into === A) ? B : A;
        for (const art of from.articles) {
          if (into.articles.length >= MAX_CLUSTER_SIZE) break;
          // updateCentroid 호출 후 push
          updateCentroid(into, art);
          into.articles.push(art);
        }
        into.score = clusterScore(into);
        buckets.delete((into === A) ? b : a);
      }
    }
  }
  return buckets;
}

async function enrichCluster(cluster, lang) {
  const head = cluster.articles[0] || {};
  const baseText = [head.title||"", head.summary||"", cluster.keywords.join(" ")].join(" ");
  cluster.labels = detectLabelsForText(baseText, 2);
  cluster.rating = computeRating(cluster);
  // 클러스터 단위 태그 추가 (Urgent/Buzz)
  cluster.isUrgent = cluster.articles.some(a => a.urgency > 0);
  cluster.isBuzz = cluster.articles.some(a => a.buzz > 0);
}

// [v4.2 Patch] 코사인 유사도 계산 함수: 데이터 변조(Mutation) 버그 수정
function cosineSimilarity(vecA, vecB) {
    try {
        // Safety check 1: Ensure inputs are valid arrays and not empty
        if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecB.length === 0) {
            return 0;
        }

        // Safety check 2: Ensure lengths match.
        // 이전 버전의 데이터 변조(push(0)) 로직 제거됨. 아키텍처상 길이가 동일해야 함.
        if (vecA.length !== vecB.length) {
            console.warn(`Warning: Vector dimensions do not match (${vecA.length} vs ${vecB.length}). Returning 0.`);
            return 0;
        }

        const dot = math.dot(vecA, vecB);
        const normA = math.norm(vecA);
        const normB = math.norm(vecB);

        // Safety check 3: Prevent division by zero
        if (normA === 0 || normB === 0) return 0;

        return dot / (normA * normB);
    } catch (e) {
        console.error("Cosine Similarity Error:", e.message);
        return 0;
    }
}

/* 번역 및 AI 처리 함수들 */

async function clusterArticles(articles, lang, quality = "low") {
  if (!Array.isArray(articles) || !articles.length) return [];

  const docs = articles.map(a => [a.title, a.summary, a.content].filter(Boolean).join(" "));
  const keywordsList = extractKeywordsWithTFIDF(docs);

  let vectors = [];
  if (quality === "high" && openai) {
      try {
        // 텍스트 임베딩 모델 사용
        const embeds = await openai.embeddings.create({ model: "text-embedding-3-small", input: docs });
        vectors = embeds.data.map(e => e.embedding);
      } catch (e) {
          console.error("OpenAI Embedding Error:", e.message);
          // 폴백: 키워드 기반 벡터
          vectors = keywordsList.map(kw => kw.map(w => w ? 1 : 0));
      }
  } else {
      // 기본: 키워드 기반 벡터
      vectors = keywordsList.map(kw => kw.map(w => w ? 1 : 0));
  }

  const buckets = new Map();
  const SIMILARITY_THRESHOLD = quality === "high" ? 0.75 : 0.6; // 품질에 따른 임계값 조정

  for (let i = 0; i < articles.length; i++) {
    const sig = keywordsList[i].filter(k => k).join("|");
    let matched = false;

    // 벡터가 유효한지 확인
    if (!vectors[i] || vectors[i].length === 0) continue;

    for (const [existingSig, cluster] of buckets) {
      const clusterVector = vectors[cluster.index];
      // 클러스터 벡터가 유효한지 확인
      if (!clusterVector || clusterVector.length === 0) continue;

      const sim = cosineSimilarity(vectors[i], clusterVector);

      if (sim > SIMILARITY_THRESHOLD) {
        if (cluster.articles.length < MAX_CLUSTER_SIZE) {
          // updateCentroid 호출 후 push
          updateCentroid(cluster, articles[i]);
          cluster.articles.push(articles[i]);
          matched = true;
        }
        break;
      }
    }
    if (!matched) {
      const cluster = createEmptyCluster(sig);
      // 첫 기사 추가 시 updateCentroid 호출
      updateCentroid(cluster, articles[i]);
      cluster.articles.push(articles[i]);
      cluster.index = i;
      buckets.set(sig, cluster);
    }
  }

  mergeNearbyBuckets(buckets);

  const clusters = Array.from(buckets.values());
  for (const c of clusters) {
    c.score = clusterScore(c);
    await enrichCluster(c, lang);
  }

  // 최종 정렬: 점수(Score) 기준 내림차순 (Score는 최신성과 품질을 반영함)
  clusters.sort((a,b)=>b.score-a.score);

  return clusters.map(c => ({
    id:c.id, signature:c.signature, keywords:c.keywords, score:c.score, size:c.articles.length,
    labels:c.labels, rating:c.rating,
    isUrgent: c.isUrgent, // 태그 정보 전달
    isBuzz: c.isBuzz,
    articles:c.articles,
    centroid:{
      titleTopKeywords: Array.from(c.centroid.titleTokens.entries()).sort((a,b)=>b[1]-a[1]).slice(0,SIGNATURE_TOPK).map(([k])=>k),
      publishedAtAvg: c.centroid.publishedAtAvg ? new Date(c.centroid.publishedAtAvg).toISOString() : null
    },
    createdAt:c.createdAt
  }));
}

async function translateText(text, targetLang = "ko") {
  if (!text || typeof text !== 'string' || text.trim() === '' || !translateClient || !GOOGLE_PROJECT_ID) {
      return text;
  }

  // 간단한 언어 감지 (한국어 텍스트를 한국어로 번역 요청 방지)
  const isKorean = /[가-힣]/.test(text);
  if (isKorean && targetLang === 'ko') return text;


  const request = {
    parent: `projects/${GOOGLE_PROJECT_ID}/locations/global`,
    contents: [text],
    mimeType: "text/plain",
    targetLanguageCode: targetLang,
  };
  try {
    const [response] = await translateClient.translateText(request);
    if (response.translations && response.translations.length > 0) {
        // Google Translate가 원본 언어와 타겟 언어가 같다고 판단하면 번역 텍스트를 반환하지 않을 수 있음
        return response.translations[0].translatedText || text;
    }
    return text;
  } catch (e) {
    // 로그 폭주 방지를 위해 에러 타입별 처리
    if (e.code === 'UNAUTHENTICATED' || e.message.includes('Unauthenticated')) {
      console.error("❌ Google Translate authentication failed - check credentials");
    } else if (e.code === 'PERMISSION_DENIED' || e.message.includes('Permission denied')) {
      console.error("❌ Google Translate permission denied - check project ID and API enabled");
    } else {
      // console.error("❌ Translate Error:", e.message || e);
    }
    return text; // 번역 실패 시 원문 반환
  }
}

// (postEditKoWithLLM 및 관련 함수들은 기존 코드 유지)
// ... (중략: classifyCategoryByEnglishSource, qualityScoreForKo, needPostEdit) ...

// AI 요약 함수 (불릿 포인트 형식으로 변경)
async function generateAiSummary(article, format = "bullet", model = OPENAI_MODEL) {
    if (!openai) {
        // AI 사용 불가 시 기존 요약 반환
        return article.summary || article.description;
    }

    const inputText = `Title: ${article.title}\nContent: ${article.content || article.description || article.summary || article.title}`;

    let prompt;
    if (format === "bullet") {
        // 카드 뷰용: 3개의 간결한 불릿 포인트 (Middot 사용)
        prompt = `Summarize the following news article into exactly 3 concise bullet points. Use the Middot character (·) as the bullet. Focus on the most critical facts and implications. Do NOT use ellipses (...).

Input:
${inputText.slice(0, 2500)}

Output (3 bullets starting with ·):`;
    } else {
        // 모달 뷰용: 상세한 요약 (서술형 또는 상세 불릿 포인트)
        prompt = `Provide a detailed summary of the following news article. Cover all key facts, figures, events, and implications comprehensively. Use Middot characters (·) for bullet points if appropriate for clarity. The summary should be thorough. Do NOT use ellipses (...).

Input:
${inputText.slice(0, 4000)}

Detailed Summary:`;
    }

    try {
        const resp = await openai.chat.completions.create({
            model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: format === "bullet" ? 250 : 500, // 토큰 제한 조정
            temperature: 0.3
        });
        const summary = resp.choices[0].message.content.trim();

        // 불릿 포인트 형식 강제 (AI가 놓쳤을 경우 대비)
        if (format === "bullet" && !summary.startsWith('·')) {
            const lines = summary.split('.').filter(line => line.trim() !== '');
            if (lines.length > 0) {
                return lines.slice(0, 3).map(line => `· ${line.trim()}`).join('\n');
            }
        }

        return summary || article.summary || article.description;

    } catch (e) {
        console.error("AI Summary Error:", e);
        return article.summary || article.description;
    }
}

async function processArticles(articles, lang, options = {}) {
  // aiSummary 기본값 true로 설정 (모든 기사에 AI 요약 적용)
  const { aiSummary = true, postEdit = false, peModel, peStrategy = "auto", quality } = options;

  return Promise.all(articles.map(async (article) => {
    // 1. AI 요약 생성 (카드 뷰용 불릿 포인트)
    if (aiSummary) {
        // 원본 언어가 목표 언어와 같으면 AI 요약 생략 (예: 한국어 뉴스)
        if (article.sourceLang === lang) {
             article.aiSummaryBullet = article.summary || article.description;
        } else {
            article.aiSummaryBullet = await generateAiSummary(article, "bullet");
            // 상세 요약은 필요시 생성 (예: quality=high일 때만)
            if (quality === 'high') {
                 article.aiSummaryDetailed = await generateAiSummary(article, "detailed");
            }
        }
    }

    const titleToTranslate = article.title;
    // 요약은 AI 요약(불릿)을 우선 사용
    const summaryToTranslate = article.aiSummaryBullet || article.summary || article.description;

    // 2. 번역 (Google Translate)
    // 소스 언어와 목표 언어가 같으면 번역 생략
    if (article.sourceLang === lang) {
        article.translatedTitle = titleToTranslate;
        article.translatedSummary = summaryToTranslate;
        return article;
    }

    let translatedTitle = await translateText(titleToTranslate, lang);
    let translatedSummary = await translateText(summaryToTranslate, lang);

    // 3. AI 후편집 (LLM Post-Editing) - 옵션 기능
    // (기존 코드의 postEdit 로직은 복잡성 대비 효율이 낮아 기본 비활성화 상태 유지)
    // ... (중략) ...

    article.translatedTitle = translatedTitle;
    article.translatedSummary = translatedSummary; // 최종 번역된 요약 (불릿 형태)
    return article;
  }));
}

// 긴급도/화제성 계산 (X API 연동)
async function computeUrgencyBuzz(articles) {
    // 1. 긴급도 (Urgency): 동일 주제 반복 빈도 기반
    const topics = {};
    articles.forEach(a => {
        const topic = articleSignature(a);
        topics[topic] = (topics[topic] || 0) + 1;
    });

    // 2. 화제성 (Buzz): X(Twitter) 검색 결과 기반 (유료 API 필요)
    let buzzTopics = new Set();
    if (twitterClient) {
        try {
            // X에서 '속보', '긴급', '주요 이슈' 관련 트윗 검색
            const query = 'breaking news OR urgent OR major event lang:en OR lang:ko OR lang:ja';
            // 유료 API 사용 시 더 많은 결과를 가져올 수 있음 (max_results 조정)
            const xBuzz = await twitterClient.v2.search(query, { max_results: 30 });

            if (xBuzz && xBuzz.data && xBuzz.data.data) {
                xBuzz.data.data.forEach(tweet => {
                    // 트윗 내용에서 주요 키워드 추출
                    const keywords = extractKeywordsWithTFIDF([tweet.text], 5)[0].filter(k => k);
                    keywords.forEach(k => buzzTopics.add(k));
                });
            }
        } catch (e) {
            console.error("❌ X API (Twitter) Error:", e.message);
            // API 호출 실패 시 (예: 요금제 제약, 인증 오류) Buzz 계산 생략
            buzzTopics = new Set();
        }
    }

    // 기사에 점수 할당
    return articles.map(a => {
        // 긴급도 할당 (3회 이상 반복 시 1점)
        a.urgency = topics[articleSignature(a)] >= 3 ? 1 : 0;

        // 화제성 할당
        const articleKeywords = new Set(extractKeywordsWithTFIDF([a.title + ' ' + (a.summary || '')])[0].filter(k => k));
        const intersection = intersectionSize(articleKeywords, buzzTopics);
        // 키워드 교집합이 2개 이상이면 Buzz 1점
        a.buzz = intersection >= 2 ? 1 : 0;

        return a;
    });
}

/* API 헬퍼 함수들 (신규 추가) */

// Naver API 헬퍼
async function fetchFromNaverAPI(query = "주요 뉴스", display = 40) {
    if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
      console.warn("⚠️ Naver API credentials not found.");
      return [];
    }

    try {
      const response = await axios.get('https://openapi.naver.com/v1/search/news.json', {
        params: {
          query: query,
          display: display,
          sort: 'date' // 최신순
        },
        headers: {
          'X-Naver-Client-Id': NAVER_CLIENT_ID,
          'X-Naver-Client-Secret': NAVER_CLIENT_SECRET
        }
      });

      if (response.data && response.data.items) {
        console.log(`✅ Naver API: Retrieved ${response.data.items.length} articles for query "${query}"`);
        return response.data.items.map(item => {
          // Naver 응답의 HTML 태그 및 엔티티 제거
          const cleanTitle = item.title.replace(/<[^>]*>?|&quot;|&apos;|&#39;/gm, '');
          const cleanSummary = item.description.replace(/<[^>]*>?|&quot;|&apos;|&#39;/gm, '');

          return {
            title: cleanTitle,
            url: item.link,
            publishedAt: item.pubDate,
            summary: cleanSummary,
            source: getDomain(item.link) || 'Naver News',
            sourceLang: 'ko' // 소스 언어 명시
          };
        });
      }
      return [];
    } catch (e) {
      console.error(`❌ Naver API error:`, e.response ? `${e.response.status} ${e.response.statusText}` : e.message);
      return [];
    }
}

// NewsAPI 헬퍼
async function fetchFromNewsAPI(params) {
    if (!newsapi) {
        console.warn('⚠️ NewsAPI client is not initialized.');
        return [];
    }
    // 기본 파라미터 설정
    const queryParams = {
        pageSize: 50, // 더 많은 기사를 가져와서 필터링
        language: 'en',
        ...params
    };

    try {
        const response = await newsapi.v2.topHeadlines(queryParams);
        if (response && response.articles) {
            console.log(`✅ NewsAPI: Retrieved ${response.articles.length} articles.`);
            return response.articles.map(article => ({
                title: article.title,
                url: article.url,
                publishedAt: article.publishedAt,
                summary: article.description,
                content: article.content,
                source: getDomain(article.url),
                sourceLang: queryParams.language // 소스 언어 명시
            }));
        }
        return [];
    } catch (e) {
        console.error(`❌ NewsAPI Helper Error:`, e.message);
        // 유료 플랜 사용 중이므로 426/Forbidden 에러는 발생 가능성이 낮지만 로깅 유지
        if (e.message.includes('rateLimit')) {
             console.error('⚠️ NewsAPI Rate limit exceeded.');
        }
        return [];
    }
}

// RSS 피드 헬퍼 (재사용성 강화)
async function fetchFromRSS(urls, maxItemsPerFeed = 10, sourceLang = undefined) {
    const items = [];
    for (const url of urls) {
        try {
            const feed = await rssParser.parseURL(url);
            const feedItems = feed.items.slice(0, maxItemsPerFeed).map(item => ({
                title: item.title,
                url: item.link || item.guid,
                publishedAt: item.pubDate || item.isoDate,
                summary: item.contentSnippet || item.content,
                source: getDomain(url) || feed.title,
                sourceLang: sourceLang // 언어 지정 가능
            }));
            items.push(...feedItems);
        } catch (e) {
            console.error(`❌ RSS fetch error for ${url}:`, e.message);
        }
    }
    return items;
}

/* API 호출 함수 */
async function fetchFromApis(section, lang) {
  const items = [];
  
  // NewsAPI 호출
  if (newsApiKey) {
    try {
      const newsApiItems = await fetchFromNewsAPI(section, lang);
      items.push(...newsApiItems);
    } catch (e) {
      console.warn("NewsAPI 호출 실패:", e.message);
    }
  }
  
  // Naver API 호출 (한국어인 경우)
  if (lang === 'ko' && NAVER_CLIENT_ID && NAVER_CLIENT_SECRET) {
    try {
      const naverItems = await fetchFromNaverAPI(section === 'korea' ? '주요 뉴스' : section);
      items.push(...naverItems);
    } catch (e) {
      console.warn("Naver API 호출 실패:", e.message);
    }
  }
  
  return items;
}

/* RSS 폴백 함수 */
async function fetchFromRss(rssUrls) {
  const items = [];
  const parser = new RSSParser();
  
  for (const url of rssUrls) {
    try {
      const feed = await parser.parseURL(url);
      const rssItems = feed.items.map(item => ({
        title: item.title,
        description: item.contentSnippet || item.summary,
        url: item.link,
        publishedAt: item.pubDate,
        source: { name: feed.title || 'RSS Feed' },
        urlToImage: item.enclosure?.url || null
      }));
      items.push(...rssItems);
    } catch (e) {
      console.warn(`RSS 파싱 실패 (${url}):`, e.message);
    }
  }
  
  return items;
}

/* 데이터 필터링 함수 */
function filterItems(items, freshness = 48, domainCap = 50) {
  if (!items || !Array.isArray(items)) return [];
  
  const now = new Date();
  const freshnessMs = freshness * 60 * 60 * 1000; // 시간을 밀리초로 변환
  
  return items
    .filter(item => {
      // 시간 필터링
      if (item.publishedAt) {
        const publishedTime = new Date(item.publishedAt);
        if (now - publishedTime > freshnessMs) return false;
      }
      
      // 기본 필드 검증
      return item.title && item.url;
    })
    .slice(0, domainCap); // 개수 제한
}


/* 섹션별 기사 수집 로직 (재설계) */
async function fetchArticlesForSection(section, freshness, domainCap, lang) {
  let items = [];
  
  // RSS URLs 정의
  const rssUrls = [
    'https://feeds.cnn.com/rss/edition.rss',
    'https://feeds.bbci.co.uk/news/rss.xml',
    'https://www.ft.com/rss/home'
  ];
  
  try {
    items = await fetchFromApis(section, lang);  // NewsAPI/Naver/X 등 API 호출
    if (items.length > 0) return filterItems(items, freshness, domainCap);  // 성공 시 반환
  } catch (e) { console.error("API error:", e); }
  
  // RSS fallback
  try {
    items = await fetchFromRss(rssUrls);
  } catch (e) { console.error("RSS fallback error:", e); }
  
  return filterItems(items, freshness, domainCap);  // 48시간 이내, 점수/태그 추가 로직
}

/* 기사 수집 함수들 */
async function fetchFromNewsAPI(section, lang) {
  if (!newsApiKey) return [];
  
  try {
    const params = {
      apiKey: newsApiKey,
      pageSize: 20,
      language: lang || 'en'
    };
    
    // 섹션에 따른 파라미터 설정
    if (section === 'world') {
      params.category = 'general';
    } else if (['business', 'technology', 'science', 'health', 'sports', 'entertainment'].includes(section)) {
      params.category = section;
    } else {
      params.q = section;
    }
    
    const response = await axios.get('https://newsapi.org/v2/top-headlines', { params });
    return response.data.articles || [];
  } catch (e) {
    console.error('NewsAPI 오류:', e.message);
    return [];
  }
}

async function fetchFromNaverAPI(query, limit = 20) {
  if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) return [];
  
  try {
    const response = await axios.get('https://openapi.naver.com/v1/search/news.json', {
      params: { query, display: limit, sort: 'date' },
      headers: {
        'X-Naver-Client-Id': NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': NAVER_CLIENT_SECRET
      }
    });
    
    return response.data.items.map(item => ({
      title: item.title.replace(/<[^>]*>/g, ''),
      description: item.description.replace(/<[^>]*>/g, ''),
      url: item.link,
      publishedAt: item.pubDate,
      source: { name: 'Naver News' }
    }));
  } catch (e) {
    console.error('Naver API 오류:', e.message);
    return [];
  }
}

/* 뉴스 피드 생성 함수 */
async function generateFeed(section, freshness, domainCap, lang, quality) {
  try {
    // 1. 기사 수집
    let items = await fetchArticlesForSection(section, freshness, domainCap, lang);
    
    if (items.length === 0) {
      return { articles: [], clusters: [], meta: { total: 0, section, lang } };
    }
    
    // 2. 기본 메타데이터 반환
    return {
      articles: items,
      clusters: [],
      meta: {
        total: items.length,
        section,
        lang,
        generated_at: new Date().toISOString()
      }
    };
  } catch (e) {
    console.error('Feed 생성 오류:', e.message);
    throw new Error('FEED_GENERATION_FAILED');
  }
}

/* 라우팅 및 미들웨어 */

// 루트 페이지: public/index_gemini_grok_final.html
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index_gemini_grok_final.html'));
});

// 프론트엔드 라우팅: 비-API GET 요청은 전부 index로 포워딩
app.get(/^(?!\/(api|feed|healthz?|_diag|translate_page)\/?).*$/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index_gemini_grok_final.html'));
});

// 메인 피드 엔드포인트
app.get("/feed", cacheControl, async (req, res) => {
  try {
    const section = (req.query.section || "world").toString();
    // 기본값 48시간으로 변경
    const freshness = parseInt(req.query.freshness ?? "48", 10);
    const domainCap = parseInt(req.query.domain_cap ?? "5", 10);
    const lang = (req.query.lang || "ko").toString();
    const quality = (req.query.quality || "low").toString();
    // 후편집 기본값 true로 설정
    const postEdit = req.query.post_edit === 'true'; // 쿼리 스트링은 문자열임

    const cacheKey = `feed_v4:${section}:${freshness}:${domainCap}:${lang}:${quality}:${postEdit}`;

    // Redis 캐시 확인
    if (redisClient) {
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                const payload = JSON.parse(cached);
                const etag = generateETag(payload);
                res.set("ETag", etag);
                if (req.headers["if-none-match"] === etag) return res.status(304).end();
                return res.json(payload);
            }
        } catch (e) {
            console.error("Redis Cache Read Error:", e.message);
        }
    }

    // 1. 기사 수집
    let items = await fetchArticlesForSection(section, freshness, domainCap, lang);

    // 2. 긴급도/화제성 계산 (X API 호출)
    // 'buzz' 섹션이 아니더라도 계산은 수행 (클러스터 레이팅에 반영됨)
    if (items.length > 0) {
        items = await computeUrgencyBuzz(items);
    }

    // 3. Quality=High일 경우 기사 전문 스크래핑 (선택적)
    if (quality === "high") {
      await Promise.all(items.map(async (item) => {
        // 이미 content가 충분히 길면 생략
        if (!item.content || item.content.length < 500) {
            const content = await safeFetchArticleContent(item.url);
            if (content) item.content = content;
        }
      }));
    }

    // 4. 기사 처리 (AI 요약 생성 및 번역/후편집)
    // AI 요약(aiSummary)은 기본적으로 활성화됨
    items = await processArticles(items, lang, {
        aiSummary: true,
        postEdit: postEdit,
        quality: quality
    });

    // 5. 클러스터링
    let clusters = await clusterArticles(items, lang, quality);

    // 6. 'Buzz' 섹션 필터링 및 정렬
    if (section === 'buzz') {
        // Buzz 점수가 있거나(isBuzz=true) 긴급(isUrgent=true)한 클러스터만 필터링
        clusters = clusters.filter(c => c.isBuzz || c.isUrgent);
        // Buzz 섹션은 레이팅(화제성 반영됨) 기준으로 정렬
        clusters.sort((a,b) => b.rating - a.rating);
    }
    // 일반 섹션은 clusterArticles 내부에서 Score 기준으로 이미 정렬됨.

    // 7. 상위 결과 랜덤화 (새로고침 시 다양성 제공하면서 순위 유지)
    const TOP_N = 20;
    const topClusters = clusters.slice(0, TOP_N);

    // 점수 차이가 크지 않은 인접 항목끼리만 교환 시도 (Slight Shuffle)
    for (let i = topClusters.length - 1; i > 0; i--) {
        const j = i - 1;
        // 점수(Rating) 차이가 0.5 이하이고 무작위 확률 50%일 때 교환
        if (Math.abs(topClusters[i].rating - topClusters[j].rating) <= 0.5 && Math.random() > 0.5) {
            [topClusters[i], topClusters[j]] = [topClusters[j], topClusters[i]];
        }
    }

    clusters.splice(0, TOP_N, ...topClusters); // 섞인 결과를 다시 배열에 삽입

    const payload = {
      section, freshness, domain_cap: domainCap, lang, quality, post_edit: postEdit,
      count: items.length,
      clusters,
      generatedAt: new Date().toISOString()
    };

    // Redis 캐시 저장 (180초 = 3분)
    if (redisClient) {
        try {
            await redisClient.setEx(cacheKey, 180, JSON.stringify(payload));
        } catch (e) {
            console.error("Redis Cache Write Error:", e.message);
        }
    }

    const etag = generateETag(payload);
    res.set("ETag", etag);
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    res.json(payload);

  } catch (e) {
    console.error("❌ FEED Generation Failed:", e.stack || e);
    res.status(500).json({ error: "FEED_GENERATION_FAILED", detail: String(e?.message || e) });
  }
});

// 기사 전문 번역 엔드포인트 (모달에서 사용)
app.get("/translate_page", async (req, res) => {
  const url = req.query.url;
  const lang = req.query.lang || 'ko';

  if (!url) {
      return res.status(400).json({ error: "URL_MISSING" });
  }

  try {
    // 1. 기사 전문 스크래핑
    const content = await safeFetchArticleContent(url);

    if (!content || content.length < 100) {
        return res.status(404).json({ error: "CONTENT_EXTRACTION_FAILED", detail: "Could not extract meaningful content from the URL." });
    }

    // 2. 번역
    // 긴 텍스트는 분할 번역이 필요할 수 있으나, 여기서는 최대 길이(5000자)까지 한번에 번역 시도
    const translated = await translateText(content, lang);

    // 3. 결과 반환 (HTML 대신 JSON으로 반환하여 프론트엔드에서 처리)
    res.json({
        url: url,
        originalContent: content.slice(0, 500), // 원문 일부 미리보기
        translatedContent: translated
    });

  } catch (e) {
    console.error("❌ Page Translation Failed:", e.stack || e);
    res.status(500).json({ error: "TRANSLATION_FAILED", detail: String(e?.message || e) });
  }
});

function generateETag(data) { return crypto.createHash("md5").update(JSON.stringify(data)).digest("hex"); }

// 캐시 컨트롤 미들웨어 (3분 캐시, 5분간 stale 허용)
function cacheControl(_req, res, next) {
    res.set("Cache-Control","public, max-age=180, stale-while-revalidate=300");
    next();
}

app.get("/healthz", (_req, res) => {
  res.json({
    status:"ok",
    env:NODE_ENV,
    uptime:process.uptime(),
    time:new Date().toISOString(),
    version:"4.2.0" // 버전 업데이트
  });
});

// 에러 핸들링 미들웨어
app.use((err, req, res, next) => {
  console.error('🚨 Server error:', err.stack || err.message);
  res.status(500).json({ ok: false, error: 'internal_error', message: err.message });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
app.listen(process.env.PORT || 3000, "0.0.0.0", () => console.log(`Server on ${process.env.PORT || 3000}`));
}

module.exports = {
  app
  // 테스트용 export는 제거됨
};
process.on("unhandledRejection", (err) => console.error(err));
process.on("uncaughtException", (err) => console.error(err));
process.on("unhandledRejection", (err) => console.error("Unhandled Rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled Rejection:", err));
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));
process.on("unhandledRejection", (err) => console.error(err));
process.on("uncaughtException", (err) => console.error(err));
