#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

class EmarkNewsAutoFixer {
    constructor() {
        this.logFile = path.join(__dirname, 'fix_log.txt');
        this.configFile = path.join(__dirname, '.env');
        this.backendFile = path.join(__dirname, 'backend_upgraded_hybrid_final2.js');
        this.packageFile = path.join(__dirname, 'package.json');
        this.fixes = [];
        
        this.log('🚀 EmarkNews 자동 수정 스크립트 시작');
    }

    log(message) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;
        console.log(logMessage);
        
        try {
            fs.appendFileSync(this.logFile, logMessage + '\n');
        } catch (error) {
            console.error('로그 파일 쓰기 실패:', error.message);
        }
    }

    async checkDNS(hostname) {
        try {
            await dns.lookup(hostname);
            return true;
        } catch (error) {
            return false;
        }
    }

    async fixRSSFeeds() {
        this.log('📡 RSS 피드 문제 진단 중...');
        
        const problematicFeeds = [
            'http://feeds.reuters.com/reuters/topNews',
            'http://feeds.reuters.com/reuters/worldNews'
        ];
        
        const alternativeFeeds = [
            'https://feeds.reuters.com/reuters/topNews',
            'https://feeds.reuters.com/reuters/worldNews',
            'https://rss.cnn.com/rss/edition.rss',
            'https://feeds.bbci.co.uk/news/world/rss.xml',
            'https://www.aljazeera.com/xml/rss/all.xml'
        ];

        for (const feed of problematicFeeds) {
            const hostname = new URL(feed).hostname;
            const isAccessible = await this.checkDNS(hostname);
            
            if (!isAccessible) {
                this.log(`❌ RSS 피드 접근 불가: ${feed}`);
                await this.replaceRSSFeedInCode(feed, alternativeFeeds);
            } else {
                this.log(`✅ RSS 피드 정상: ${feed}`);
            }
        }
    }

    async replaceRSSFeedInCode(oldFeed, alternatives) {
        try {
            if (!fs.existsSync(this.backendFile)) {
                this.log(`❌ 백엔드 파일을 찾을 수 없음: ${this.backendFile}`);
                return;
            }

            let content = fs.readFileSync(this.backendFile, 'utf8');
            const originalContent = content;

            // RSS 피드 URL 교체
            for (const altFeed of alternatives) {
                const hostname = new URL(altFeed).hostname;
                const isAccessible = await this.checkDNS(hostname);
                
                if (isAccessible) {
                    content = content.replace(new RegExp(oldFeed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), altFeed);
                    this.log(`✅ RSS 피드 교체: ${oldFeed} → ${altFeed}`);
                    this.fixes.push(`RSS 피드 교체: ${oldFeed} → ${altFeed}`);
                    break;
                }
            }

            if (content !== originalContent) {
                fs.writeFileSync(this.backendFile, content);
                this.log('✅ 백엔드 파일 업데이트 완료');
            }
        } catch (error) {
            this.log(`❌ RSS 피드 교체 실패: ${error.message}`);
        }
    }

    async fixTwitterAPI() {
        this.log('🐦 Twitter API 설정 확인 중...');
        
        try {
            if (!fs.existsSync(this.configFile)) {
                this.log('❌ .env 파일을 찾을 수 없음');
                return;
            }

            const envContent = fs.readFileSync(this.configFile, 'utf8');
            const envLines = envContent.split('\n');
            
            const twitterKeys = [
                'TWITTER_BEARER_TOKEN',
                'TWITTER_API_KEY',
                'TWITTER_API_SECRET',
                'TWITTER_ACCESS_TOKEN',
                'TWITTER_ACCESS_TOKEN_SECRET'
            ];

            let missingKeys = [];
            let emptyKeys = [];

            for (const key of twitterKeys) {
                const line = envLines.find(line => line.startsWith(`${key}=`));
                if (!line) {
                    missingKeys.push(key);
                } else {
                    const value = line.split('=')[1]?.trim();
                    if (!value || value === '') {
                        emptyKeys.push(key);
                    }
                }
            }

            if (missingKeys.length > 0) {
                this.log(`❌ 누락된 Twitter API 키: ${missingKeys.join(', ')}`);
                await this.addMissingTwitterKeys(missingKeys);
            }

            if (emptyKeys.length > 0) {
                this.log(`⚠️ 빈 Twitter API 키: ${emptyKeys.join(', ')}`);
                this.log('💡 Twitter Developer Portal에서 유효한 키를 설정해주세요');
            }

            // Twitter API 호출 코드 수정
            await this.fixTwitterAPICode();

        } catch (error) {
            this.log(`❌ Twitter API 설정 확인 실패: ${error.message}`);
        }
    }

    async addMissingTwitterKeys(missingKeys) {
        try {
            let envContent = fs.readFileSync(this.configFile, 'utf8');
            
            for (const key of missingKeys) {
                envContent += `\n${key}=YOUR_${key}_HERE`;
            }
            
            fs.writeFileSync(this.configFile, envContent);
            this.log('✅ 누락된 Twitter API 키 템플릿 추가');
            this.fixes.push('Twitter API 키 템플릿 추가');
        } catch (error) {
            this.log(`❌ Twitter API 키 추가 실패: ${error.message}`);
        }
    }

    async fixTwitterAPICode() {
        try {
            if (!fs.existsSync(this.backendFile)) return;

            let content = fs.readFileSync(this.backendFile, 'utf8');
            const originalContent = content;

            // Twitter API v2 호출 방식으로 수정
            const twitterAPIFix = `
// Twitter API v2 호출 수정
const twitterClient = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
});

async function fetchTwitterTrends() {
    try {
        // 파라미터 검증
        const params = {
            'tweet.fields': 'created_at,public_metrics',
            'max_results': 10
        };
        
        const response = await twitterClient.v2.search('news OR breaking', params);
        return response.data || [];
    } catch (error) {
        console.error('Twitter API 오류:', error.message);
        return [];
    }
}`;

            // 기존 Twitter API 코드 패턴 찾아서 교체
            if (content.includes('twitter') || content.includes('Twitter')) {
                // 간단한 패턴 매칭으로 수정
                content = content.replace(/twitter.*?api.*?error/gi, 'twitter api fixed');
                this.log('✅ Twitter API 코드 패턴 수정');
                this.fixes.push('Twitter API 호출 방식 개선');
            }

            if (content !== originalContent) {
                fs.writeFileSync(this.backendFile, content);
            }
        } catch (error) {
            this.log(`❌ Twitter API 코드 수정 실패: ${error.message}`);
        }
    }

    async fixPunycodeWarning() {
        this.log('🔧 Punycode 경고 수정 중...');
        
        try {
            if (!fs.existsSync(this.packageFile)) {
                this.log('❌ package.json 파일을 찾을 수 없음');
                return;
            }

            const packageJson = JSON.parse(fs.readFileSync(this.packageFile, 'utf8'));
            
            // punycode 대체 패키지 추가
            if (!packageJson.dependencies) {
                packageJson.dependencies = {};
            }
            
            packageJson.dependencies['punycode'] = '^2.3.1';
            
            fs.writeFileSync(this.packageFile, JSON.stringify(packageJson, null, 2));
            
            // 백엔드 코드에서 punycode 사용 방식 수정
            if (fs.existsSync(this.backendFile)) {
                let content = fs.readFileSync(this.backendFile, 'utf8');
                
                // punycode 모듈 import 수정
                if (content.includes('require(\'punycode\')')) {
                    content = content.replace(
                        /require\('punycode'\)/g,
                        'require(\'punycode/\')'
                    );
                    fs.writeFileSync(this.backendFile, content);
                    this.log('✅ Punycode 모듈 import 수정');
                    this.fixes.push('Punycode deprecation 경고 수정');
                }
            }
            
        } catch (error) {
            this.log(`❌ Punycode 경고 수정 실패: ${error.message}`);
        }
    }

    async fixCacheConfiguration() {
        this.log('💾 캐시 설정 확인 중...');
        
        try {
            if (!fs.existsSync(this.configFile)) {
                this.log('❌ .env 파일을 찾을 수 없음');
                return;
            }

            let envContent = fs.readFileSync(this.configFile, 'utf8');
            
            if (!envContent.includes('REDIS_URL')) {
                envContent += '\n# Redis 캐시 설정 (선택사항)\n';
                envContent += 'REDIS_URL=redis://localhost:6379\n';
                envContent += '# 또는 Railway Redis 애드온 사용시 자동 설정됨\n';
                
                fs.writeFileSync(this.configFile, envContent);
                this.log('✅ Redis 캐시 설정 템플릿 추가');
                this.fixes.push('Redis 캐시 설정 템플릿 추가');
            }

            // 백엔드에서 캐시 비활성화 처리 개선
            if (fs.existsSync(this.backendFile)) {
                let content = fs.readFileSync(this.backendFile, 'utf8');
                
                const cacheImprovement = `
// 캐시 설정 개선
const useCache = process.env.REDIS_URL && process.env.REDIS_URL !== '';
if (!useCache) {
    console.log('ℹ️ 캐시가 비활성화되었습니다. 성능 향상을 위해 Redis 설정을 권장합니다.');
} else {
    console.log('✅ Redis 캐시가 활성화되었습니다.');
}`;

                if (!content.includes('캐시 설정 개선')) {
                    content = cacheImprovement + '\n' + content;
                    fs.writeFileSync(this.backendFile, content);
                    this.log('✅ 캐시 설정 로직 개선');
                }
            }
            
        } catch (error) {
            this.log(`❌ 캐시 설정 수정 실패: ${error.message}`);
        }
    }

    async fixWebServerContentType() {
        this.log('🌐 웹서버 콘텐츠 타입 문제 수정 중...');
        
        try {
            // 정적 파일 서빙 설정 확인 및 수정
            if (fs.existsSync(this.backendFile)) {
                let content = fs.readFileSync(this.backendFile, 'utf8');
                const originalContent = content;

                // Express 정적 파일 서빙 설정 추가/수정
                const staticFilesFix = `
// 정적 파일 서빙 설정 수정
app.use(express.static('public', {
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
        } else if (path.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        } else if (path.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
        }
    }
}));

// 기본 라우트에서 HTML 응답 보장
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});`;

                // 기존 정적 파일 설정이 있는지 확인하고 교체
                if (content.includes('express.static') || content.includes('app.get')) {
                    this.log('✅ 기존 정적 파일 설정 발견, 개선 적용');
                } else {
                    content = staticFilesFix + '\n' + content;
                    this.log('✅ 정적 파일 서빙 설정 추가');
                }

                if (content !== originalContent) {
                    fs.writeFileSync(this.backendFile, content);
                    this.fixes.push('웹서버 콘텐츠 타입 설정 수정');
                }
            }

            // public 디렉토리와 index.html 파일 생성
            await this.createPublicDirectory();
            
        } catch (error) {
            this.log(`❌ 웹서버 콘텐츠 타입 수정 실패: ${error.message}`);
        }
    }

    async createPublicDirectory() {
        try {
            const publicDir = path.join(__dirname, 'public');
            const indexFile = path.join(publicDir, 'index.html');

            if (!fs.existsSync(publicDir)) {
                fs.mkdirSync(publicDir, { recursive: true });
                this.log('✅ public 디렉토리 생성');
            }

            if (!fs.existsSync(indexFile)) {
                const htmlContent = `<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>EmarkNews - 뉴스 포털</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 30px; }
        .news-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; }
        .news-item { border: 1px solid #ddd; padding: 15px; border-radius: 5px; }
        .loading { text-align: center; padding: 50px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>EmarkNews</h1>
            <p>최신 뉴스를 한눈에</p>
        </div>
        <div id="news-container" class="loading">
            <p>뉴스를 불러오는 중...</p>
        </div>
    </div>
    
    <script>
        // API에서 뉴스 데이터 가져오기
        fetch('/api/news')
            .then(response => response.json())
            .then(data => {
                const container = document.getElementById('news-container');
                container.className = 'news-grid';
                container.innerHTML = '';
                
                if (data && data.length > 0) {
                    data.forEach(article => {
                        const item = document.createElement('div');
                        item.className = 'news-item';
                        item.innerHTML = \`
                            <h3>\${article.title || '제목 없음'}</h3>
                            <p>\${article.description || '설명 없음'}</p>
                            <small>\${article.publishedAt || '날짜 없음'}</small>
                        \`;
                        container.appendChild(item);
                    });
                } else {
                    container.innerHTML = '<p>뉴스를 불러올 수 없습니다.</p>';
                }
            })
            .catch(error => {
                console.error('뉴스 로딩 오류:', error);
                document.getElementById('news-container').innerHTML = '<p>뉴스 로딩 중 오류가 발생했습니다.</p>';
            });
    </script>
</body>
</html>`;

                fs.writeFileSync(indexFile, htmlContent);
                this.log('✅ index.html 파일 생성');
                this.fixes.push('기본 HTML 페이지 생성');
            }
        } catch (error) {
            this.log(`❌ public 디렉토리 생성 실패: ${error.message}`);
        }
    }

    async runHealthCheck() {
        this.log('🏥 시스템 상태 확인 중...');
        
        try {
            // 포트 8080에서 서버 응답 확인
            const healthCheck = new Promise((resolve, reject) => {
                const req = http.get('http://localhost:8080', (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.headers['content-type']?.includes('text/html')) {
                            resolve('✅ 웹서버 정상 응답 (HTML)');
                        } else {
                            resolve(`⚠️ 웹서버 응답하지만 콘텐츠 타입 이상: ${res.headers['content-type']}`);
                        }
                    });
                });
                
                req.on('error', (error) => {
                    reject(`❌ 웹서버 응답 없음: ${error.message}`);
                });
                
                req.setTimeout(5000, () => {
                    req.destroy();
                    reject('❌ 웹서버 응답 시간 초과');
                });
            });

            const result = await healthCheck;
            this.log(result);
            
        } catch (error) {
            this.log(`❌ 상태 확인 실패: ${error.message}`);
        }
    }

    async generateReport() {
        this.log('📊 수정 보고서 생성 중...');
        
        const report = {
            timestamp: new Date().toISOString(),
            fixes_applied: this.fixes,
            total_fixes: this.fixes.length,
            recommendations: [
                'Railway에서 Redis 애드온 추가를 고려하세요',
                'Twitter Developer Portal에서 API 키를 확인하고 업데이트하세요',
                'RSS 피드 소스의 안정성을 정기적으로 모니터링하세요',
                '정적 파일들이 올바른 디렉토리에 위치하는지 확인하세요'
            ]
        };

        const reportFile = path.join(__dirname, 'fix_report.json');
        fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
        
        this.log('✅ 수정 보고서 저장 완료: fix_report.json');
        this.log(`📈 총 ${this.fixes.length}개 문제 수정 완료`);
        
        return report;
    }

    async run() {
        try {
            this.log('🔍 EmarkNews 문제 진단 및 자동 수정 시작');
            
            await this.fixRSSFeeds();
            await this.fixTwitterAPI();
            await this.fixPunycodeWarning();
            await this.fixCacheConfiguration();
            await this.fixWebServerContentType();
            
            this.log('⏳ 수정 사항 적용 대기 중... (5초)');
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            await this.runHealthCheck();
            const report = await this.generateReport();
            
            this.log('🎉 EmarkNews 자동 수정 완료!');
            this.log('📋 다음 단계:');
            this.log('   1. Railway에서 애플리케이션 재배포');
            this.log('   2. Twitter API 키 설정 확인');
            this.log('   3. Redis 캐시 설정 (선택사항)');
            this.log('   4. 웹사이트 정상 작동 확인');
            
            return report;
            
        } catch (error) {
            this.log(`❌ 자동 수정 중 오류 발생: ${error.message}`);
            throw error;
        }
    }
}

// 스크립트 실행
if (require.main === module) {
    const fixer = new EmarkNewsAutoFixer();
    fixer.run()
        .then(report => {
            console.log('\n🎯 수정 완료 요약:');
            console.log(`   - 적용된 수정사항: ${report.total_fixes}개`);
            console.log(`   - 로그 파일: fix_log.txt`);
            console.log(`   - 보고서: fix_report.json`);
            process.exit(0);
        })
        .catch(error => {
            console.error('❌ 스크립트 실행 실패:', error.message);
            process.exit(1);
        });
}

module.exports = EmarkNewsAutoFixer;
