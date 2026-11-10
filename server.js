const express = require('express');
const app = express();
app.use(express.json());

// ===== v38 (2026-11-10 SON "레일웨이 서버를 정기적으로 리스타트 — 아무 때나 말고 스케줄 관리하면서") =====
// 서버가 스스로 꺼지면(process.exit(1)) Railway 재시작 정책이 다시 켠다. 꺼져도 되는 때만 꺼진다:
//  - 정기: 매일 04:15~04:27(한국시간) — 경쟁사 수집(매시 00·30분, 약 10분)과 FITLOGIC(23:30) 사이 빈 시간
//  - 비상: 네이버 수집이 연달아 3번 강제 종료·브라우저 교체로 끝나면, 다음 빈 시간(매시 15~27분·45~57분)에
//  - 공통: 진행 중인 요청이 0개이고 마지막 요청이 끝난 지 60초가 지났을 때만. 켜진 지 30분 안이면 다시 끄지 않음
const BOOT_AT = Date.now();
let exiting = false, inflight = 0, lastDone = Date.now(), lastStart = 0, badStreak = 0, restartReason = null, lastDaily = '';
app.use((req, res, next) => {
  if (req.path !== '/execute') return next();
  inflight++; lastStart = Date.now();
  let done = false; const fin = () => { if (done) return; done = true; inflight = Math.max(0, inflight - 1); lastDone = Date.now(); };
  res.on('finish', fin); res.on('close', fin);
  next();
});
const kstNow = () => { const d = new Date(Date.now() + 9 * 3600 * 1000); return { ymd: d.toISOString().slice(0, 10), h: d.getUTCHours(), m: d.getUTCMinutes() }; };
const quietSlot = k => (k.m >= 15 && k.m <= 27) || (k.m >= 45 && k.m <= 57);
const idleOk = () => inflight === 0 && Date.now() - lastDone > 60000 && Date.now() - BOOT_AT > 30 * 60000;
function noteResult(ok) { if (ok) badStreak = 0; else badStreak++; if (badStreak >= 3 && !restartReason) { restartReason = 'naver_store 연속 실패 ' + badStreak + '회'; console.log('[v38] 재시작 예약: ' + restartReason); } }
setInterval(() => {
  const k = kstNow();
  if (k.h === 4 && k.m >= 15 && k.m <= 27 && lastDaily !== k.ymd && !restartReason) restartReason = '정기 재시작(매일 04:15)';
  if (exiting || !restartReason || !quietSlot(k) || !idleOk()) return;
  exiting = true;
  if (restartReason.indexOf('정기') === 0) lastDaily = k.ymd;
  console.log('[v38] 서버 재시작: ' + restartReason + ' · uptime ' + Math.round(process.uptime()) + 's · rss ' + Math.round(process.memoryUsage().rss / 1048576) + 'MB');
  setTimeout(() => process.exit(1), 500);
}, 30000);


// 🌟 범인 검거 완료: 11th.js -> 11st.js 로 파일명 완벽 일치!
const handler11st = require('./scrapers/11st.js');
// 🌟 이지어드민 모듈 추가 연결
const handlerEzadmin = require('./scrapers/ezadmin.js');
// 🌟 네이버 스토어 크롤링 모듈 추가
const handlerNaverStore = require('./scrapers/naver_store.js');
// 🌟 FITLOGIC 창고관리 모듈 추가 (이벗 대체, 2026.09~)
const handlerFitlogic = require('./scrapers/fitlogic.js');

// v37: 살아 있는지 확인용 — 네이버 스토어 수집 브라우저 상태(진행 중·누적 건수)
app.get('/health', (req, res) => { res.json({ ok: true, boot_at: new Date(BOOT_AT).toISOString(), uptime_s: Math.round(process.uptime()), mem_mb: Math.round(process.memoryUsage().rss / 1048576), inflight, bad_streak: badStreak, restart_pending: restartReason, naver_store: handlerNaverStore.status ? handlerNaverStore.status() : null }); });

app.post('/execute', async (req, res) => {
    const { site, action } = req.body;

    if (!site) {
        return res.status(400).json({ status: 'ERROR', message: '어느 사이트인지 site 파라미터를 보내주세요. (예: 11st, ezadmin, naver_store, fitlogic)' });
    }

    try {
        console.log(`\n🚀 [요청 수신] 타겟 사이트: ${site} / 액션: ${action}`);

        if (site === '11st') {
            await handler11st.execute(action, req, res);
        } else if (site === 'ezadmin') {
            await handlerEzadmin.execute(action, req, res);
        } else if (site === 'naver_store') {
            const _json = res.json.bind(res); // v38: 강제 종료·브라우저 교체로 끝난 응답을 연속 실패로 센다
            res.json = body => { try { if (action === 'scrape') noteResult(!(body && body.status === 'ERROR' && /강제 종료|브라우저 교체/.test(String(body.error || '')))); } catch (e) {} return _json(body); };
            await handlerNaverStore.execute(action, req, res);
        } else if (site === 'fitlogic') {
            await handlerFitlogic.execute(action, req, res);
        } else {
            res.status(404).json({ status: 'ERROR', message: `아직 지원하지 않는 사이트입니다: ${site}` });
        }
    } catch (error) {
        console.error(`📍 [${site} 전역 에러]`, error);
        if (!res.headersSent) {
            res.status(500).json({ status: 'ERROR', message: error.message });
        }
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 중앙 관제탑이 ${PORT} 포트에서 실행 중입니다.`));
