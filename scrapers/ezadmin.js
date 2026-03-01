const { chromium } = require('playwright');
const fs = require('fs');

const EZ_DOMAIN = process.env['EZ_DOMAIN'];
const EZ_USER = process.env['EZ_USER'];
const EZ_PW = process.env['EZ_PW'];

let globalBrowser = null;
let globalPage = null;

async function execute(action, req, res) {
    try {
        if (action === 'login') {
            console.log('\n📍 [EZADMIN LOGIN] STEP 1: 브라우저 실행 및 세션 체크...');
            if (globalBrowser) await globalBrowser.close();

            globalBrowser = await chromium.launch({ 
                args: ['--no-sandbox', '--disable-setuid-sandbox'] 
            });
            
            let contextOptions = { viewport: { width: 1400, height: 900 } };
            
            // 🌟 1. 세션 파일이 있으면 브라우저에 장착
            if (fs.existsSync('auth_ezadmin.json')) {
                console.log('📍 [EZADMIN LOGIN] 저장된 세션 파일(auth_ezadmin.json)을 장착합니다.');
                contextOptions.storageState = 'auth_ezadmin.json';
            }

            const context = await globalBrowser.newContext(contextOptions);
            globalPage = await context.newPage();

            console.log('📍 [EZADMIN LOGIN] STEP 2: 메인 페이지 접속...');
            await globalPage.goto('https://ezadmin.co.kr/index.html');
            
            // 🌟 2. 세션이 살아있는지 확인 (로그인 전 화면에 뜨는 팝업이나 버튼으로 판별)
            // 메인 페이지가 아니거나, 특정 로그인 상태 요소가 보이면 프리패스
            // (이지어드민은 로그인 후 다른 도메인이나 다른 화면구조를 가질 수 있음. 여기서는 로그인 팝업이 안뜨거나 특정 주소로 가면 성공으로 간주)
            
            await globalPage.waitForTimeout(2000); // 렌더링 대기
            
            // 🌟 이지어드민은 보통 로그인 후 https://ga67.ezadmin.co.kr 등 할당된 서버로 이동하거나, 상단 메뉴가 바뀝니다.
            // 일단 로그인 버튼을 눌러보고, 바로 성공화면으로 넘어가는지 체크하는 방식을 씁니다.
            await globalPage.click('li.login a');
            await globalPage.waitForTimeout(2000);
            
            // 로그인 팝업창 도메인 입력칸이 보이는지 확인
            const isLoginPopupVisible = await globalPage.isVisible('#login-domain');
            
            if (!isLoginPopupVisible) {
                console.log('📍 [EZADMIN LOGIN] ✅ 이미 로그인되어 있습니다! 프리패스.');
                // 🌟 중요: 엑셀 다운로드를 위해 여기서 URL을 갱신해주어야 할 수도 있으나, scrape 액션에서 goto를 하므로 괜찮습니다.
                return res.json({ status: 'SUCCESS', message: '자동 로그인 성공' });
            }

            // 🌟 3. 세션이 없거나 풀렸다면 찐 로그인 진행
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
                console.log('📍 [EZADMIN LOGIN] ✅ 보안코드 없이 로그인 성공');
                // 🌟 로그인 성공 시 세션 저장
                await globalPage.context().storageState({ path: 'auth_ezadmin.json' });
                return res.json({ status: 'SUCCESS', message: '로그인 완료 및 세션 저장' });
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
            await globalPage.goto(targetUrl, { waitUntil: 'domcontentloaded' });
            await globalPage.waitForTimeout(3000);

            console.log('📍 [EZADMIN SCRAPE] STEP 2: 검색 버튼(F2) 클릭...');
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
        if (globalPage) {
            const buffer = await globalPage.screenshot();
            screenshot = 'data:image/png;base64,' + buffer.toString('base64');
        }

        res.status(500).json({ status: 'ERROR', message: error.message, screenshot });
    }
}

module.exports = { execute };
