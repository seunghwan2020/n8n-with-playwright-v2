cd n8n-with-playwright
cp naver_store.js scrapers/
git add . && git commit -m "feat: add naver_store scraper"
git push  # Railway 자동 배포
```

※ `server.js`에서 `scrapers/` 폴더를 동적으로 불러오는 구조면 이것만으로 끝이고, 라우팅이 하드코딩되어 있으면 `naver_store` 케이스 추가가 필요할 수 있어요.

### Step 2: 워크플로우 Import
v3 JSON을 n8n **Primary 인스턴스**에 Import (Playwright 인스턴스 아님 — HTTP Request만 사용하니까!)

### Step 3: URL 확인
워크플로우의 `🎭 Playwright 실행` 노드 URL이 형의 실제 Playwright 서버 URL과 맞는지 확인. 현재 설정:
```
https://n8n-with-playwright-v2-production.up.railway.app/execute
