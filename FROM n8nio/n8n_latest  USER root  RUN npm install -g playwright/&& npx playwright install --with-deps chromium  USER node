FROM n8nio/n8n:latest

USER root

RUN npm install -g playwright \
 && npx playwright install --with-deps chromium

USER node
