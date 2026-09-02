const { chromium } = require('playwright');

// D.CURVIN 창고관리 3PL (이벗 대체, 2026.09~)
// 로그인은 "고객사"(tenant) 탭. 아이디/비밀번호는 이 서비스(Railway)의 환경변수로만 관리 —
// 절대 요청 body나 로그에 노출하지 않는다.
const FITLOGIC_ID = process.env['FITLOGIC_ID'];
const FITLOGIC_PW = process.env['FITLOGIC_PW'];
const BASE = 'https://www.fitlogic.co.kr';

let globalBrowser = null;
let globalPage = null;
let isProcessing = false; // ★ 동시 요청 방지 락

async function screenshotOf(page) {
    try { return 'data:image/png;base64,' + (await page.screenshot()).toString('base64'); }
    catch (e) { return null; }
}

async function execute(action, req, res) {
    if (isProcessing) {
        console.log('📍 [FITLOGIC] ⚠️ 이전 요청 처리 중 — 10초 대기 후 재시도');
        await new Promise(r => setTimeout(r, 10000));
        if (isProcessing) {
            return res.status(429).json({ status: 'ERROR', message: '이전 요청이 아직 처리 중입니다. 잠시 후 재시도하세요.' });
        }
    }
    isProcessing = true;

    try {
        // ========================================
        // ACTION: login
        // ========================================
        if (action === 'login') {
            if (!FITLOGIC_ID || !FITLOGIC_PW) {
                isProcessing = false;
                return res.status(500).json({ status: 'ERROR', message: 'FITLOGIC_ID / FITLOGIC_PW 환경변수 미설정.' });
            }

            console.log('\n📍 [FITLOGIC LOGIN] STEP 1: 브라우저 실행...');
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

            console.log('📍 [FITLOGIC LOGIN] STEP 2: 로그인 페이지 접속...');
            await globalPage.goto(`${BASE}/auth/login/`, { timeout: 60000 });
            await globalPage.waitForTimeout(1500);

            console.log('📍 [FITLOGIC LOGIN] STEP 3: 고객사 탭 선택...');
            await globalPage.click('button:has-text("고객사")');
            await globalPage.waitForTimeout(300);

            console.log(`📍 [FITLOGIC LOGIN] STEP 4: 정보 입력 (ID: ${FITLOGIC_ID})...`);
            await globalPage.fill('input[name="username"]', FITLOGIC_ID);
            await globalPage.fill('input[name="password"]', FITLOGIC_PW);

            console.log('📍 [FITLOGIC LOGIN] STEP 5: 로그인 버튼 클릭...');
            await Promise.all([
                globalPage.waitForNavigation({ timeout: 30000 }).catch(() => null),
                globalPage.click('button[type="submit"]'),
            ]);
            await globalPage.waitForTimeout(1500);

            const afterLoginUrl = globalPage.url();
            console.log(`📍 [FITLOGIC LOGIN] STEP 6: 현재 URL: ${afterLoginUrl}`);

            const stillOnLogin = afterLoginUrl.includes('/auth/login/');
            const screenshot = await screenshotOf(globalPage);

            if (stillOnLogin) {
                console.log('📍 [FITLOGIC LOGIN] ❌ 로그인 실패 — 여전히 로그인 페이지');
                isProcessing = false;
                return res.status(401).json({ status: 'ERROR', message: '로그인 실패 — 로그인 페이지에 그대로 남음 (아이디/비밀번호 확인 필요)', currentUrl: afterLoginUrl, screenshot });
            }

            console.log('📍 [FITLOGIC LOGIN] ✅ 로그인 성공!');
            isProcessing = false;
            return res.json({ status: 'SUCCESS', message: '로그인 완료', currentUrl: afterLoginUrl, screenshot });
        }

        // ========================================
        // ACTION: scrape
        // → (1) /inventory/ 가용재고 + (2) /inventory/snapshot/ 위치(팔렛트) 스냅샷
        //   두 페이지를 한 번에 수집해서 함께 반환 (n8n 쪽에서 SQL 생성)
        // ========================================
        if (action === 'scrape') {
            if (!globalPage) {
                isProcessing = false;
                return res.status(400).json({ status: 'ERROR', message: '브라우저 세션 없음. 로그인 먼저.' });
            }

            // --- (1) 가용재고 ---
            console.log('📍 [FITLOGIC SCRAPE] STEP 1: /inventory/ 이동...');
            await globalPage.goto(`${BASE}/inventory/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await globalPage.waitForTimeout(1000);

            if (globalPage.url().includes('/auth/login/')) {
                const screenshot = await screenshotOf(globalPage);
                isProcessing = false;
                return res.status(401).json({ status: 'ERROR', message: '세션 만료 — 로그인 다시', screenshot });
            }

            const stockRows = await globalPage.evaluate(() => {
                const trs = document.querySelectorAll('tr.border-b.last\\:border-0.hover\\:bg-gray-50');
                const out = [];
                trs.forEach(tr => {
                    const cells = [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim());
                    if (cells.length < 8) return;
                    const [sku_code, product_name, brand, total_qty, allocated_qty, available_qty, location_count, status] = cells;
                    out.push({ sku_code, product_name, brand, total_qty: Number(total_qty) || 0, allocated_qty: Number(allocated_qty) || 0, available_qty: Number(available_qty) || 0, location_count: Number(location_count) || 0, status: status || null });
                });
                return out;
            });
            console.log(`📍 [FITLOGIC SCRAPE] 가용재고 ${stockRows.length}건 파싱`);

            // --- (2) 위치(팔렛트) 스냅샷 ---
            console.log('📍 [FITLOGIC SCRAPE] STEP 2: /inventory/snapshot/ 이동...');
            await globalPage.goto(`${BASE}/inventory/snapshot/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await globalPage.waitForTimeout(1000);

            const locationRows = await globalPage.evaluate(() => {
                const trs = document.querySelectorAll('tr.border-t.hover\\:bg-gray-50');
                const out = [];
                trs.forEach(tr => {
                    const cells = [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim());
                    if (cells.length < 4) return;
                    const [sku_code, product_name, warehouse_code, qty] = cells;
                    out.push({ sku_code, product_name, warehouse_code, qty: Number(qty) || 0 });
                });
                return out;
            });
            console.log(`📍 [FITLOGIC SCRAPE] 위치 스냅샷 ${locationRows.length}건 파싱`);

            if (stockRows.length === 0 || locationRows.length === 0) {
                const screenshot = await screenshotOf(globalPage);
                isProcessing = false;
                return res.status(500).json({ status: 'ERROR', message: `파싱 0건 (재고 ${stockRows.length}, 위치 ${locationRows.length}) — 페이지 구조 변경 의심`, screenshot });
            }

            isProcessing = false;
            return res.json({ status: 'SUCCESS', stock: stockRows, location: locationRows });
        }

        isProcessing = false;
        return res.status(400).json({ status: 'ERROR', message: '정의되지 않은 액션입니다.' });

    } catch (error) {
        console.error('📍 [FITLOGIC 핸들러 에러]', error);
        const screenshot = globalPage ? await screenshotOf(globalPage) : null;
        isProcessing = false;
        res.status(500).json({ status: 'ERROR', message: error.message, screenshot });
    }
}

module.exports = { execute };
