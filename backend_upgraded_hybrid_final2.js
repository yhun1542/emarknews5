/*
 * EmarkNews — 업그레이드 백엔드 (hybrid 기준 + 장점 통합: v3 Translate, YouTube, optional safe scraping, urgency/buzz with x_semantic_search, /translate_page with browse_page, gzip)
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
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
  }
});
  timeout: 10000,
  headers: {
    'User-Agent': 'EmarkNewsBot/1.0 (+https://emarknews.com)',
  }
});
const math = require("mathjs");
const axios = require("axios");
const cheerio = require("cheerio");
const zlib = require("zlib");
const expressGzip = require("compression");
const app = express();

app.use(express.json());
app.use(expressGzip()); // Gzip for speed

// 진단 엔드포인트 (정적 파일 서빙 전에 정의)
app.get('/_diag/keys', (req, res) => {
  const keys = {
    NEWS_API_KEY: !!process.env.NEWS_API_KEY,
    GNEWS_API_KEY: !!process.env.GNEWS_API_KEY,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    GOOGLE_APPLICATION_CREDENTIALS: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
    TWITTER_BEARER_TOKEN: !!process.env.TWITTER_BEARER_TOKEN,
    REDIS_URL: !!process.env.REDIS_URL,
    NAVER_CLIENT_ID: !!process.env.NAVER_CLIENT_ID,
    NAVER_CLIENT_SECRET: !!process.env.NAVER_CLIENT_SECRET
  };
  res.json({ status: 'ok', keys, timestamp: new Date().toISOString() });
});

app.get('/_diag/redis', (req, res) => {
  const redisStatus = {
    enabled: !process.env.DISABLE_CACHE,
    url: !!process.env.REDIS_URL,
    connected: false // Redis 연결 상태는 실제 연결 후 업데이트
  };
  res.json({ status: 'ok', redis: redisStatus, timestamp: new Date().toISOString() });
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
  newsApiKey = NEWS_API_KEYS.split(",")[0];
}

if (!newsApiKey) {
  console.error("❌ NewsAPI key not found. Please set NEWS_API_KEY or NEWS_API_KEYS environment variable.");
  process.exit(1);
}

// GOOGLE_APPLICATION_CREDENTIALS 처리 (PEM/JSON 지원)
const fs = require('fs');

// Google Credentials 처리 (기존 코드 확장)
let googleCredentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS.trim();
    gac = gac.replace(/\\n/g, "\n");
  let credentialsPath;
  if (gac.startsWith('{')) {
    // JSON 형식 (기존 처리)
    credentialsPath = path.join(__dirname, 'gcloud_sa.json');
  } else if (gac.startsWith('-----BEGIN PRIVATE KEY-----')) {
    // PEM 형식 추가 (로그 기반)
    credentialsPath = path.join(__dirname, 'gcloud_sa.pem');
  } else {
    console.error('❌ Invalid Google credentials format');
    console.error('Expected: JSON (starts with {) or PEM (starts with -----BEGIN PRIVATE KEY-----)');
    // 에러 시에도 서비스 계속 실행 (번역 기능만 비활성화)
    googleCredentialsPath = null;
  }

  if (credentialsPath) {
    try {
      fs.writeFileSync(credentialsPath, gac);
      process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
      googleCredentialsPath = credentialsPath;
      console.log('✅ Google credentials saved to file:', credentialsPath);
    } catch (error) {
      console.error('❌ Failed to save Google credentials:', error.message);
      googleCredentialsPath = null;
    }
  }
}

// 초기화
const newsapi = new NewsAPI(newsApiKey);
const twitterClient = new TwitterApi(TWITTER_BEARER_TOKEN);
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const GCLOUD_SA_KEY = process.env.TRANSLATE_API_KEY;
let translateClientOptions = {};
try {
    if (GCLOUD_SA_KEY && GCLOUD_SA_KEY.startsWith('{')) {
        const credentials = JSON.parse(GCLOUD_SA_KEY);
        translateClientOptions = { credentials };
    } else {
        translateClientOptions = { keyFilename: GCLOUD_SA_KEY };
    }
} catch (e) {
    console.error('Google Translate 인증 정보 파싱 오류:', e);
}
const translateClient = new TranslationServiceClient(translateClientOptions);
// Redis 연결 (선택적, 캐시 비활성화 가능)
let redisClient = null;
const CACHE_DISABLED = false;

if (!CACHE_DISABLED) {
  try {
    redisClient = redis.createClient({ url: REDIS_URL });
    redisClient.connect().catch((err) => {
      console.warn('Redis 연결 실패, 캐시 비활성화:', err.message);
      redisClient = null;
    });
  } catch (err) {
    console.warn('Redis 클라이언트 생성 실패, 캐시 비활성화:', err.message);
    redisClient = null;
  }
} else {
  console.log('캐시가 환경변수로 비활성화됨 (DISABLE_CACHE=1)');
}
/* 상수/유틸 */
const NOW = () => Date.now();
const HOUR = 3600 * 1000;
const TIME_DECAY_TAU_HOURS = 72;
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
  "kbs.co.kr": 1.10,
  "ytn.co.kr": 1.08,
  "imbc.com": 1.08,
  "nhk.or.jp": 1.15,
  "asahi.com": 1.12,
  "mainichi.jp": 1.10,
  "yomiuri.co.jp": 1.08,
  "nypost.com": 1.12,
  "cnbc.com": 1.11,
  "youtube.com": 1.05 // Added for YouTube
};

const LABEL_RULES = {
  politics: [/election|senate|parliament|white\s*house|의회|총선|대선|정당|의장|외교|국방/i],
  economy:  [/inflation|gdp|interest|bond|market|고용|물가|성장률|경제|수출|환율/i],
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
    terms.forEach(t => freq.set(t, (freq.get(t) || 0) + 1 / terms.length));
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
  const sig = keys.sort().join("|");
  return sig || (article.title ? normalizeText(article.title).slice(0,80) : "no-title");
}

function hashId(s) { return crypto.createHash("md5").update(s).digest("hex").slice(0,12); }

function getDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./,""); }
  catch { return ""; }
}

function freshnessWeight(publishedAt) {
  if (!publishedAt) return 0.9;
  const ts = typeof publishedAt==="string" ? Date.parse(publishedAt) : +publishedAt;
  if (!Number.isFinite(ts)) return 0.9;
  const hours = (NOW()-ts)/HOUR;
  const w = Math.exp(-Math.max(0,hours)/TIME_DECAY_TAU_HOURS);
  return Math.min(1.0, Math.max(0.2, w));
}

function sourceWeight(url) {
  const d = getDomain(url);
  return d ? (SOURCE_QUALITY[d] || 1.0) : 1.0;
}

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
  const wS = (sSum / cluster.articles.length) / 1.10;
  const sizeBoost = Math.log(1 + cluster.articles.length) / Math.log(1 + MAX_CLUSTER_SIZE);
  const diversity = uniqueDomains.size / cluster.articles.length;
  const urgencyBoost = (urgencySum / cluster.articles.length) * 0.1;
  const buzzBoost = (buzzSum / cluster.articles.length) * 0.1;
  const raw = 0.4 * wF + 0.3 * wS + 0.1 * sizeBoost + 0.1 * diversity + urgencyBoost + buzzBoost;
  return Math.min(5, +(raw * 5).toFixed(2));
}

function createEmptyCluster(signature) {
  return {
    id: hashId(signature + ":" + Math.random().toString(36).slice(2,8)),
    signature,
    keywords: signature ? signature.split("|") : [],
    articles: [],
    centroid: { titleTokens:new Map(), publishedAtAvg:0 },
    score: 0,
    labels: [],
    rating: 0,
    createdAt: new Date().toISOString()
  };
}

function updateCentroid(cluster, article) {
  const keys = extractKeywordsWithTFIDF([article.title || ""])[0];
  for (const k of keys) {
    cluster.centroid.titleTokens.set(k, (cluster.centroid.titleTokens.get(k)||0)+1);
  }
  const ts = article.publishedAt ? Date.parse(article.publishedAt) : NaN;
  if (Number.isFinite(ts)) {
    const n = cluster.articles.length;
    const prev = cluster.centroid.publishedAtAvg || ts;
    cluster.centroid.publishedAtAvg = (prev * (n - 1) + ts) / n;
  }
}

function clusterScore(cluster) {
  if (!cluster.articles.length) return 0;
  let fSum=0, sSum=0;
  for (const a of cluster.articles) { fSum+=freshnessWeight(a.publishedAt); sSum+=sourceWeight(a.url); }
  const fAvg = fSum/cluster.articles.length;
  const sAvg = sSum/cluster.articles.length;
  const sizeBoost = Math.log(1+cluster.articles.length);
  return fAvg * sAvg * sizeBoost;
}

function intersectionSize(aSet, bSet) {
  let count = 0;
  for (const x of aSet) if (bSet.has(x)) count++;
  return count;
}

function mergeNearbyBuckets(buckets) {
  const sigs = Array.from(buckets.keys()).sort((a,b) => (a.length - b.length) || a.localeCompare(b));
  const sigToSet = new Map(sigs.map(s => [s, new Set(s.split("|"))]));
  for (let i = 0; i < sigs.length; i++) {
    const a = sigs[i];
    const aSet = sigToSet.get(a);
    if (!buckets.has(a)) continue;
    for (let j = i + 1; j <= Math.min(i + 3, sigs.length - 1); j++) {
      const b = sigs[j];
      if (!buckets.has(b)) continue;
      const bSet = sigToSet.get(b);
      const inter = intersectionSize(aSet, bSet);
      const minSize = Math.min(aSet.size, bSet.size);
      if (inter >= Math.ceil(minSize * 0.5)) {
        const A = buckets.get(a), B = buckets.get(b);
        const into = (A.articles.length >= B.articles.length) ? A : B;
        const from = (into === A) ? B : A;
        for (const art of from.articles) {
          if (into.articles.length >= MAX_CLUSTER_SIZE) break;
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
}

async function clusterArticles(articles, lang, quality = "low") {
  if (!Array.isArray(articles) || !articles.length) return [];
  const docs = articles.map(a => [a.title, a.summary, a.content].join(" "));
  const keywordsList = extractKeywordsWithTFIDF(docs);
  let vectors = keywordsList.map(kw => kw.map(w => 1)); // simple vec
  if (quality === "high" && openai) {
    const embeds = await openai.embeddings.create({ model: "text-embedding-ada-002", input: docs });
    vectors = embeds.data.map(e => e.embedding);
  }
  const buckets = new Map();
  for (let i = 0; i < articles.length; i++) {
    const sig = keywordsList[i].join("|");
    let matched = false;
    for (const [existingSig, cluster] of buckets) {
      const sim = cosineSimilarity(vectors[i], vectors[cluster.index || 0]);
      if (sim > 0.6) {
        if (cluster.articles.length < MAX_CLUSTER_SIZE) {
          cluster.articles.push(articles[i]);
          updateCentroid(cluster, articles[i]);
          matched = true;
        }
        break;
      }
    }
    if (!matched) {
      const cluster = createEmptyCluster(sig);
      cluster.articles.push(articles[i]);
      cluster.index = i;
      updateCentroid(cluster, articles[i]);
      buckets.set(sig, cluster);
    }
  }
  mergeNearbyBuckets(buckets);
  const clusters = Array.from(buckets.values());
  for (const c of clusters) {
    c.score = clusterScore(c);
    await enrichCluster(c, lang);
  }
  clusters.sort((a,b)=>b.score-a.score);
  return clusters.map(c => ({
    id:c.id, signature:c.signature, keywords:c.keywords, score:c.score, size:c.articles.length,
    labels:c.labels, rating:c.rating,
    articles:c.articles,
    centroid:{
      titleTopKeywords: Array.from(c.centroid.titleTokens.entries()).sort((a,b)=>b[1]-a[1]).slice(0,SIGNATURE_TOPK).map(([k])=>k),
      publishedAtAvg: c.centroid.publishedAtAvg ? new Date(c.centroid.publishedAtAvg).toISOString() : null
    },
    createdAt:c.createdAt
  }));
}

async function translateText(text, targetLang = "ko") {
  if (!text || typeof text !== 'string' || text.trim() === '' || targetLang === "en" || !translateClient || !GOOGLE_PROJECT_ID) { return text; }
  const request = {
    parent: `projects/${GOOGLE_PROJECT_ID}/locations/global`,
    contents: [text],
    mimeType: "text/plain",
    targetLanguageCode: targetLang,
  };
  try {
    const [response] = await translateClient.translateText(request);
    return response.translations[0].translatedText || text;
  } catch (e) {
    // 로그 폭주 방지를 위해 에러 타입별 처리
    if (e.code === 'UNAUTHENTICATED') {
      console.error("❌ Google Translate authentication failed - check credentials");
    } else if (e.code === 'PERMISSION_DENIED') {
      console.error("❌ Google Translate permission denied - check project ID and API enabled");
    } else {
      console.error("❌ Translate Error:", e.message || e);
    }
    return text; // 번역 실패 시 원문 반환
  }
}

async function postEditKoWithLLM({ sourceText, googleKo, model = OPENAI_MODEL, temperature = 0.2, maxTokens = 500 }) {
  if (!openai) return googleKo;
  const prompt = `역할: 한국어 뉴스 편집 데스크. 영어 원문: "${sourceText}"\nGoogle 번역: "${googleKo}"\n작업: 자연스럽고 정확한 한국어로 후편집. 보도체 유지, 의미 불변, 수치/이름 보존, 문법/유창함 개선.`;
  try {
    const resp = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: maxTokens
    });
    return resp.choices[0].message.content.trim() || googleKo;
  } catch (e) {
    console.error("PostEdit Error:", e);
    return googleKo;
  }
}

async function generateAiSummary(article, model = OPENAI_MODEL) {
  if (!openai || !article.description) return article.summary || article.description;
  const prompt = `Summarize this news article concisely in English, focusing on key facts, events, and implications. Keep it under 150 words: Title: ${article.title}\nDescription: ${article.description || article.content}`;
  try {
    const resp = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      temperature: 0.3
    });
    return resp.choices[0].message.content.trim();
  } catch (e) {
    console.error("AI Summary Error:", e);
    return article.summary || article.description;
  }
}

async function processArticles(articles, lang, options = {}) {
  const { aiSummary = false, postEdit = false, peModel, peStrategy = "auto" } = options;
  return Promise.all(articles.map(async (article) => {
    if (aiSummary) article.aiSummary = await generateAiSummary(article);
    const summaryToUse = article.aiSummary || article.summary || article.description;

    let translatedTitle = await translateText(article.title, lang);
    let translatedSummary = await translateText(summaryToUse, lang);

    if (postEdit && openai) {
      let doPE = (peStrategy === "always");
      if (!doPE) {
        const srcHead = [article.title, summaryToUse].join(" ");
        const category = classifyCategoryByEnglishSource(srcHead);
        const scoreTitle = qualityScoreForKo({ source: article.title, gko: translatedTitle });
        const scoreSummary = qualityScoreForKo({ source: summaryToUse, gko: translatedSummary });
        const score = Math.min(scoreTitle, scoreSummary);
        doPE = needPostEdit({ category, score });
      }
      if (doPE) {
        const model = peModel || OPENAI_MODEL;
        translatedTitle = await postEditKoWithLLM({ sourceText: article.title, googleKo: translatedTitle, model });
        translatedSummary = await postEditKoWithLLM({ sourceText: summaryToUse, googleKo: translatedSummary, model });
      }
    }

    article.translatedTitle = translatedTitle;
    article.translatedSummary = translatedSummary;
    return article;
  }));
}

function classifyCategoryByEnglishSource(text = "") {
  for (const [cat, patterns] of Object.entries(LABEL_RULES)) {
    if (patterns.some(re => re.test(text))) return cat;
  }
  return "general";
}

function qualityScoreForKo({ source, gko }) {
  const sourceLen = source.length;
  const gkoLen = gko.length;
  const ratio = Math.min(sourceLen, gkoLen) / Math.max(sourceLen, gkoLen);
  return ratio > 0.8 ? 0.9 : 0.6;
}

function needPostEdit({ category, score, force = false }) {
  if (force) return true;
  const sensitiveCats = ["politics", "economy", "tech"];
  return sensitiveCats.includes(category) || score < 0.7;
}

function cosineSimilarity(vecA, vecB) {
  const dot = math.dot(vecA, vecB);
  const normA = math.norm(vecA);
  const normB = math.norm(vecB);
  return dot / (normA * normB);
}

async function computeUrgencyBuzz(articles) {
  const topics = {};
  articles.forEach(a => {
    const topic = articleSignature(a);
    topics[topic] = (topics[topic] || 0) + 1;
  });
  const xBuzz = await twitterClient.v2.search('breaking news urgent global events', { max_results: 10 });
  return articles.map(a => {
    a.urgency = topics[articleSignature(a)] > 2 ? 1 : 0;
    a.buzz = (xBuzz && xBuzz.data && xBuzz.data.data && xBuzz.data.data.some(p => p.text.includes(a.title))) ? 1 : 0;
    return a;
  });
}

async function fetchArticlesForSection(section, freshness, domainCap, lang) {
  let items = [];
  const minTs = NOW() - freshness * HOUR;
  if (section === "world") {
const rssUrls = [
  "https://feeds.bbci.co.uk/news/rss.xml",
  "https://apnews.com/rss",
  "https://www.ft.com/rss/home",
  "http://rss.asahi.com/rss/asahi/newsheadlines.rdf",
  "http://www3.nhk.or.jp/rss/news/cat0.xml",
  "https://soranews24.com/feed/",
  "https://www.japantimes.co.jp/feed/"
];
    for (const url of rssUrls) {
      try {
        const feed = await rssParser.parseURL(url);
        const feedItems = feed.items.slice(0, 10).map(item => ({
          title: item.title,
          url: item.link,
          publishedAt: item.pubDate,
          summary: item.contentSnippet || item.content,
          source: getDomain(url)
        }));
        items.push(...feedItems);
      } catch (e) {
        console.error(`RSS fetch error for ${url}:`, e);
      }
    }
  } else if (section === "youtube") {
    if (YOUTUBE_API_KEY) {
      try {
        const response = await axios.get('https://www.googleapis.com/youtube/v3/search', {
          params: {
            part: 'snippet',
            q: 'breaking news',
            type: 'video',
            order: 'date',
            maxResults: 10,
            key: YOUTUBE_API_KEY
          }
        });
        items = response.data.items.map(item => ({
          title: item.snippet.title,
          url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
          publishedAt: item.snippet.publishedAt,
          summary: item.snippet.description,
          source: 'youtube.com'
        }));
      } catch (e) {
        console.error('YouTube API error:', e);
      }
    }
  } else {
    try {
      // NewsAPI 호출 전 키 유효성 재확인
      if (!newsApiKey) {
        throw new Error('NewsAPI key is not configured');
      }

      const newsResponse = await newsapi.v2.topHeadlines({
        category: section === 'general' ? undefined : section,
        language: 'en',
        pageSize: 20
      });

      // API 응답 검증
      if (!newsResponse || !newsResponse.articles) {
        throw new Error('Invalid NewsAPI response structure');
      }

      items = newsResponse.articles.map(article => ({
        title: article.title,
        url: article.url,
        publishedAt: article.publishedAt,
        summary: article.description,
        content: article.content,
        source: getDomain(article.url)
      }));

      console.log(`✅ NewsAPI: Retrieved ${items.length} articles for section ${section}`);
      
    } catch (e) {
      console.error(`❌ NewsAPI error for section ${section}:`, e.message);
      
      // 특정 에러 타입에 대한 상세 처리
      if (e.message && e.message.includes('apiKey')) {
        console.error('🔑 API Key issue detected. Please verify NEWS_API_KEY environment variable.');
      } else if (e.message && e.message.includes('rate limit')) {
        console.error('⚠️ Rate limit exceeded. Consider implementing request throttling.');
      } else if (e.message && e.message.includes('network')) {
        console.error('🌐 Network connectivity issue detected.');
      }
      
      // 빈 배열 반환으로 앱 크래시 방지
      items = [];
    }
  }

  items = items.filter(item => {
    const ts = Date.parse(item.publishedAt);
    return Number.isFinite(ts) && ts >= minTs;
  });

  if (domainCap > 0) {
    const domainCount = {};
    items = items.filter(item => {
      const domain = getDomain(item.url);
      domainCount[domain] = (domainCount[domain] || 0) + 1;
      return domainCount[domain] <= domainCap;
    });
  }

  return items;
}

async function safeFetchArticleContent(url) {
  try {
    const response = await axios.get(url, { timeout: 5000 });
    const $ = cheerio.load(response.data);
    $('script, style, nav, footer, aside').remove();
    return $('body').text().trim().slice(0, 2000);
  } catch (e) {
    console.error(`Safe fetch error for ${url}:`, e);
    return null;
  }
}

// 루트 페이지: public/index_gemini_grok_final.html
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index_gemini_grok_final.html'));
});

// 프론트엔드 라우팅: 비-API GET 요청은 전부 index로 포워딩
app.get(/^(?!\/(api|feed|healthz?)\/?).*$/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index_gemini_grok_final.html'));
});

app.get("/feed", cacheControl, async (req, res) => {
  try {
    const section = (req.query.section || "world").toString();
    const freshness = parseInt(req.query.freshness ?? "72", 10);
    const domainCap = parseInt(req.query.domain_cap ?? "5", 10);
    const lang = (req.query.lang || "ko").toString();
    const quality = (req.query.quality || "low").toString();

    const cacheKey = `feed:${section}:${freshness}:${domainCap}:${lang}:${quality}`;
    
    // Redis 캐시 확인 (redisClient가 있을 때만)
    if (redisClient) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const payload = JSON.parse(cached);
        const etag = generateETag(payload);
        res.set("ETag", etag);
        if (req.headers["if-none-match"] === etag) return res.status(304).end();
        return res.json(payload);
      }
    }

    let items = await fetchArticlesForSection(section, freshness, domainCap, lang);
    if (quality === "high") {
      await Promise.all(items.map(async (item) => {
        const content = await safeFetchArticleContent(item.url);
        if (content) item.content = content;
      }));
    }
    items = await processArticles(items, lang, { aiSummary: quality === "high", postEdit: true });

    let clusters = await clusterArticles(items, lang, quality);
    clusters = clusters.sort((a,b) => b.rating - a.rating);
    const top20 = clusters.slice(0, 20);
    shuffleArray(top20);
    clusters.splice(0, 20, ...top20);

    const payload = {
      section, freshness, domain_cap: domainCap, lang,
      count: items.length,
      clusters,
      generatedAt: new Date().toISOString()
    };

    // Redis 캐시 저장 (redisClient가 있을 때만)
    if (redisClient) {
      await redisClient.setEx(cacheKey, 180, JSON.stringify(payload));
    }

    const etag = generateETag(payload);
    res.set("ETag", etag);
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: "FEED_GENERATION_FAILED", detail: String(e?.message || e) });
  }
});

app.get("/translate_page", async (req, res) => {
  const url = req.query.url;
  try {
    const content = await safeFetchArticleContent(url) || ''; // safe or fallback
    const translated = await translateText(content, 'ko');
    res.send(`<html><body><pre>${translated}</pre></body></html>`); // simple
  } catch (e) {
    res.status(500).send('Translation failed');
  }
});

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function generateETag(data) { return crypto.createHash("md5").update(JSON.stringify(data)).digest("hex"); }

function cacheControl(_req, res, next) { res.set("Cache-Control","public, max-age=60, stale-while-revalidate=300"); next(); }

app.get("/healthz", (_req, res) => {
  res.json({
    status:"ok",
    env:NODE_ENV,
    uptime:process.uptime(),
    time:new Date().toISOString(),
    cache:{ policy:"public, max-age=60, stale-while-revalidate=300", etagEnabled:true },
    version:"1.0.0"
  });
});

// 에러 핸들링 미들웨어
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ ok: false, error: 'internal_error' });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => console.log(`[UPGRADED HYBRID FINAL] backend started on :${PORT}`));
}

module.exports = {
  app,
  clusterArticles,
  extractKeywordsWithTFIDF,
  articleSignature,
  freshnessWeight,
  sourceWeight
};

