const { chromium } = require('playwright');
const fs = require('fs');

const EZ_DOMAIN = process.env['EZ_DOMAIN'];
const EZ_USER = process.env['EZ_USER'];
const EZ_PW = process.env['EZ_PW'];

// ★ DataImpulse 한국 Residential Proxy
const PROXY_HOST = process.env['PROXY_HOST'];
const PROXY_PORT = process.env['PROXY_PORT'];
const PROXY_USER = process.env['PROXY_USER'];
const PROXY_PASS = process.env['PROXY_PASS'];

let globalBrowser = null;
let globalPage = null;

function getProxyConfig() {
    if (PROXY_HOST && PROXY_PORT && PROXY_USER && PROXY_PASS) {
        console.log(`📍 [PROXY] 한국 Residential Proxy 사용: ${PROXY_HOST}:${PROXY_PORT}`);
        return {
            server: `http://${PROXY_HOST}:${PROXY_PORT}`,
            username: PROXY_USER,
            password: PROXY_PASS
        };
    }
    console.log('📍 [PROXY] 프록시 설정 없음 — 직접 연결');
    return undefined;
}

async function execute(action, req, res) {
    try {
        if (action === 'login') {
            console.log('\n📍 [EZADMIN LOGIN] STEP 1: 브라우저 실행 및 세션 체크...');
            if (globalBrowser) {
                try { await globalBrowser.close(); } catch (e) { /* ignore */ }
            }

            // ★ 한국 프록시로 Chromium 실행
            const proxyConfig = getProxyConfig();
            const launchOptions = { 
                args: ['--no-sandbox', '--disable-setuid-sandbox'] 
            };
            if (proxyConfig) {
                launchOptions.proxy = proxyConfig;
            }
            globalBrowser = await chromium.launch(launchOptions);
            
            let contextOptions = { viewport: { width: 1400, height: 900 } };
            
            if (fs.existsSync('auth_ezadmin.json')) {
                console.log('📍 [EZADMIN LOGIN] 저장된 세션 파일(auth_ezadmin.json)을 장착합니다.');
                contextOptions.storageState = 'auth_ezadmin.json';
            }

            const context = await globalBrowser.newContext(contextOptions);
            globalPage = await context.newPage();

            console.log('📍 [EZADMIN LOGIN] STEP 2: 메인 페이지 접속...');
            await globalPage.goto('https://ezadmin.co.kr/index.html', { timeout: 60000 });
            
            await globalPage.waitForTimeout(2000);
            
            await globalPage.click('li.login a');
            await globalPage.waitForTimeout(2000);
            
            const isLoginPopupVisible = await globalPage.isVisible('#login-domain');
            
            if (!isLoginPopupVisible) {
                console.log('📍 [EZADMIN LOGIN] ✅ 이미 로그인되어 있습니다! 프리패스.');
                return res.json({ status: 'SUCCESS', message: '자동 로그인 성공' });
            }

            console.log(`📍 [EZADMIN LOGIN] STEP 3: 정보 입력 (도메인: ${EZ_DOMAIN}, ID: ${EZ_USER})...`);
            await globalPage.fill('#login-domain', EZ_DOMAIN);
            await globalPage.fill('#login-id', EZ_USER);
            await globalPage.fill('#login-pwd', EZ_PW);

            console.log('📍 [EZADMIN LOGIN] STEP 4: 로그인 버튼 클릭...');
            await globalPage.click('.login-btn');

            console.log('📍 [EZADMIN LOGIN] STEP 5: 보안코드 발생 여부 모니터링 중...');
            try {
                const captchaInput = await globalPage.waitForSelector('input[id^="inputAuthCode"]', { timeout: 4000 });
                if (captchaInput) {
                    console.log('📍 [EZADMIN LOGIN] ✨ 보안코드 감지됨! 스크린샷 캡처 중...');
                    const captchaWrap = await globalPage.$('div[id^="auth_img_wrap"]');
                    const captchaBuffer = await captchaWrap.screenshot();

                    return res.json({
                        status: 'AUTH_REQUIRED',
                        message: '보안코드가 필요합니다.',
                        screenshot: 'data:image/png;base64,' + captchaBuffer.toString('base64')
                    });
                }
            } catch (e) {
                console.log('📍 [EZADMIN LOGIN] ✅ 보안코드 없음 — 로그인 후 리다이렉트 대기 중...');
                
                await globalPage.waitForTimeout(5000);
                
                const currentUrl = globalPage.url();
                console.log(`📍 [EZADMIN LOGIN] 현재 URL: ${currentUrl}`);
                
                console.log('📍 [EZADMIN LOGIN] STEP 6: ga67 재고 페이지 접속하여 세션 검증...');
                await globalPage.goto('https://ga67.ezadmin.co.kr/template35.htm?template=I100', { 
                    waitUntil: 'domcontentloaded',
                    timeout: 60000 
                });
                await globalPage.waitForTimeout(3000);
                
                const pageContent = await globalPage.content();
                const pageUrl = globalPage.url();
                console.log(`📍 [EZADMIN LOGIN] 검증 페이지 URL: ${pageUrl}`);
                
                if (pageContent.includes('mysqli') || pageContent.includes('데이터베이스에 연결할 수 없습니다')) {
                    console.log('📍 [EZADMIN LOGIN] ⚠️ Ezadmin DB 연결 에러 감지!');
                    const buffer = await globalPage.screenshot();
                    return res.status(503).json({ 
                        status: 'ERROR', 
                        message: 'Ezadmin 서버 DB 연결 에러 (일시적 장애)',
                        screenshot: 'data:image/png;base64,' + buffer.toString('base64')
                    });
                }
                
                const hasSearchBtn = await globalPage.isVisible('#search');
                if (hasSearchBtn) {
                    console.log('📍 [EZADMIN LOGIN] ✅ 재고 페이지 정상 로드 확인! 세션 저장.');
                    await globalPage.context().storageState({ path: 'auth_ezadmin.json' });
                    return res.json({ status: 'SUCCESS', message: '로그인 완료 및 세션 저장 (재고 페이지 검증 완료)' });
                } else {
                    console.log('📍 [EZADMIN LOGIN] ⏳ #search 버튼 미발견, 추가 대기...');
                    try {
                        await globalPage.waitForSelector('#search', { timeout: 15000 });
                        console.log('📍 [EZADMIN LOGIN] ✅ #search 버튼 발견! 세션 저장.');
                        await globalPage.context().storageState({ path: 'auth_ezadmin.json' });
                        return res.json({ status: 'SUCCESS', message: '로그인 완료 및 세션 저장' });
                    } catch (waitErr) {
                        console.log('📍 [EZADMIN LOGIN] ❌ #search 버튼을 찾을 수 없음.');
                        const buffer = await globalPage.screenshot();
                        return res.status(500).json({ 
                            status: 'ERROR', 
                            message: '로그인은 됐지만 재고 페이지 로드 실패',
                            currentUrl: pageUrl,
                            screenshot: 'data:image/png;base64,' + buffer.toString('base64')
                        });
                    }
                }
            }
        }

        if (action === 'verify_captcha') {
            const { captchaCode } = req.body;
            console.log(`\n📍 [EZADMIN VERIFY] STEP 1: 입력받은 보안코드 [${captchaCode}] 대입...`);
            if (!captchaCode) return res.status(400).json({ status: 'ERROR', message: 'captchaCode가 없습니다.' });

            await globalPage.fill('input[id^="inputAuthCode"]', captchaCode);
            console.log('📍 [EZADMIN VERIFY] STEP 2: 입력 완료 버튼 클릭...');
            await globalPage.click('button[id^="authcode_button"]');
            await globalPage.waitForTimeout(5000);

            console.log('📍 [EZADMIN VERIFY] STEP 3: 보안코드 인증 완료. 세션 저장 중...');
            await globalPage.context().storageState({ path: 'auth_ezadmin.json' });
            return res.json({ status: 'SUCCESS', message: '보안코드 인증 성공 및 세션 저장 완료' });
        }

        if (action === 'scrape') {
            if (!globalPage) return res.status(400).json({ status: 'ERROR', message: '브라우저 세션이 없습니다. 로그인을 먼저 하세요.' });

            console.log('\n📍 [EZADMIN SCRAPE] STEP 1: 재고 현황 페이지 이동...');
            const targetUrl = `https://ga67.ezadmin.co.kr/template35.htm?template=I100`;
            await globalPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await globalPage.waitForTimeout(3000);

            const currentUrl = globalPage.url();
            const bodyText = await globalPage.textContent('body');
            console.log(`📍 [EZADMIN SCRAPE] 현재 URL: ${currentUrl}`);
            console.log(`📍 [EZADMIN SCRAPE] 페이지 텍스트 앞 200자: ${(bodyText || '').substring(0, 200)}`);

            if (bodyText && (bodyText.includes('mysqli') || bodyText.includes('데이터베이스에 연결할 수 없습니다'))) {
                console.log('📍 [EZADMIN SCRAPE] ⚠️ Ezadmin DB 에러 감지!');
                const buffer = await globalPage.screenshot();
                return res.status(503).json({
                    status: 'ERROR',
                    message: 'Ezadmin 서버 DB 연결 에러 — 재시도 필요',
                    screenshot: 'data:image/png;base64,' + buffer.toString('base64')
                });
            }

            if (currentUrl.includes('ezadmin.co.kr/index') || (bodyText && bodyText.includes('login-domain'))) {
                console.log('📍 [EZADMIN SCRAPE] ⚠️ 세션 만료! 로그인 페이지로 리다이렉트됨.');
                const buffer = await globalPage.screenshot();
                return res.status(401).json({
                    status: 'ERROR',
                    message: '세션 만료 — 로그인을 다시 하세요',
                    screenshot: 'data:image/png;base64,' + buffer.toString('base64')
                });
            }

            console.log('📍 [EZADMIN SCRAPE] STEP 2: 검색 버튼(#search) 대기 중...');
            try {
                await globalPage.waitForSelector('#search', { timeout: 30000 });
            } catch (selectorErr) {
                console.log('📍 [EZADMIN SCRAPE] ❌ #search 버튼을 30초 내 찾지 못함.');
                const buffer = await globalPage.screenshot();
                return res.status(500).json({
                    status: 'ERROR',
                    message: '#search 버튼 미발견 (30초 타임아웃)',
                    currentUrl: currentUrl,
                    bodyPreview: (bodyText || '').substring(0, 500),
                    screenshot: 'data:image/png;base64,' + buffer.toString('base64')
                });
            }

            console.log('📍 [EZADMIN SCRAPE] STEP 2.5: 검색 버튼 클릭...');
            await globalPage.click('#search');
            await globalPage.waitForTimeout(7000);

            console.log('📍 [EZADMIN SCRAPE] STEP 3: jqxGrid 테이블 데이터 파싱 시작...');
            const stockData = await globalPage.evaluate(() => {
                const rows = document.querySelectorAll('#grid1 tbody tr[role="row"]');
                const results = [];

                rows.forEach(row => {
                    const cells = row.querySelectorAll('td[role="gridcell"]');
                    if (cells.length > 0) {
                        const rowData = {};
                        cells.forEach(cell => {
                            const colId = cell.getAttribute('aria-describedby');
                            if (colId) {
                                rowData[colId] = (cell.textContent || '').trim();
                            }
                        });
                        if (Object.keys(rowData).length > 0) {
                            results.push(rowData);
                        }
                    }
                });
                return results;
            });

            console.log(`📍 [EZADMIN SCRAPE] STEP 4: 총 ${stockData.length}건의 재고 추출 완료.`);
            return res.json({ status: 'SUCCESS', count: stockData.length, data: stockData });
        }

        return res.status(400).json({ status: 'ERROR', message: '정의되지 않은 액션입니다.' });

    } catch (error) {
        console.error('📍 [EZADMIN 핸들러 에러]', error);
        
        let screenshot = null;
        try {
            if (globalPage) {
                const buffer = await globalPage.screenshot();
                screenshot = 'data:image/png;base64,' + buffer.toString('base64');
            }
        } catch (ssErr) {
            console.error('📍 [ezadmin 전역 에러] 스크린샷 실패:', ssErr.message);
        }

        res.status(500).json({ status: 'ERROR', message: error.message, screenshot });
    }
}

module.exports = { execute };
