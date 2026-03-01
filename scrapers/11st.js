const { chromium } = require('playwright');
const { ImapFlow } = require('imapflow');
const simpleParser = require('mailparser').simpleParser;
const fs = require('fs');
const XLSX = require('xlsx');

const USER_ID = process.env['11th_USER'];
const USER_PW = process.env['11th_PW'];
const NAVER_USER = process.env['EMAIL_USER'];
const NAVER_PW = process.env['EMAIL_PW'];

let globalBrowser = null;
let globalPage = null;
let globalOtpRequestTime = 0;

async function getAuthCodeFromMail() {
    const client = new ImapFlow({
        host: 'imap.worksmobile.com', port: 993, secure: true,
        auth: { user: NAVER_USER, pass: NAVER_PW }, logger: false
    });
    await client.connect();
    let lock = await client.getMailboxLock('INBOX');
    let authCode = null;
    try {
        const searchList = await client.search({ unseen: true });
        if (searchList.length > 0) {
            const latestSeq = searchList[searchList.length - 1];
            const message = await client.fetchOne(latestSeq, { source: true });
            if (message && message.source) {
                const mail = await simpleParser(message.source);
                const mailDate = mail.date ? mail.date.getTime() : 0;
                if (mailDate < globalOtpRequestTime) return null;
                await client.messageFlagsAdd(latestSeq, ['\\Seen']);
                const mailText = mail.text || mail.html;
                const match = mailText.match(/\d{6,8}/);
                if (match) authCode = match[0];
            }
        }
    } catch (err) { console.error('DEBUG: [MAIL_ERROR]', err); }
    finally { lock.release(); await client.logout(); }
    return authCode;
}

async function execute(action, req, res) {
    try {
        if (action === 'login') {
            console.log('STEP 1: Starting Login...');
            if (globalBrowser) await globalBrowser.close();
            globalBrowser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            let contextOptions = { viewport: { width: 1400, height: 1000 } };
            if (fs.existsSync('auth.json')) { contextOptions.storageState = 'auth.json'; }
            const context = await globalBrowser.newContext(contextOptions);
            globalPage = await context.newPage();
            globalPage.on('dialog', async dialog => await dialog.accept());
            await globalPage.goto('https://login.11st.co.kr/auth/front/selleroffice/login.tmall');
            await globalPage.waitForTimeout(4000);
            if (globalPage.url().includes('soffice.11st.co.kr')) return res.json({ status: 'SUCCESS' });
            await globalPage.fill('#loginName', USER_ID);
            await globalPage.fill('#passWord', USER_PW);
            await globalPage.click('button.c-button--submit');
            await globalPage.waitForTimeout(4000);
            if (await globalPage.isVisible('button:has-text("인증정보 선택하기")')) {
                await globalPage.click('button:has-text("인증정보 선택하기")');
                await globalPage.waitForTimeout(2000);
            }
            if (await globalPage.isVisible('label[for="auth_type_02"]')) {
                await globalPage.click('label[for="auth_type_02"]');
                globalOtpRequestTime = Date.now() - 60000;
                await globalPage.click('button:has-text("인증번호 전송"):visible');
                return res.json({ status: 'AUTH_REQUIRED' });
            }
            await globalPage.context().storageState({ path: 'auth.json' });
            return res.json({ status: 'SUCCESS' });
        }

        if (action === 'verify_auto') {
            const code = await getAuthCodeFromMail();
            if (!code) return res.json({ status: 'WAIT' });
            await globalPage.fill('#auth_num_email', code);
            await globalPage.click('#auth_email_otp button[onclick="login();"]');
            await globalPage.waitForTimeout(5000);
            await globalPage.context().storageState({ path: 'auth.json' });
            return res.json({ status: 'SUCCESS' });
        }

        if (action === 'scrape') {
            console.log('STEP 1: Scrape initiated.');
            if (!globalPage) throw new Error('Session not found. Please login.');

            console.log('STEP 2: Navigating to Stock Page...');
            await globalPage.goto('https://soffice.11st.co.kr/view/40394', { waitUntil: 'domcontentloaded' });
            await globalPage.waitForTimeout(10000);

            let targetFrame = null;
            for (const frame of globalPage.frames()) {
                if (await frame.locator('#btnSearch').count() > 0) { targetFrame = frame; break; }
            }
            if (!targetFrame) throw new Error('Frame with search button not found.');

            console.log('STEP 3: Clicking Search Button...');
            await targetFrame.click('#btnSearch', { force: true });
            await globalPage.waitForTimeout(5000);

            console.log('STEP 4: Ensuring Excel Download button is ready...');
            const downloadBtn = targetFrame.locator('button:has-text("엑셀다운로드")');
            await downloadBtn.scrollIntoViewIfNeeded();

            console.log('STEP 5: Waiting for Download event (timeout increased to 60s)...');
            try {
                const [download] = await Promise.all([
                    // 타임아웃을 60초로 늘리고, 명시적으로 이벤트를 기다립니다.
                    globalPage.waitForEvent('download', { timeout: 60000 }),
                    downloadBtn.click({ force: true })
                ]);

                const filePath = `./temp_stock_${Date.now()}.xls`;
                console.log(`STEP 6: Saving file to ${filePath}...`);
                await download.saveAs(filePath);

                console.log('STEP 7: Processing Excel Data...');
                const workbook = XLSX.readFile(filePath);
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

                const finalData = rawData.slice(1).map((row) => {
                    const obj = {};
                    for (let i = 0; i < 36; i++) {
                        let val = (row[i] === undefined || row[i] === null) ? "" : String(row[i]).trim();
                        if ([0, 9, 10, 11, 12, 13, 14, 15, 19, 20, 21, 22, 30].includes(i)) {
                            val = val.replace(/,/g, '') || '0';
                        }
                        obj[`col_${i}`] = val;
                    }
                    return obj;
                });

                fs.unlinkSync(filePath);
                console.log(`STEP 8: Success! Collected ${finalData.length} items.`);
                return res.json({ status: 'SUCCESS', count: finalData.length, data: finalData });

            } catch (downloadErr) {
                console.error('STEP 5 ERROR: Download failed or timed out.', downloadErr.message);
                // 에러 발생 시 현재 화면을 찍어서 디버깅 (선택 사항)
                return res.json({ status: 'ERROR', message: `Download Timeout: ${downloadErr.message}` });
            }
        }
    } catch (err) {
        console.error('FATAL ERROR:', err.message);
        return res.json({ status: 'ERROR', message: err.message });
    }
}

module.exports = { execute };
