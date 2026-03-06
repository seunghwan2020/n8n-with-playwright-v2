const { chromium } = require('playwright');

console.log('🔥 LOADED FILE: scrapers/naver_store.js / BUILD = DCURVIN_PURCHASE_FIX_V31');

function ctxOpts() {
  return {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1600, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    extraHTTPHeaders: {
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  };
}

function stealth() {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'languages', {
    get: () => ['ko-KR', 'ko', 'en-US', 'en'],
  });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
}

function toNum(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/[^\d]/g, '');
  return s ? parseInt(s, 10) : 0;
}

function shouldIgnoreUrl(url) {
  const u = String(url || '').toLowerCase();

  if (
    u.includes('static-resource-smartstore.pstatic.net') ||
    u.includes('connect.facebook.net') ||
    u.includes('google-analytics') ||
    u.includes('googletagmanager') ||
    u.includes('doubleclick') ||
    u.includes('analytics') ||
    u.endsWith('.js') ||
    u.includes('.js?')
  ) return true;

  return false;
}

function isReviewUrl(url) {
  const u = String(url || '').toLowerCase();
  return (
    u.includes('/contents/reviews/') ||
    u.includes('/reviews/') ||
    u.includes('store_pick') ||
    u.includes('photo_video')
  );
}

function isMarketingMessageUrl(url) {
  return String(url || '').toLowerCase().includes('/marketing-message/');
}

function isAllowedProductUrl(url) {
  const u = String(url || '').toLowerCase();

  if (isReviewUrl(u)) return false;

  return (
    u.includes('/products/') ||
    u.includes('/group-products/') ||
    u.includes('/simple-products') ||
    u.includes('/product-benefits/') ||
    u.includes('/marketing-message/')
  );
}

function recordCandidate(bucket, kind, value, path, source, rawText) {
  const num = toNum(value);
  if (!num) return;

  if (kind === 'recent') bucket.recent = Math.max(bucket.recent, num);
  if (kind === 'cumul') bucket.cumul = Math.max(bucket.cumul, num);
  if (kind === 'purchase') bucket.purchase = Math.max(bucket.purchase, num);

  bucket.matches.push({
    kind,
    value: num,
    path: path || '',
    source: source || '',
    raw: rawText ? String(rawText).slice(0, 160) : '',
  });
}

function deepScanStrictObject(input, bucket, path = 'root', source = '') {
  if (input === null || input === undefined) return;

  if (Array.isArray(input)) {
    input.forEach((v, idx) => {
      deepScanStrictObject(v, bucket, `${path}[${idx}]`, source);
    });
    return;
  }

  if (typeof input !== 'object') return;

  for (const [k, v] of Object.entries(input)) {
    const lk = String(k).toLowerCase();
    const nextPath = `${path}.${k}`;

    if (
      lk.includes('review') ||
      lk === 'reviewcontent' ||
      lk === 'content' ||
      lk === 'description'
    ) {
      continue;
    }

    if (lk === 'recentsalecount') {
      recordCandidate(bucket, 'recent', v, nextPath, source);
    } else if (
      lk === 'cumulationsalecount' ||
      lk === 'cumulativesalecount' ||
      lk === 'totalsalecount' ||
      lk === 'salecounttotal' ||
      lk === 'totalsalescount'
    ) {
      recordCandidate(bucket, 'cumul', v, nextPath, source);
    } else if (
      lk === 'purchasecount' ||
      lk === 'purchasecnt' ||
      lk === 'ordercount' ||
      lk === 'salescount'
    ) {
      recordCandidate(bucket, 'purchase', v, nextPath, source);
    }

    if (typeof v === 'object' && v !== null) {
      deepScanStrictObject(v, bucket, nextPath, source);
    }
  }
}

function deepScanMarketingMessage(input, bucket, path = 'root', source = '') {
  if (input === null || input === undefined) return;

  if (Array.isArray(input)) {
    input.forEach((v, idx) => {
      deepScanMarketingMessage(v, bucket, `${path}[${idx}]`, source);
    });
    return;
  }

  if (typeof input === 'string') {
    const s = input;

    const patterns = [
      /(\d[\d,]*)\s*명이\s*구매/gi,
      /(\d[\d,]*)\s*명이\s*구매했/gi,
      /(\d[\d,]*)\s*개\s*구매/gi,
      /최근[^0-9]{0,20}(\d[\d,]*)[^0-9]{0,10}(?:개|명)[^가-힣]{0,5}구매/gi,
      /(\d[\d,]*)\s*(?:건|회)\s*구매/gi,
      /누적[^0-9]{0,20}(\d[\d,]*)[^0-9]{0,10}(?:개|건|회|명)/gi,
      /총[^0-9]{0,20}(\d[\d,]*)[^0-9]{0,10}(?:개|건|회|명)/gi,
    ];

    for (const re of patterns) {
      let m;
      while ((m = re.exec(s)) !== null) {
        recordCandidate(bucket, 'purchase', m[1], path, source, s);
      }
    }
    return;
  }

  if (typeof input !== 'object') return;

  for (const [k, v] of Object.entries(input)) {
    const nextPath = `${path}.${k}`;
    if (typeof v === 'string' || typeof v === 'object') {
      deepScanMarketingMessage(v, bucket, nextPath, source);
    }
  }
}

function extractUsefulMatches(matches) {
  const uniq = [];
  const seen = new Set();

  for (const m of matches) {
    const key = `${m.kind}|${m.value}|${m.path}|${m.source}|${m.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(m);
  }

  return uniq.slice(0, 30);
}

async function collectProductCounts(context, productUrl) {
  const page = await context.newPage();
  await page.addInitScript(stealth);

  const bucket = {
    recent: 0,
    cumul: 0,
    purchase: 0,
    matches: [],
    responseUrls: [],
  };

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const headers = response.headers();
      const contentType = String(headers['content-type'] || '').toLowerCase();
      const resourceType = response.request().resourceType();

      if (shouldIgnoreUrl(url)) return;
      if (!isAllowedProductUrl(url)) return;
      if (response.status() >= 400) return;
      if (!['xhr', 'fetch', 'document'].includes(resourceType)) return;
      if (!/json|html|text/.test(contentType)) return;

      const text = await response.text();
      bucket.responseUrls.push(url);

      if (/json/.test(contentType)) {
        try {
          const json = JSON.parse(text);

          if (isMarketingMessageUrl(url)) {
            deepScanMarketingMessage(json, bucket, 'response', url);
          } else {
            deepScanStrictObject(json, bucket, 'response', url);
          }
        } catch (_) {}
      }
    } catch (_) {}
  });

  try {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1800);

    const pageData = await page.evaluate(() => {
      let preloaded = null;
      let nextData = null;

      try {
        preloaded = window.__PRELOADED_STATE__ || null;
      } catch (_) {}

      try {
        const el = document.querySelector('#__NEXT_DATA__');
        if (el && el.textContent) nextData = JSON.parse(el.textContent);
      } catch (_) {}

      return {
        preloaded,
        nextData,
      };
    });

    deepScanStrictObject(pageData.preloaded, bucket, 'window.__PRELOADED_STATE__', 'pageState');
    deepScanStrictObject(pageData.nextData, bucket, '__NEXT_DATA__', 'pageState');
  } finally {
    await page.close().catch(() => {});
  }

  return {
    recent: bucket.recent || 0,
    cumul: bucket.cumul || 0,
    purchase: bucket.purchase || 0,
    matchedSources: [...new Set(bucket.responseUrls)].slice(0, 12),
    matches: extractUsefulMatches(bucket.matches),
  };
}

async function scrape(params) {
  console.log('🔥 RUNNING scrape() / BUILD = DCURVIN_PURCHASE_FIX_V31');

  const storeSlug = params.store_slug;
  const storeType = params.store_type || 'brand';

  const result = {
    status: 'OK',
    data: [],
    channel_uid: '',
    error: null,
    method_used: 'DCURVIN_PURCHASE_FIX_V31',
    debug: {
      build: 'DCURVIN_PURCHASE_FIX_V31',
      proxyEnabled: false,
      fetch: {
        total: 0,
        success: 0,
        fallbackDomUsed: 0,
      },
    },
  };

  let proxy = null;
  if (params.proxy_host && params.proxy_port) {
    proxy = {
      server: `http://${params.proxy_host}:${params.proxy_port}`,
    };
    if (params.proxy_user && params.proxy_pass) {
      proxy.username = params.proxy_user;
      proxy.password = params.proxy_pass;
    }
    result.debug.proxyEnabled = true;
  }

  let browser = null;
  let context = null;
  let page = null;
  const productMap = {};

  try {
    browser = await chromium.launch({
      headless: true,
      proxy,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-gpu',
      ],
    });

    context = await browser.newContext(ctxOpts());
    page = await context.newPage();
    await page.addInitScript(stealth);

    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });

    const domainRoot =
      storeType === 'brand'
        ? 'https://brand.naver.com'
        : 'https://smartstore.naver.com';

    const apiRoot =
      storeType === 'brand'
        ? 'https://brand.naver.com/n/v2/channels/'
        : 'https://smartstore.naver.com/i/v1/channels/';

    const baseUrl = `${domainRoot}/${storeSlug}`;
    const targetUrl = `${baseUrl}/category/ALL?st=POPULAR&dt=LIST&page=1&size=80`;

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);

    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);
    }

    const stateInfo = await page.evaluate(() => {
      const out = { channelUid: '', allIds: [] };

      try {
        const state = window.__PRELOADED_STATE__;
        if (!state) return out;

        if (state.channel && state.channel.channelUid) {
          out.channelUid = state.channel.channelUid;
        }

        const idSet = {};
        if (state.categoryProducts && state.categoryProducts.simpleProducts) {
          for (const item of state.categoryProducts.simpleProducts) {
            const pid = typeof item === 'object' ? String(item.id || '') : String(item || '');
            if (pid) idSet[pid] = true;
          }
        }

        out.allIds = Object.keys(idSet);
      } catch (_) {}

      return out;
    });

    result.channel_uid = stateInfo.channelUid;

    if (stateInfo.channelUid && stateInfo.allIds.length > 0) {
      const batchSize = 20;

      for (let i = 0; i < stateInfo.allIds.length; i += batchSize) {
        const batch = stateInfo.allIds.slice(i, i + batchSize);

        const apiResult = await page.evaluate(async (args) => {
          const q = args.ids.map((id) => `ids[]=${id}`).join('&');
          const url = `${args.apiRoot}${args.uid}/simple-products?${q}`;
          const res = await fetch(url, { credentials: 'include' }).catch(() => null);
          return res && res.ok ? await res.json().catch(() => null) : null;
        }, {
          uid: stateInfo.channelUid,
          ids: batch,
          apiRoot,
        });

        if (!Array.isArray(apiResult)) continue;

        for (const p of apiResult) {
          const pid = String(p.id || '');
          if (!pid) continue;

          let reviewCount = 0;
          if (p.reviewAmount && typeof p.reviewAmount === 'object') {
            reviewCount = p.reviewAmount.totalReviewCount || 0;
          }

          const discountPrice =
            p.benefitsView && p.benefitsView.discountedSalePrice
              ? p.benefitsView.discountedSalePrice
              : null;

          productMap[pid] = {
            product_id: pid,
            product_name: p.name || p.dispName || '',
            sale_price: p.salePrice || 0,
            discount_price: discountPrice,
            review_count: reviewCount,
            purchase_count: 0,
            total_purchase_count: 0,
            product_image_url: (p.representativeImageUrl || '').split('?')[0],
            category_name: p.category ? p.category.wholeCategoryName || '' : '',
            is_sold_out:
              p.productStatusType === 'OUTOFSTOCK' || p.soldout === true || false,
            product_url: `${baseUrl}/products/${pid}`,
            debug_purchase_source: '',
            debug_purchase_matches: [],
          };
        }
      }
    }

    const pids = Object.keys(productMap);
    result.debug.fetch.total = pids.length;

    const concurrency = Math.max(1, Math.min(4, Number(params.product_concurrency || 2)));

    for (let i = 0; i < pids.length; i += concurrency) {
      const batch = pids.slice(i, i + concurrency);

      const batchResults = await Promise.all(
        batch.map(async (id) => {
          const counts = await collectProductCounts(context, productMap[id].product_url).catch(() => ({
            recent: 0,
            cumul: 0,
            purchase: 0,
            matchedSources: [],
            matches: [],
          }));
          return { id, counts };
        })
      );

      for (const { id, counts } of batchResults) {
        const recent = counts.recent || 0;
        const cumul = counts.cumul || 0;
        const purchase = counts.purchase || 0;

        productMap[id].purchase_count = recent || purchase || 0;
        productMap[id].total_purchase_count = cumul || purchase || recent || 0;
        productMap[id].debug_purchase_source = (counts.matchedSources || []).join(' | ');
        productMap[id].debug_purchase_matches = counts.matches || [];

        if (recent || cumul || purchase) {
          result.debug.fetch.success++;
          if (!recent && (purchase || cumul)) result.debug.fetch.fallbackDomUsed++;
        }
      }
    }

    result.data = pids.map((pid) => productMap[pid]);
    result.debug.total = result.data.length;
    result.debug.withPurchase = result.data.filter(
      (x) => x.purchase_count > 0 || x.total_purchase_count > 0
    ).length;

    if (result.data.length === 0) {
      result.status = 'EMPTY';
      result.error = 'No products found';
    }
  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message || String(e);
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  return result;
}

async function execute(action, req, res) {
  if (action === 'scrape') {
    return res.json(await scrape(req.body));
  }

  return res.status(400).json({
    status: 'ERROR',
    message: `Unknown action: ${action}`,
  });
}

module.exports = { execute, scrape };
