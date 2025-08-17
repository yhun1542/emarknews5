/*
/*
 * EmarkNews — 업그레이드 백엔드 (v4.5: v4.4 기반 + 성능 추적 및 외부 API 안정성 강화)
 */
"use strict";
console.log('🚀 Application starting...');
// Load environment variables
require('dotenv').config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require('fs');
const axios = require("axios");
const math = require("mathjs");
const cheerio = require("cheerio");
const expressGzip = require("compression");
// 3rd Party APIs
const OpenAI = require("openai");
const { TranslationServiceClient } = require("@google-cloud/translate").v3;
const redis = require("redis");
const NewsAPI = require("newsapi");
const { TwitterApi } = require("twitter-api-v2");
const Parser = require("rss-parser");
const app = express();
app.use(express.json());
app.use(expressGzip()); // Gzip for speed
/* 환경 변수 로드 */
const {
  NEWS_API_KEY = "",
  NEWS_API_KEYS = "",
  TWITTER_BEARER_TOKEN = "",
  OPENAI_API_KEY = "",
  OPENAI_MODEL = "gpt-4o-mini",
  GOOGLE_PROJECT_ID = "",
  TRANSLATE_API_KEY = "",
  REDIS_URL = "",
  NAVER_CLIENT_ID = "",
  NAVER_CLIENT_SECRET = "",
  YOUTUBE_API_KEY = "",
  NODE_ENV = "development"
} = process.env;
/* 초기화 로직 */
// NewsAPI 키 설정
let newsApiKey = NEWS_API_KEY;
if (!newsApiKey && NEWS_API_KEYS) {
  const keys = NEWS_API_KEYS.split(",");
  if (keys.length > 0) {
    newsApiKey = keys[0];
  }
}
// GOOGLE_APPLICATION_CREDENTIALS 처리
let googleCredentialsPath = null;
console.log('ℹ️ Attempting to process Google Credentials...');
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const gac_raw = process.env.GOOGLE_APPLICATION_CREDENTIALS.trim();
  let gac = gac_raw.replace(/\\n/g, "\n");
  let credentialsPath;
  if (gac.startsWith('{')) {
    credentialsPath = path.join(__dirname, 'gcloud_sa.json');
  } else if (gac.startsWith('-----BEGIN PRIVATE KEY-----')) {
    credentialsPath = path.join(__dirname, 'gcloud_sa.pem');
  } else {
    console.warn('⚠️ Google credentials format unusual. Assuming it might be a file path.');
    googleCredentialsPath = gac_raw;
  }
  if (credentialsPath) {
    try {
      // 파일 쓰기 시도
      fs.writeFileSync(credentialsPath, gac);
      googleCredentialsPath = credentialsPath;
      console.log('✅ Google credentials saved to file.');
    } catch (error) {
      // 파일 쓰기 실패 시 (Railway 권한 문제 등)
      console.error('❌ CRITICAL: Failed to write Google credentials file.', error.message);
      googleCredentialsPath = null;
    }
  }
}
// API 클라이언트 초기화
let newsapi = null;
if (newsApiKey) {
  newsapi = new NewsAPI(newsApiKey);
  console.log('✅ NewsAPI initialized.');
} else {
  console.warn("⚠️ NewsAPI key not found.");
}
const twitterClient = TWITTER_BEARER_TOKEN ? new TwitterApi(TWITTER_BEARER_TOKEN) : null;
if (twitterClient) console.log('✅ Twitter API initialized.');
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
if (openai) console.log('✅ OpenAI initialized.');
// Google Translate Client 초기화
const GCLOUD_SA_KEY = TRANSLATE_API_KEY || googleCredentialsPath;
let translateClientOptions = {};
let translateClient = null;
if (GOOGLE_PROJECT_ID) {
    try {
        if (GCLOUD_SA_KEY && typeof GCLOUD_SA_KEY === 'string') {
             if (GCLOUD_SA_KEY.startsWith('{') && !googleCredentialsPath) {
                 // 파일 쓰기에 실패했지만 환경 변수에 JSON 값이 있는 경우 (메모리에서 직접 사용)
                 const credentials = JSON.parse(GCLOUD_SA_KEY.replace(/\\n/g, "\n"));
                 translateClientOptions = { credentials };
             } else if (googleCredentialsPath) {
                 // 파일 경로 사용
                 translateClientOptions = { keyFilename: googleCredentialsPath };
             }
        }
        
        // 파일이 존재하거나 옵션이 설정된 경우에만 초기화
        if (Object.keys(translateClientOptions).length > 0 || (googleCredentialsPath && fs.existsSync(googleCredentialsPath))) {
            translateClient = new TranslationServiceClient(translateClientOptions);
            console.log('✅ Google Translate Client initialized.');
        } else {
            console.warn('⚠️ Google Translate Client could not be initialized (missing valid credentials).');
        }
        
    } catch (e) {
        console.error('❌ Google Translate initialization error:', e.message);
        translateClient = null;
    }
}
// Redis 연결
let redisClient = null;
const CACHE_DISABLED = process.env.DISABLE_CACHE === '1';
if (!CACHE_DISABLED && REDIS_URL) {
  console.log('ℹ️ Attempting to connect to Redis...');
  try {
    const client = redis.createClient({ url: REDIS_URL });
    client.on('error', (err) => {
        console.warn('⚠️ Redis Runtime Error:', err.message);
    });
    // 비동기 연결 시도
    client.connect().then(() => {
        console.log('✅ Redis connected.');
        redisClient = client; // 연결 성공 시에만 할당
    }).catch((err) => {
      console.warn('❌ Redis connection failed. Caching disabled:', err.message);
    });
  } catch (err) {
    console.warn('❌ Redis client creation failed. Caching disabled:', err.message);
  }
} else {
  console.log('ℹ️ Caching is disabled or REDIS_URL is missing.');
}
// RSS Parser 초기화
const rssParser = new Parser({
    timeout: 10000,
    headers: {
      "User-Agent": "EmarkNewsBot/1.0 (+https://emarknews.com)"
    }
});
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
  "ft.com": 1.09,
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
// 클러스터 레이팅 계산 로직
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
          // 기사 추가 후 updateCentroid 호출
          into.articles.push(art);
          updateCentroid(into, art);
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
// [v4.2 Patch] 코사인 유사도 계산 함수: 데이터 변조(Mutation) 버그 수정 및 안정성 강화
function cosineSimilarity(vecA, vecB) {
    try {
        // Safety check 1: Ensure inputs are valid arrays and not empty
        if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecB.length === 0) {
            return 0;
        }
        // Safety check 2: Ensure lengths match.
        // 길이가 다를 경우 짧은 벡터에 맞춰서 계산 (TF-IDF 벡터는 길이가 다를 수 있음)
        const length = Math.min(vecA.length, vecB.length);
        
        // 원본 배열을 수정하지 않고 slice하여 사용
        const A = vecA.slice(0, length);
        const B = vecB.slice(0, length);
        const dot = math.dot(A, B);
        const normA = math.norm(A);
        const normB = math.norm(B);
        // Safety check 3: Prevent division by zero
        if (normA === 0 || normB === 0) return 0;
        return dot / (normA * normB);
    } catch (e) {
        console.error("Cosine Similarity Error:", e.message);
        return 0;
    }
}
async function clusterArticles(articles, lang, quality = "low") {
  if (!Array.isArray(articles) || !articles.length) return [];
  const docs = articles.map(a => [a.title, a.summary, a.content].filter(Boolean).join(" "));
  const keywordsList = extractKeywordsWithTFIDF(docs);
  let vectors = [];
  
  // 벡터 생성 로직 (TF-IDF 기반 단순 벡터를 기본으로 사용)
  const allKeywords = new Set(keywordsList.flat().filter(k => k));
  const keywordIndex = new Map(Array.from(allKeywords).map((k, i) => [k, i]));
  vectors = keywordsList.map(kwList => {
      const vector = new Array(allKeywords.size).fill(0);
      kwList.filter(k => k).forEach(k => {
          const index = keywordIndex.get(k);
          if (index !== undefined) {
              vector[index] = 1; // 단순 이진 벡터화
          }
      });
      return vector;
  });
  // OpenAI 임베딩 사용 (선택적)
  if (quality === "high" && openai) {
      try {
        console.log("ℹ️ Using OpenAI embeddings for clustering...");
        // [v4.5] 타임아웃 설정 추가
        const embeds = await openai.embeddings.create({ 
            model: "text-embedding-3-small", 
            input: docs 
        }, { timeout: 20000 }); // 20초 타임아웃
        vectors = embeds.data.map(e => e.embedding);
      } catch (e) {
          console.error("❌ OpenAI Embedding Error:", e.message);
          // 실패 시 TF-IDF 벡터 사용 (이미 생성됨)
      }
  }
  const buckets = new Map();
  const SIMILARITY_THRESHOLD = quality === "high" ? 0.75 : 0.5; // TF-IDF 임계값 조정
  for (let i = 0; i < articles.length; i++) {
    const sig = keywordsList[i].filter(k => k).join("|");
    let matched = false;
    // 벡터가 유효한지 확인
    if (!vectors[i] || vectors[i].length === 0) continue;
    for (const [existingSig, cluster] of buckets) {
      const clusterVector = vectors[cluster.index];
      const sim = cosineSimilarity(vectors[i], clusterVector);
      if (sim > SIMILARITY_THRESHOLD) {
        if (cluster.articles.length < MAX_CLUSTER_SIZE) {
          // 기사 추가 후 updateCentroid 호출
          cluster.articles.push(articles[i]);
          updateCentroid(cluster, articles[i]);
          matched = true;
        }
        break;
      }
    }
    if (!matched) {
      const cluster = createEmptyCluster(sig);
      // 첫 기사 추가
      cluster.articles.push(articles[i]);
      updateCentroid(cluster, articles[i]);
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
  // 최종 정렬: 점수(Score) 기준 내림차순
  clusters.sort((a,b)=>b.score-a.score);
  // [v4.2 Patch] 최종 매핑: publishedAtAvg 변환 시 크래시 방지 (Invalid Time Value 해결)
  return clusters.map(c => ({
    id:c.id, signature:c.signature, keywords:c.keywords, score:c.score, size:c.articles.length,
    labels:c.labels, rating:c.rating,
    isUrgent: c.isUrgent,
    isBuzz: c.isBuzz,
    articles:c.articles,
    centroid:{
      titleTopKeywords: Array.from(c.centroid.titleTokens.entries()).sort((a,b)=>b[1]-a[1]).slice(0,SIGNATURE_TOPK).map(([k])=>k),
      
      // publishedAtAvg가 유효한 숫자인지 확인 후 toISOString() 호출
      publishedAtAvg: Number.isFinite(c.centroid.publishedAtAvg) && c.centroid.publishedAtAvg > 0
                        ? new Date(c.centroid.publishedAtAvg).toISOString()
                        : null
    },
    createdAt:c.createdAt
  }));
}
async function translateText(text, targetLang = "ko") {
  if (!text || typeof text !== 'string' || text.trim() === '' || !translateClient || !GOOGLE_PROJECT_ID) {
      return text;
  }
  // 간단한 언어 감지
  const isKorean = /[가-힣]/.test(text);
  if (isKorean && targetLang === 'ko') return text;
  const request = {
    parent: `projects/${GOOGLE_PROJECT_ID}/locations/global`,
    contents: [text],
    mimeType: "text/plain",
    targetLanguageCode: targetLang,
  };
  try {
    // [v4.5] 타임아웃 설정 추가
    const [response] = await translateClient.translateText(request, { timeout: 10000 }); // 10초 타임아웃
    if (response.translations && response.translations.length > 0) {
        return response.translations[0].translatedText || text;
    }
    return text;
  } catch (e) {
    // [v4.5] 에러 로깅 강화
    console.error(`❌ Translate Error (${e.code || 'Unknown'}):`, e.message.slice(0, 150));
    return text; // 번역 실패 시 원문 반환
  }
}
// [v4.4 Patch] AI 요약 함수 개선 (모달용 프롬프트 추가)
async function generateAiSummary(article, format = "bullet", model = OPENAI_MODEL) {
    if (!openai) {
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
    } else { // format === "modal"
        // [v4.4] 모달 뷰용: 핵심 요약 프롬프트
        prompt = `Analyze the following news article and extract only the most critical information. Present it as a structured summary with key takeaways in bullet points (using ·). The entire summary must be concise enough to fit on a single screen (max 150 words). Do not include minor details or ellipses (...).
Input:
${inputText.slice(0, 4000)}
Structured Summary (using · for bullets):`;
    }
    try {
        // [v4.5] 타임아웃 설정 추가
        const resp = await openai.chat.completions.create({
            model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: format === "bullet" ? 200 : 300, // 토큰 제한 조정
            temperature: 0.2
        }, { timeout: 15000 }); // 15초 타임아웃
        let summary = resp.choices[0].message.content.trim();
        // AI가 프롬프트를 따르지 않았을 경우 후처리
        if (format === "bullet" && !summary.startsWith('·')) {
            const lines = summary.split('.').filter(line => line.trim() !== '');
            if (lines.length > 0) {
                return lines.slice(0, 3).map(line => `· ${line.trim()}`).join('\n');
            }
        }
        // [v4.4] 모달 요약 후처리 강화
        if (format === "modal" && !summary.includes('·')) {
             // 마침표를 기준으로 분리 후 불릿 추가
             const lines = summary.split('. ').filter(line => line.trim() !== '');
             if (lines.length > 0) {
                 summary = lines.map(line => `· ${line.trim().replace(/\.$/, '')}`).join('\n');
             }
        }
        return summary || article.summary || article.description;
    } catch (e) {
        // [v4.5] 에러 로깅 강화
        console.error(`❌ AI Summary Error (${e.code || 'Unknown'}):`, e.message);
        return article.summary || article.description;
    }
}
// [v4.4 Patch] processArticles 수정 (국내 뉴스 AI 요약 적용)
async function processArticles(articles, lang, options = {}) {
  // aiSummary 기본값 true로 설정
  const { aiSummary = true, quality } = options;
  return Promise.all(articles.map(async (article) => {
    // 1. AI 요약 생성 (카드 뷰용 불릿 포인트)
    // [v4.4] 모든 기사에 대해 AI 요약 생성 시도
    if (aiSummary) {
        article.aiSummaryBullet = await generateAiSummary(article, "bullet");
        // 상세 요약은 Quality=High일 때만 생성
        if (quality === 'high') {
             article.aiSummaryDetailed = await generateAiSummary(article, "modal");
        }
    }
    const titleToTranslate = article.title;
    // 요약은 AI 요약(불릿)을 우선 사용
    const summaryToTranslate = article.aiSummaryBullet || article.summary || article.description;
    // 2. 번역 (소스 언어와 목표 언어가 같으면 생략)
    if (article.sourceLang === lang) {
        article.translatedTitle = titleToTranslate;
        article.translatedSummary = summaryToTranslate;
        // 국내 뉴스의 경우 상세 요약도 원본으로 설정
        if (!article.aiSummaryDetailed) {
            article.aiSummaryDetailed = summaryToTranslate;
        }
        return article;
    }
    article.translatedTitle = await translateText(titleToTranslate, lang);
    article.translatedSummary = await translateText(summaryToTranslate, lang);
    
    // 상세 요약도 번역
    if (article.aiSummaryDetailed) {
        article.aiSummaryDetailed = await translateText(article.aiSummaryDetailed, lang);
    }
    
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
    // 2. 화제성 (Buzz): X(Twitter) 검색 결과 기반
    let buzzTopics = new Set();
    if (twitterClient) {
        try {
            // X에서 '속보', '긴급', '주요 이슈' 관련 트윗 검색
            const query = 'breaking news OR urgent OR major event lang:en OR lang:ko OR lang:ja';
            // [v4.5] max_results 조정 및 타임아웃 설정
            const params = {
                max_results: 20,
                'tweet.fields': 'created_at,text'
            };
            console.log("ℹ️ Calling X API for Buzz analysis...");
            const xBuzz = await twitterClient.v2.search(query, params);
            if (xBuzz && xBuzz.data && xBuzz.data.data) {
                xBuzz.data.data.forEach(tweet => {
                    // 트윗 내용에서 주요 키워드 추출
                    const keywords = extractKeywordsWithTFIDF([tweet.text], 5)[0].filter(k => k);
                    keywords.forEach(k => buzzTopics.add(k));
                });
            }
        } catch (e) {
            // [v4.5] 에러 핸들링 강화
            console.error("❌ X API (Twitter) Error:", e.message);
            if (e.data && e.data.errors) {
                console.error("X API Details:", JSON.stringify(e.data.errors));
            }
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
/* API 헬퍼 함수들 */
// Naver API 헬퍼
async function fetchFromNaverAPI(query = "주요 뉴스", display = 40) {
    if (!NAVER_CLIENT_ID || !NAVER_CLIENT_SECRET) {
      // console.warn("⚠️ Naver API credentials not found.");
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
        },
        timeout: 8000 // 8초 타임아웃
      });
      if (response.data && response.data.items) {
        // console.log(`✅ Naver API: Retrieved ${response.data.items.length} articles for query "${query}"`);
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
        // console.warn('⚠️ NewsAPI client is not initialized.');
        return [];
    }
    // 기본 파라미터 설정
    const queryParams = {
        pageSize: 50,
        language: 'en',
        ...params
    };
    try {
        // NewsAPI는 자체적으로 타임아웃 설정이 명확하지 않음
        const response = await newsapi.v2.topHeadlines(queryParams);
        if (response && response.articles) {
            // console.log(`✅ NewsAPI: Retrieved ${response.articles.length} articles.`);
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
        return [];
    }
}
// RSS 피드 헬퍼
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
/* 섹션별 기사 수집 로직 */
async function fetchArticlesForSection(section, freshness, domainCap, lang) {
  let items = [];
  // console.log(`ℹ️ Fetching articles for section: ${section}`);
  switch (section) {
    case "world":
      // 주력: NewsAPI (영어권 주요 국가)
      items = await fetchFromNewsAPI({ language: 'en' });
      // 보조: 주요 외신 RSS (BBC, Reuters 등)
      const worldRss = [
        "http://feeds.reuters.com/reuters/topNews",
        "https://feeds.bbci.co.uk/news/world/rss.xml",
        "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"
      ];
      const rssItemsWorld = await fetchFromRSS(worldRss, 5, 'en');
      items.push(...rssItemsWorld);
      break;
    case "kr":
      // 주력: Naver API (NewsAPI 사용 금지 조건 반영)
      items = await fetchFromNaverAPI("주요 뉴스");
      // 보조: 국내 주요 언론사 RSS
      const krRss = [
        "https://rss.donga.com/total.xml",
        "http://rss.joins.com/joins_news_list.xml",
        "https://www.yonhapnewstv.co.kr/browse/feed/"
      ];
      const rssItemsKr = await fetchFromRSS(krRss, 5, 'ko');
      items.push(...rssItemsKr);
      break;
    case "japan":
      // 주력: NewsAPI (Country: jp, Language: ja)
      items = await fetchFromNewsAPI({ country: 'jp', language: 'ja' });
      // 보조: 일본 주요 언론사 RSS (Naver API 사용 금지 조건 반영)
      const jpRss = [
        "http://rss.asahi.com/rss/asahi/newsheadlines.rdf",
        "http://www3.nhk.or.jp/rss/news/cat0.xml",
        "https://www.japantimes.co.jp/feed/"
      ];
      const rssItemsJp = await fetchFromRSS(jpRss, 5, 'ja');
      items.push(...rssItemsJp);
      break;
    case "buzz":
      // [v4.4] 데이터 소스 확장
      const buzzWorld = await fetchFromNewsAPI({ language: 'en', pageSize: 50, sortBy: 'popularity' });
      const buzzKr = await fetchFromNaverAPI("실시간 인기 뉴스", 40);
      const buzzJp = await fetchFromNewsAPI({ language: 'ja', country: 'jp', pageSize: 40, sortBy: 'popularity' });
      items.push(...buzzWorld, ...buzzKr, ...buzzJp);
      break;
    case "business":
        // [v4.4] 데이터 소스 확장
        const businessApi = await fetchFromNewsAPI({ category: 'business', language: 'en' });
        items.push(...businessApi);
        const businessRss = [
            "http://feeds.wsjonline.com/wsj/xml/rss/3_7014.xml", // WSJ Business
            "https://www.ft.com/rss/home/us" // Financial Times
        ];
        const rssItemsBusiness = await fetchFromRSS(businessRss, 10, 'en');
        items.push(...rssItemsBusiness);
        break;
    case "youtube":
      // [v4.4] 데이터 소스 확장
      if (YOUTUBE_API_KEY) {
        try {
          const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
            params: {
              part: 'snippet',
              q: 'breaking news OR live news OR 속보 OR ライブニュース',
              type: 'video',
              order: 'date',
              maxResults: 20,
              key: YOUTUBE_API_KEY
            },
            timeout: 8000
          });
          const youtubeItems = response.data.items.map(item => ({
            title: item.snippet.title,
            url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
            publishedAt: item.snippet.publishedAt,
            summary: item.snippet.description,
            source: 'youtube.com',
            sourceLang: item.snippet.title.match(/[가-힣]/) ? 'ko' : (item.snippet.title.match(/[ぁ-んァ-ン]/) ? 'ja' : 'en')
          }));
          items.push(...youtubeItems);
        } catch (e) {
          console.error('❌ YouTube API error:', e.message);
        }
      }
      break;
    // Tech 등 기타 유효한 NewsAPI 카테고리
    default:
      if (['business', 'technology', 'science', 'health', 'sports', 'entertainment', 'tech'].includes(section)) {
        const category = section === 'tech' ? 'technology' : section;
        items = await fetchFromNewsAPI({ category: category, language: 'en' });
      } else {
        console.warn(`⚠️ Unknown or unhandled section: ${section}`);
      }
      break;
  }
  // 후처리 (시간 필터링, 도메인 캡, 중복 제거)
  const effectiveFreshness = Math.min(freshness, 48);
  const minTs = NOW() - effectiveFreshness * HOUR;
  // 1. 시간 필터링
  items = items.filter(item => {
    if (!item.publishedAt) return false;
    const ts = Date.parse(item.publishedAt);
    return Number.isFinite(ts) && ts >= minTs;
  });
  // 2. 도메인 캡
  if (domainCap > 0) {
    const domainCount = {};
    items = items.filter(item => {
      const domain = getDomain(item.url);
      if (!domain) return true;
      domainCount[domain] = (domainCount[domain] || 0) + 1;
      return domainCount[domain] <= domainCap;
    });
  }
  // 3. 중복 제거 (URL 기준)
  const uniqueItems = Array.from(new Map(items.map(item => [item.url, item])).values());
  // console.log(`ℹ️ Total unique articles fetched for ${section}: ${uniqueItems.length}`);
  return uniqueItems;
}
// 웹 스크래핑 함수
async function safeFetchArticleContent(url) {
  if (!url) return null;
  try {
    const response = await axios.get(url, {
        timeout: 8000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36'
        }
    });
    const $ = cheerio.load(response.data);
    // 네이버 뉴스 본문 추출 로직
    if (getDomain(url) === 'naver.com') {
        let content = $('#dic_area').text() || $('#articeBody').text() || $('article').text();
        return content.trim().replace(/\s+/g, ' ').slice(0, 5000);
    }
    // 일반적인 본문 추출 로직
    $('script, style, nav, footer, aside, iframe, header, noscript').remove();
    let content = $('article').text() || $('body').text();
    return content.trim().replace(/\s+/g, ' ').slice(0, 5000);
  } catch (e) {
    // console.error(`❌ Safe fetch error for ${url}:`, e.message);
    return null;
  }
}
/* 라우팅 및 미들웨어 (v4.3.1: 순서 최적화 적용) */
// --- 1. API 엔드포인트 (최우선 처리) ---
// 메인 피드 엔드포인트
app.get("/feed", async (req, res) => {
  // [v4.5] 성능 추적 시작
  const startTime = Date.now();
  console.time(`📊 Feed generation (${req.query.section || 'world'})`);
  
  try {
    const section = (req.query.section || "world").toString();
    const freshness = parseInt(req.query.freshness ?? "48", 10);
    const domainCap = parseInt(req.query.domain_cap ?? "5", 10);
    
    // [v4.3 Patch] 언어 강제 적용 로직
    let lang = (req.query.lang || "ko").toString();
    if (section === 'kr') {
        lang = 'ko';
    } 
    
    const quality = (req.query.quality || "low").toString();
    const postEdit = req.query.post_edit === 'true';
    const cacheKey = `feed_v4_5:${section}:${freshness}:${domainCap}:${lang}:${quality}:${postEdit}`;
    // Redis 캐시 확인
    if (redisClient && redisClient.isReady) {
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                const payload = JSON.parse(cached);
                const etag = generateETag(payload);
                res.set("ETag", etag);
                if (req.headers["if-none-match"] === etag) return res.status(304).end();
                console.timeEnd(`📊 Feed generation (${section}) [CACHED]`);
                return res.json(payload);
            }
        } catch (e) {
            console.error("Redis Cache Read Error:", e.message);
        }
    }
    // 1. 기사 수집
    console.time("⏳ 1. Fetching");
    let items = await fetchArticlesForSection(section, freshness, domainCap, lang);
    console.timeEnd("⏳ 1. Fetching");
    if (items.length === 0) {
        console.timeEnd(`📊 Feed generation (${section}) [EMPTY]`);
        return res.json({ clusters: [], count: 0, generatedAt: new Date().toISOString() });
    }
    
    // 2. 긴급도/화제성 계산 (X API 호출)
    console.time("⏳ 2. Urgency/Buzz");
    items = await computeUrgencyBuzz(items);
    console.timeEnd("⏳ 2. Urgency/Buzz");
    // 3. Quality=High일 경우 기사 전문 스크래핑 (선택적)
    if (quality === "high") {
      console.time("⏳ 3. Scraping (High Quality)");
      await Promise.all(items.map(async (item) => {
        if (!item.content || item.content.length < 500) {
            const content = await safeFetchArticleContent(item.url);
            if (content && content.length > 100) item.content = content;
        }
      }));
      console.timeEnd("⏳ 3. Scraping (High Quality)");
    }
    // 4. 기사 처리 (AI 요약 생성 및 번역/후편집)
    console.time("⏳ 4. Processing (AI/Translate)");
    items = await processArticles(items, lang, {
        aiSummary: true,
        postEdit: postEdit,
        quality: quality
    });
    console.timeEnd("⏳ 4. Processing (AI/Translate)");
    // 5. 클러스터링
    console.time("⏳ 5. Clustering");
    let originalClusters = await clusterArticles(items, lang, quality);
    let clusters = [...originalClusters];
    console.timeEnd("⏳ 5. Clustering");
    // 6. 'Buzz' 섹션 필터링 및 정렬
    console.time("⏳ 6. Sorting/Filtering");
    if (section === 'buzz') {
        // [v4.4] Buzz 필터링 로직 완화 및 폴백
        clusters = clusters.filter(c => c.isBuzz || c.isUrgent || c.rating >= 4.0);
        if (clusters.length === 0) {
            console.log("⚠️ Buzz section empty after filtering, using top-rated fallback.");
            // [v4.4] 폴백 시에도 Rating 기준 정렬
            clusters = originalClusters.sort((a, b) => b.rating - a.rating).slice(0, 30);
        }
    }
    // [v4.4 Patch] 최종 정렬: score 대신 rating(별점) 기준으로 정렬 (매우 중요)
    clusters.sort((a, b) => b.rating - a.rating);
    // 7. 상위 결과 랜덤화 (새로고침 시 다양성 제공하면서 순위 유지)
    const TOP_N = 20;
    const topClusters = clusters.slice(0, TOP_N);
    // Slight Shuffle
    for (let i = topClusters.length - 1; i > 0; i--) {
        const j = i - 1;
        // 점수(Rating) 차이가 0.5 이하이고 무작위 확률 30%일 때 교환
        if (Math.abs(topClusters[i].rating - topClusters[j].rating) <= 0.5 && Math.random() > 0.7) {
            [topClusters[i], topClusters[j]] = [topClusters[j], topClusters[i]];
        }
    }
    clusters.splice(0, TOP_N, ...topClusters);
    console.timeEnd("⏳ 6. Sorting/Filtering");
    const payload = {
      section, freshness, domain_cap: domainCap, lang, quality, post_edit: postEdit,
      count: items.length,
      clusters,
      generatedAt: new Date().toISOString()
    };
    // Redis 캐시 저장
    if (redisClient && redisClient.isReady) {
        try {
            await redisClient.setEx(cacheKey, 180, JSON.stringify(payload));
        } catch (e) {
            console.error("Redis Cache Write Error:", e.message);
        }
    }
    const etag = generateETag(payload);
    res.set("ETag", etag);
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    console.timeEnd(`📊 Feed generation (${section})`);
    res.json(payload);
  } catch (e) {
    console.error("❌ FEED Generation Failed:", e.stack || e);
    res.status(500).json({ error: "FEED_GENERATION_FAILED", detail: String(e?.message || e) });
  }
});
// 기사 전문 번역 엔드포인트
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
    const translated = await translateText(content, lang);
    // 3. 결과 반환
    res.json({
        url: url,
        originalContent: content.slice(0, 500),
        translatedContent: translated
    });
  } catch (e) {
    console.error("❌ Page Translation Failed:", e.stack || e);
    res.status(500).json({ error: "TRANSLATION_FAILED", detail: String(e?.message || e) });
  }
});
// --- 3. 정적 파일 서빙 (API 다음 순위) ---
app.use(express.static(PUBLIC_DIR, {
  maxAge: '1h',
  etag: true,
  lastModified: true
}));
// --- 4. 프론트엔드 라우팅 (Catch-all) ---
// 루트 페이지: public/index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
// SPA를 위한 Catch-all: 정의되지 않은 모든 경로는 index.html로 보냄
// API 경로(/feed, /translate_page 등)는 이미 위에서 처리되었으므로 여기서는 제외됨
app.get('*', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
// 에러 핸들링 미들웨어
app.use((err, req, res, next) => {
  console.error('🚨 Server error:', err.stack || err.message);
  res.status(500).json({ ok: false, error: 'internal_error', message: err.message });
});
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  // Railway 환경에서는 0.0.0.0으로 리스닝해야 함
  app.listen(PORT, '0.0.0.0', () => console.log(`✅ [UPGRADED v4.5] Server listening on :${PORT}`));
}
module.exports = {
  app
};
