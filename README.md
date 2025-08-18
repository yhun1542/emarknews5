# EmarkNews Backend

Upgraded hybrid backend for EmarkNews, integrating news APIs, translation, clustering, and more.

## Setup

1. Install dependencies: `npm install`
2. Set environment variables in `.env` (use `.env.example` as template).
3. Run: `npm start`

## Environment Variables

- NEWS_API_KEYS
- TWITTER_BEARER_TOKEN
- OPENAI_API_KEY
- GOOGLE_PROJECT_ID
- TRANSLATE_API_KEY
- REDIS_URL
- NAVER_CLIENT_ID
- NAVER_CLIENT_SECRET
- YOUTUBE_API_KEY

## Deployment

- GitHub: Push to repo.
- Railway: Connect GitHub repo, set env vars, deploy as Node.js app.

Frontend: index_gemini_grok_final.html (static, can be served separately or integrated).

## Endpoints

- /feed: Get news feed.
- /translate_page: Translate page content.
- /healthz: Health check.# GitHub Actions Test - Sun Aug 17 21:55:02 EDT 2025
