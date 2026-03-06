const { chromium } = require('playwright');

console.log('🔥 LOADED FILE: scrapers/naver_store.js / BUILD = DCURVIN_PURCHASE_FIX_V28');

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
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
  });
  Object.defineProperty(navigator, 'languages', {
    get: () => ['ko-KR', 'ko', 'en-US', 'en'],
  });
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3],
  });
}

function toNum(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/[^\d]/g, '');
  return s ? parseInt(s, 10) : 0;
}

function deepScanForCounts(input, bucket) {
  if (!input) return;

  if (typeof input === 'string') {
    const patterns = [
      { re: /recentSaleCount["']?\s*[:=]\s*(\d[\d,]*)/gi, key: 'recent' },
      { re: /(?:cumulationSaleCount|cumulativeSaleCount|totalSaleCount|saleCountTotal)["']?\s*[:=]\s*(\d[\d,]*)/gi, key: 'cumul' },
      { re: /(?:purchaseCount|purchaseCnt|orderCount|salesCount)["']?\s*[:=]\s*(\d[\d,]*)/gi, key: 'purchase' },
      { re: /(?:구매|구매건수|구매수)\s*[:：]?\s*(\d[\d,]*)/gi, key: 'purchase' },
      { re: /(?:누적판매|총판매|판매량)\s*[:：]?\s*(\d[\d,]*)/gi, key: 'cumul' },
      { re: /(\d[\d,]*)\s*개\s*구매/gi, key: 'purchase' },
    ];

    for (const p of patterns) {
      let m;
      while ((m = p.re.exec(input)) !== null) {
        bucket[p.key] = Math.max(bucket[p.key] || 0, toNum(m[1]));
      }
    }
    return;
  }

  if (Array.isArray(input)) {
    for (const v of input) deepScanForCounts(v, bucket);
    return;
  }

  if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      const lk = String(k).toLowerCase();
      const num = toNum(v);

      if (lk === 'recentsalecount') bucket.recent = Math.max(bucket.recent || 0, num);
      if (
        lk === 'cumulationsalecount' ||
        lk === 'cumulativesalecount' ||
        lk === 'totalsalecount' ||
        lk === 'salecounttotal'
      ) {
        bucket.cumul = Math.max(bucket.cumul || 0, num);
      }
      if (
        lk === 'purchasecount' ||
        lk === 'purchasecnt' ||
        lk === 'ordercount' ||
        lk === 'salescount'
      ) {
        bucket.purchase = Math.max(bucket.purchase || 0, num);
      }

      if (typeof v === 'object' || typeof v === 'string') {
        deepScanForCounts(v, bucket);
      }
    }
  }
}

async function collectProductCounts(context, productUrl) {
  const page = await context.newPage();
  await page.addInitScript(stealth);

  const bucket = { recent: 0, cumul: 0, purchase: 0 };
  const matchedSources = [];

  page.on('response', async (response) => {
    try {
      const url = response.url();
      const headers = response.headers();
      const contentType = String(headers['content-type'] || '').toLowerCase();

      if (!/json|javascript|html/.test(contentType)) return;
      if (response.status() >= 400) return;

      const text = await response.text();
      if (!/(purchase|salecount|recentsale|cumulation|구매|판매)/i.test(text)) return;

      matchedSources.push(url.slice(0, 200));
      deepScanForCounts(text, bucket);

      if (/json/.test(contentType)) {
        try {
          const json = JSON.parse(text);
          deepScanForCounts(json, bucket);
        } catch (_) {}
      }
    } catch (_) {}
  });

  try {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const pageData = await page.evaluate(() => {
      const scripts = Array.from(document.scripts || []).map((s) => s.textContent || '').join('\n');

      let preloaded = null;
      try {
        preloaded = window.__PRELOADED_STATE__ || null;
      } catch (_) {}

      let nextData = null;
      try {
        const el = document.querySelector('#__NEXT_DATA__');
        if (el && el.textContent) nextData = JSON.parse(el.textContent);
      } catch (_) {}

      return {
        title: document.title || '',
        bodyText: document.body ? document.body.innerText : '',
        html: document.documentElement ? document.documentElement.outerHTML : '',
        scripts,
        preloaded,
        nextData,
      };
    });

    deepScanForCounts(pageData.title, bucket);
    deepScanForCounts(pageData.bodyText, bucket);
    deepScanForCounts(pageData.html, bucket);
    deepScanForCounts(pageData.scripts, bucket);
    deepScanForCounts(pageData.preloaded, bucket);
    deepScanForCounts(pageData.nextData, bucket);
  } finally {
    await page.close().catch(() => {});
  }

  return {
    recent: bucket.recent || 0,
    cumul: bucket.cumul || 0,
    purchase: bucket.purchase || 0,
    matchedSources: matchedSources.slice(0, 10),
  };
}

async function scrape(params) {
  console.log('🔥 RUNNING scrape() / BUILD = DCURVIN_PURCHASE_FIX_V28');

  const storeSlug = params.store_slug;
  const storeType = params.store_type || 'brand';

  const result = {
    status: 'OK',
    data: [],
    channel_uid: '',
    error: null,
    method_used: 'DCURVIN_PURCHASE_FIX_V28',
    debug: {
      build: 'DCURVIN_PURCHASE_FIX_V28',
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

    const domainRoot = storeType === 'brand'
      ? 'https://brand.naver.com'
      : 'https://smartstore.naver.com';

    const apiRoot = storeType === 'brand'
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

        if (state.channel && state.channel.channelUid) out.channelUid = state.channel.channelUid;

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
          }));
          return { id, counts };
        })
      );

      for (const { id, counts } of batchResults) {
        const recent = counts.recent || 0;
        const cumul = counts.cumul || 0;
        const purchase = counts.purchase || 0;

        productMap[id].purchase_count = recent || purchase || cumul || 0;
        productMap[id].total_purchase_count = cumul || purchase || recent || 0;
        productMap[id].debug_purchase_source = (counts.matchedSources || []).join(' | ');

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
