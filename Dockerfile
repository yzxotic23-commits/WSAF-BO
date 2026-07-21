FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./

# Runtime only — do NOT npm run build:ui (that overwrites FeedFlow PRO with AMS Overview SPA).
RUN npm install --omit=dev

COPY . .

# Require shipped PRO console (pair sidebar + QR + Start feeding).
RUN test -f client/dist/index.html \
  && test -f client/dist/assets/index-CbZz9OZp.js \
  && grep -q "AI pair conversations" client/dist/assets/index-CbZz9OZp.js

ENV NODE_ENV=production
ENV DESKTOP_FEEDING=1
# Always route WA through AMS/proxies.txt IP — never Railway egress (logout risk).
ENV PROXY_QR_LINK=sticky
ENV PROXY_PROBE=false
ENV WSAF_STICKY_PROXY=1
# Do not auto-reopen preview WA sockets after feeding (self-conflict → logout).
ENV FEEDFLOW_PREVIEW_RECONNECT=0

EXPOSE 47821

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.DESKTOP_API_PORT||47821)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "web.js"]
