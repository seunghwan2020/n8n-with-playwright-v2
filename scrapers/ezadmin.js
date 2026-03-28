const { chromium } = require('playwright');
const fs = require('fs');

const EZ_DOMAIN = process.env['EZ_DOMAIN'];
const EZ_USER = process.env['EZ_USER'];
const EZ_PW = process.env['EZ_PW'];

let globalBrowser = null;
let globalPage = null;
let isProcessing = false; // ★ 동시 요청 방지 락

async function execute(action, req, res) {
    // ★ 동시 요청 방지 — 이전 요청이 처리 중이면 대기
    if (isProcessing) {
        console.log('📍 [EZADMIN] ⚠️ 이전 요청 처리 중 — 10초 대기 후 재시도');
        await new Promise(r => setTimeout(r, 10000));
        if (isProcessing) {
            return res.status(429).json({ status: 'ERROR', message: '이전 요청이 아직 처리 중입니다. 잠시 후 재시도하세요.' });
        }
    }
    isProcessing = true;

    try {
        // ========================================
        // ACTION: login
        // ★ 가볍게 로그인만 수행. ga67 검증은 하지 않음.
        // ========================================
        if (action === 'login') {
            console.log('\n📍 [EZADMIN LOGIN] STEP 1: 브라우저 실행...');
            if (globalBrowser) {
                try { await globalBrowser.close(); } catch (e) { /* ignore */ }
                globalBrowser = null;
                globalPage = null;
            }

            globalBrowser = await chromium.launch({ 
                args: ['--no-sandbox', '--disable-setuid-sandbox'] 
            });
            
            const context = await globalBrowser.newContext({ viewport: { width: 1400, height: 900 } });
            globalPage = await context.newPage();

            // ★ STEP 2: 메인 페이지 접속
            console.log('📍 [EZADMIN LOGIN] STEP 2: 메인 페이지 접속...');
            await globalPage.goto('https://ezadmin.co.kr/index.html', { timeout: 60000 });
            await globalPage.waitForTimeout(2000);
            
            // ★ STEP 3: 로그인 팝업 열기
            console.log('📍 [EZADMIN LOGIN] STEP 3: 로그인 팝업 열기...');
            await globalPage.click('li.login a');
            await globalPage.waitForTimeout(2000);
            
            // 로그인 팝업이 안 떴으면 이미 로그인된 상태
            const isLoginPopupVisible = await globalPage.isVisible('#login-domain');
            if (!isLoginPopupVisible) {
                console.log('📍 [EZADMIN LOGIN] ✅ 이미 로그인됨!');
                let loginScreenshot = null;
                try { loginScreenshot = 'data:image/png;base64,' + (await globalPage.screenshot()).toString('base64'); } catch(e) {}
                isProcessing = false;
                return res.json({ status: 'SUCCESS', message: '자동 로그인 성공', screenshot: loginScreenshot });
            }

            // ★ STEP 4: 정보 입력
            console.log(`📍 [EZADMIN LOGIN] STEP 4: 정보 입력 (도메인: ${EZ_DOMAIN}, ID: ${EZ_USER})...`);
            await globalPage.fill('#login-domain', EZ_DOMAIN);
            await globalPage.fill('#login-id', EZ_USER);
            await globalPage.fill('#login-pwd', EZ_PW);

            // ★ STEP 5: 로그인 버튼 클릭 (evaluate로 직접 JS 호출)
            console.log('📍 [EZADMIN LOGIN] STEP 5: 로그인 버튼 클릭...');
            await globalPage.evaluate(() => {
                const btn = document.querySelector('.login-btn');
                if (btn) btn.click();
            });
            console.log('📍 [EZADMIN LOGIN] STEP 5.5: 로그인 처리 대기 (5초)...');
            await globalPage.waitForTimeout(5000);

            // ★ STEP 6: 로그인 결과 확인
            const afterLoginUrl = globalPage.url();
            console.log(`📍 [EZADMIN LOGIN] STEP 6: 현재 URL: ${afterLoginUrl}`);

            // 6-1: 보안코드 확인
            const hasCaptcha = await globalPage.isVisible('input[id^="inputAuthCode"]');
            if (hasCaptcha) {
                console.log('📍 [EZADMIN LOGIN] ✨ 보안코드 감지됨!');
                const captchaWrap = await globalPage.$('div[id^="auth_img_wrap"]');
                let captchaScreenshot = null;
                try { captchaScreenshot = 'data:image/png;base64,' + (await captchaWrap.screenshot()).toString('base64'); } catch(e) {}
                isProcessing = false;
                return res.json({
                    status: 'AUTH_REQUIRED',
                    message: '보안코드가 필요합니다.',
                    screenshot: captchaScreenshot
                });
            }

            // 6-2: 로그인 팝업이 아직 열려있는지 확인 (= 로그인 실패)
            const stillLoginPopup = await globalPage.isVisible('#login-domain');
            if (stillLoginPopup) {
                console.log('📍 [EZADMIN LOGIN] ❌ 로그인 팝업이 아직 열려있음 — 로그인 실패!');
                // 에러 메시지 추출 시도
                let errMsg = '';
                try { errMsg = await globalPage.textContent('.login-error, .error-msg, #login-popup .error') || ''; } catch(e) {}
                let screenshot = null;
                try { screenshot = 'data:image/png;base64,' + (await globalPage.screenshot()).toString('base64'); } catch(e) {}
                isProcessing = false;
                return res.status(401).json({
                    status: 'ERROR',
                    message: '로그인 실패 — 팝업이 닫히지 않음. ' + errMsg,
                    currentUrl: afterLoginUrl,
                    screenshot: screenshot
                });
            }

            // 6-3: 페이지 내용으로 로그인 여부 확인
            const pageText = await globalPage.textContent('body') || '';
            const isLoggedIn = pageText.includes('로그아웃') 
                || pageText.includes('seedgrow') 
                || pageText.includes('디커빈')
                || pageText.includes('메인서비스')          // ★ 대시보드 메뉴
                || pageText.includes('기본정보관리')         // ★ 대시보드 메뉴
                || afterLoginUrl.includes('login_process')  // ★ 로그인 처리 URL
                || afterLoginUrl.includes('ga67.ezadmin');   // ★ ga67로 리다이렉트됨
            
            let loginScreenshot = null;
            try { loginScreenshot = 'data:image/png;base64,' + (await globalPage.screenshot()).toString('base64'); } catch(e) {}

            if (isLoggedIn) {
                console.log('📍 [EZADMIN LOGIN] ✅ 로그인 성공 확인!');
                isProcessing = false;
                return res.json({ status: 'SUCCESS', message: '로그인 완료', currentUrl: afterLoginUrl, screenshot: loginScreenshot });
            }

            // 6-4: 어디에도 해당 안 됨
            console.log(`📍 [EZADMIN LOGIN] ⚠️ 로그인 상태 불명확. URL: ${afterLoginUrl}`);
            console.log(`📍 [EZADMIN LOGIN] 페이지 텍스트 앞 300자: ${pageText.substring(0, 300)}`);
            isProcessing = false;
            return res.json({ 
                status: 'UNKNOWN', 
                message: '로그인 상태 불명확 — 스크린샷 확인 필요', 
                currentUrl: afterLoginUrl, 
                screenshot: loginScreenshot 
            });
        }

        // ========================================
        // ACTION: verify_captcha
        // ========================================
        if (action === 'verify_captcha') {
            const { captchaCode } = req.body;
            console.log(`\n📍 [EZADMIN VERIFY] 보안코드 [${captchaCode}] 입력...`);
            if (!captchaCode) {
                isProcessing = false;
                return res.status(400).json({ status: 'ERROR', message: 'captchaCode가 없습니다.' });
            }
            if (!globalPage) {
                isProcessing = false;
                return res.status(400).json({ status: 'ERROR', message: '브라우저 세션 없음. 로그인 먼저.' });
            }

            await globalPage.fill('input[id^="inputAuthCode"]', captchaCode);
            await globalPage.click('button[id^="authcode_button"]');
            await globalPage.waitForTimeout(5000);

            console.log('📍 [EZADMIN VERIFY] ✅ 보안코드 인증 완료');
            isProcessing = false;
            return res.json({ status: 'SUCCESS', message: '보안코드 인증 성공' });
        }

        // ========================================
        // ACTION: scrape
        // ★ ga67 재고 페이지 접속 + 검색 + 데이터 수집
        // ========================================
        if (action === 'scrape') {
            if (!globalPage) {
                isProcessing = false;
                return res.status(400).json({ status: 'ERROR', message: '브라우저 세션 없음. 로그인 먼저.' });
            }

            const targetUrl = 'https://ga67.ezadmin.co.kr/template35.htm?template=I100';
            const MAX_RETRIES = 3;
            
            for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                console.log(`\n📍 [EZADMIN SCRAPE] === 시도 ${attempt}/${MAX_RETRIES} ===`);

                // ★ STEP 1: ga67 재고 페이지 이동
                console.log('📍 [EZADMIN SCRAPE] STEP 1: ga67 재고 페이지 이동...');
                try {
                    await globalPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                } catch (gotoErr) {
                    console.log(`📍 [EZADMIN SCRAPE] ❌ 페이지 로드 실패: ${gotoErr.message}`);
                    if (attempt < MAX_RETRIES) {
                        console.log(`📍 [EZADMIN SCRAPE] 🔄 10초 후 재시도...`);
                        await globalPage.waitForTimeout(10000);
                        continue;
                    }
                    let screenshot = null;
                    try { screenshot = 'data:image/png;base64,' + (await globalPage.screenshot()).toString('base64'); } catch(e) {}
                    isProcessing = false;
                    return res.status(500).json({ status: 'ERROR', message: 'ga67 페이지 로드 타임아웃', screenshot });
                }

                await globalPage.waitForTimeout(3000);

                // ★ STEP 2: 페이지 상태 확인
                const currentUrl = globalPage.url();
                let bodyText = '';
                try { bodyText = await globalPage.textContent('body') || ''; } catch(e) {}
                console.log(`📍 [EZADMIN SCRAPE] 현재 URL: ${currentUrl}`);
                console.log(`📍 [EZADMIN SCRAPE] 페이지 앞 200자: ${bodyText.substring(0, 200)}`);

                // DB 에러 감지 → 재시도
                if (bodyText.includes('mysqli') || bodyText.includes('데이터베이스에 연결할 수 없습니다')) {
                    console.log(`📍 [EZADMIN SCRAPE] ⚠️ DB 에러 감지! (시도 ${attempt}/${MAX_RETRIES})`);
                    if (attempt < MAX_RETRIES) {
                        console.log(`📍 [EZADMIN SCRAPE] 🔄 15초 후 재시도...`);
                        await new Promise(r => setTimeout(r, 15000));
                        continue;
                    }
                    let screenshot = null;
                    try { screenshot = 'data:image/png;base64,' + (await globalPage.screenshot()).toString('base64'); } catch(e) {}
                    isProcessing = false;
                    return res.status(503).json({ status: 'ERROR', message: `Ezadmin DB 에러 (${MAX_RETRIES}회 시도 실패)`, screenshot });
                }

                // 세션 만료 감지
                if (currentUrl.includes('ezadmin.co.kr/index') || bodyText.includes('login-domain')) {
                    console.log('📍 [EZADMIN SCRAPE] ⚠️ 세션 만료!');
                    let screenshot = null;
                    try { screenshot = 'data:image/png;base64,' + (await globalPage.screenshot()).toString('base64'); } catch(e) {}
                    isProcessing = false;
                    return res.status(401).json({ status: 'ERROR', message: '세션 만료 — 로그인 다시', screenshot });
                }

                // ★ STEP 3: #search 버튼 대기 + 클릭
                console.log('📍 [EZADMIN SCRAPE] STEP 3: 검색 버튼 대기...');
                try {
                    await globalPage.waitForSelector('#search', { timeout: 30000 });
                } catch (selectorErr) {
                    console.log('📍 [EZADMIN SCRAPE] ❌ #search 버튼 미발견');
                    if (attempt < MAX_RETRIES) {
                        console.log(`📍 [EZADMIN SCRAPE] 🔄 10초 후 재시도...`);
                        await new Promise(r => setTimeout(r, 10000));
                        continue;
                    }
                    let screenshot = null;
                    try { screenshot = 'data:image/png;base64,' + (await globalPage.screenshot()).toString('base64'); } catch(e) {}
                    isProcessing = false;
                    return res.status(500).json({ status: 'ERROR', message: '#search 미발견', bodyPreview: bodyText.substring(0, 500), screenshot });
                }

                console.log('📍 [EZADMIN SCRAPE] STEP 3.5: 검색 버튼 클릭...');
                await globalPage.click('#search');
                await globalPage.waitForTimeout(7000);

                // ★ STEP 4: 데이터 파싱
                console.log('📍 [EZADMIN SCRAPE] STEP 4: jqxGrid 데이터 파싱...');
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

                console.log(`📍 [EZADMIN SCRAPE] ✅ 총 ${stockData.length}건 재고 추출 완료!`);
                isProcessing = false;
                return res.json({ status: 'SUCCESS', count: stockData.length, data: stockData });
            }

            // 여기까지 오면 모든 재시도 실패
            isProcessing = false;
            return res.status(500).json({ status: 'ERROR', message: '모든 재시도 실패' });
        }

        isProcessing = false;
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
            console.error('📍 [EZADMIN] 스크린샷 실패:', ssErr.message);
        }

        isProcessing = false;
        res.status(500).json({ status: 'ERROR', message: error.message, screenshot });
    }
}

module.exports = { execute };
