FROM mcr.microsoft.com/playwright:v1.41.0-jammy

# 앱 디렉토리 생성
WORKDIR /app

# 의존성 설치
COPY package.json .
RUN npm install

# 소스 복사
COPY . .

# Playwright 브라우저 설치 (크롬 전용)
RUN npx playwright install chromium

EXPOSE 8080
CMD ["node", "server.js"]
