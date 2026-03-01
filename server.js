const express = require('express');
const app = express();
app.use(express.json());

// 🌟 범인 검거 완료: 11th.js -> 11st.js 로 파일명 완벽 일치!
const handler11st = require('./scrapers/11st.js');
// 🌟 이지어드민 모듈 추가 연결
const handlerEzadmin = require('./scrapers/ezadmin.js');

app.post('/execute', async (req, res) => {
    const { site, action } = req.body;

    if (!site) {
        return res.status(400).json({ status: 'ERROR', message: '어느 사이트인지 site 파라미터를 보내주세요. (예: 11st, ezadmin)' });
    }

    try {
        console.log(`\n🚀 [요청 수신] 타겟 사이트: ${site} / 액션: ${action}`);

        if (site === '11st') {
            await handler11st.execute(action, req, res);
        } else if (site === 'ezadmin') { // 🌟 이지어드민 분기 추가
            await handlerEzadmin.execute(action, req, res);
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
