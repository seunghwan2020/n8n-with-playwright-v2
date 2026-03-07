const { chromium } = require('playwright');

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
    });
  }
  return browser;
}

function ctxOpts() {
  return {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' }
  };
}

var stealth = function() {
  Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
  Object.defineProperty(navigator, 'plugins', { get: function() { return [1, 2, 3, 4, 5]; } });
  Object.defineProperty(navigator, 'languages', { get: function() { return ['ko-KR', 'ko', 'en-US', 'en']; } });
  window.chrome = { runtime: {} };
};

// ============ SCRAPE v24: smartstore CORS fix + prefix-based classification ============
async function scrape(params) {
  var storeSlug = params.store_slug || 'dcurvin';
  var storeType = params.store_type || 'brand';
  var result = {
    status: 'OK', data: [], channel_uid: '', error: null,
    method_used: 'v24_smartstore_fix',
    debug: { build: 'V24_SMARTSTORE_FIX', storeSlug: storeSlug, storeType: storeType }
  };

  var br = null; var ctx = null; var page = null;

  try {
    br = await getBrowser();
    ctx = await br.newContext(ctxOpts());
    page = await ctx.newPage();
    await page.addInitScript(stealth);

    // ★ 핵심: baseUrl과 apiBase를 스토어 타입에 맞게 설정
    // smartstore 페이지에서 brand.naver.com API 호출하면 CORS 차단됨!
    var baseUrl, apiBase;
    if (storeType === 'smartstore') {
      baseUrl = 'https://smartstore.naver.com/' + storeSlug;
      apiBase = 'https://smartstore.naver.com';
    } else {
      baseUrl = 'https://brand.naver.com/' + storeSlug;
      apiBase = 'https://brand.naver.com';
    }

    // ===== PHASE 1: 상품 ID 수집 =====
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v24] P1: ' + targetUrl);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    for (var si = 0; si < 5; si++) {
      try { await page.evaluate(function() { if (document.body) window.scrollTo(0, document.body.scrollHeight); }); } catch(e) { break; }
      await page.waitForTimeout(1500);
    }

    // page 2 도 시도 (상품이 많은 스토어)
    var page2Url = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=2&size=80';
    var page2Ids = [];
    try {
      var p2 = await ctx.newPage();
      await p2.addInitScript(stealth);
      await p2.goto(page2Url, { waitUntil: 'networkidle', timeout: 20000 });
      page2Ids = await p2.evaluate(function() {
        var ids = [];
        try {
          var state = window.__PRELOADED_STATE__;
          if (state && state.categoryProducts && state.categoryProducts.simpleProducts) {
            var sp = state.categoryProducts.simpleProducts;
            for (var i = 0; i < sp.length; i++) {
              var pid = typeof sp[i] === 'object' ? String(sp[i].id || '') : String(sp[i]);
              if (pid) ids.push(pid);
            }
          }
        } catch(e) {}
        return ids;
      });
      await p2.close();
    } catch(e) { /* page 2 실패해도 무시 */ }

    var stateInfo = await page.evaluate(function() {
      var out = { channelUid: '', allIds: [] };
      try {
        var state = window.__PRELOADED_STATE__;
        if (!state) return out;
        if (state.channel && state.channel.channelUid) out.channelUid = state.channel.channelUid;
        var idSet = {};
        if (state.categoryProducts && state.categoryProducts.simpleProducts) {
          var sp = state.categoryProducts.simpleProducts;
          for (var i = 0; i < sp.length; i++) {
            var pid = typeof sp[i] === 'object' ? String(sp[i].id || '') : String(sp[i]);
            if (pid) idSet[pid] = true;
          }
        }
        if (state.homeSetting && state.homeSetting.widgets) {
          var wKeys = Object.keys(state.homeSetting.widgets);
          for (var wi = 0; wi < wKeys.length; wi++) {
            var w = state.homeSetting.widgets[wKeys[wi]];
            if (w && w.productNos) {
              for (var pi = 0; pi < w.productNos.length; pi++) idSet[String(w.productNos[pi])] = true;
            }
          }
        }
        var links = document.querySelectorAll('a[href*="/products/"]');
        for (var li = 0; li < links.length; li++) {
          var m = (links[li].getAttribute('href') || '').match(/products\/(\d+)/);
          if (m) idSet[m[1]] = true;
        }
        out.allIds = Object.keys(idSet);
      } catch(e) {}
      return out;
    });

    // page2 ID 합치기
    for (var p2i = 0; p2i < page2Ids.length; p2i++) {
      if (stateInfo.allIds.indexOf(page2Ids[p2i]) === -1) {
        stateInfo.allIds.push(page2Ids[p2i]);
      }
    }

    result.channel_uid = stateInfo.channelUid;
    result.debug.totalIds = stateInfo.allIds.length;
    result.debug.page2Ids = page2Ids.length;

    // ===== PHASE 2: simple-products API =====
    // ★ apiBase를 사용 (brand/smartstore 동적!)
    var productMap = {};
    var productNoMap = {};

    if (stateInfo.channelUid && stateInfo.allIds.length > 0) {
      var batchSize = 20;
      for (var bi = 0; bi < stateInfo.allIds.length; bi += batchSize) {
        var batch = stateInfo.allIds.slice(bi, bi + batchSize);
        try {
          var apiResult = await page.evaluate(function(args) {
            var qs = args.ids.map(function(id) { return 'ids[]=' + id; }).join('&');
            // ★ args.apiBase 사용 — smartstore면 smartstore 도메인!
            var url = args.apiBase + '/n/v2/channels/' + args.uid + '/simple-products?' + qs
              + '&useChannelProducts=false&excludeAuthBlind=false&excludeDisplayableFilter=false&forceOrder=true';
            return fetch(url, { credentials: 'include' })
              .then(function(r) { return r.ok ? r.json() : null; })
              .catch(function() { return null; });
          }, { uid: stateInfo.channelUid, ids: batch, apiBase: apiBase });

          if (Array.isArray(apiResult)) {
            for (var ai = 0; ai < apiResult.length; ai++) {
              var p = apiResult[ai];
              var pid = String(p.id || '');
              if (!pid) continue;
              var rc = 0;
              if (p.reviewAmount && typeof p.reviewAmount === 'object') rc = p.reviewAmount.totalReviewCount || 0;
              var dp = null;
              if (p.benefitsView && p.benefitsView.discountedSalePrice) dp = p.benefitsView.discountedSalePrice;
              var pno = String(p.productNo || '');
              if (pno) productNoMap[pid] = pno;

              productMap[pid] = {
                product_id: pid,
                product_name: p.name || p.dispName || '',
                sale_price: p.salePrice || 0,
                discount_price: dp,
                review_count: rc,
                purchase_count_today: 0, purchase_text_today: '', purchase_prefix_today: '',
                purchase_count_weekly: 0, purchase_text_weekly: '', purchase_prefix_weekly: '',
                product_image_url: (p.representativeImageUrl || '').split('?')[0],
                category_name: p.category ? (p.category.wholeCategoryName || '') : '',
                is_sold_out: (p.productStatusType === 'OUTOFSTOCK') || (p.soldout === true) || false,
                product_url: baseUrl + '/products/' + pid
              };
            }
          }
        } catch(e) {}
        if (bi + batchSize < stateInfo.allIds.length) await page.waitForTimeout(200);
      }
    }

    result.debug.apiProducts = Object.keys(productMap).length;
    result.debug.productNoMapped = Object.keys(productNoMap).length;

    // ===== PHASE 3: marketing-message API (basis=1, basis=2) =====
    // ★ apiBase 사용!
    var purchaseDebug = { total: 0, todayCount: 0, weeklyCount: 0, ignoredCumul: 0, errors: [], samples: [] };
    var allPids = Object.keys(productMap);
    console.log('[v24] P3: marketing-message for ' + allPids.length + ' products');

    async function fetchMsg(productNoId, basis) {
      try {
        var msgResult = await page.evaluate(function(args) {
          // ★ args.apiBase 사용!
          var url = args.apiBase + '/n/v1/marketing-message/' + args.id
            + '?currentPurchaseType=Paid&usePurchased=true&basisPurchased=1'
            + '&usePurchasedIn2Y=true&useRepurchased=true&basisRepurchased=' + args.basis;
          return fetch(url, { credentials: 'include' })
            .then(function(r) {
              if (!r.ok) return { ok: false, status: r.status };
              return r.json().then(function(data) { return { ok: true, data: data }; });
            })
            .catch(function(err) { return { ok: false, error: String(err) }; });
        }, { id: productNoId, basis: basis, apiBase: apiBase });

        if (msgResult && msgResult.ok && msgResult.data) {
          var phrase = msgResult.data.mainPhrase || '';
          var prefix = msgResult.data.prefix || '';
          var count = 0;
          var numMatch = phrase.match(/(\d[\d,]*)\s*\uBA85/);
          if (numMatch) count = parseInt(numMatch[1].replace(/,/g, ''));
          var isCumulative = phrase.indexOf('\uC774\uC0C1') > -1;
          return { ok: true, count: count, phrase: phrase, prefix: (prefix || '').trim(), isCumulative: isCumulative };
        }
        return { ok: false };
      } catch(e) { return { ok: false }; }
    }

    for (var mi = 0; mi < allPids.length; mi++) {
      var prodId = allPids[mi];
      var msgId = productNoMap[prodId] || prodId;
      purchaseDebug.total++;

      var r1 = await fetchMsg(msgId, 1);
      var r2 = await fetchMsg(msgId, 2);

      // ===== prefix 기반 분류 =====
      // "이상 구매" → 누적, 무시
      // prefix "오늘" → today
      // prefix "최근" → weekly
      // prefix 없고 "이상" 없음 → weekly fallback

      var allR = [];
      if (r1.ok) allR.push(r1);
      if (r2.ok) allR.push(r2);

      for (var ri = 0; ri < allR.length; ri++) {
        var r = allR[ri];
        if (r.isCumulative) { purchaseDebug.ignoredCumul++; continue; }

        var pfx = r.prefix;
        if (pfx.indexOf('\uC624\uB298') > -1) {
          // "오늘" → today
          productMap[prodId].purchase_count_today = r.count;
          productMap[prodId].purchase_text_today = r.phrase;
          productMap[prodId].purchase_prefix_today = pfx;
          purchaseDebug.todayCount++;
        } else if (pfx.indexOf('\uCD5C\uADFC') > -1) {
          // "최근 1주간" → weekly
          productMap[prodId].purchase_count_weekly = r.count;
          productMap[prodId].purchase_text_weekly = r.phrase;
          productMap[prodId].purchase_prefix_weekly = pfx;
          purchaseDebug.weeklyCount++;
        } else if (pfx === '' && !r.isCumulative) {
          // prefix 없고 "이상" 아닌 정확한 수치 → weekly fallback
          if (r.count > productMap[prodId].purchase_count_weekly) {
            productMap[prodId].purchase_count_weekly = r.count;
            productMap[prodId].purchase_text_weekly = r.phrase;
            productMap[prodId].purchase_prefix_weekly = 'auto';
            purchaseDebug.weeklyCount++;
          }
        }
      }

      if (purchaseDebug.samples.length < 5) {
        purchaseDebug.samples.push({
          pid: prodId, msgId: msgId,
          r1: r1.ok ? { pfx: r1.prefix, phrase: r1.phrase, cumul: r1.isCumulative } : 'fail',
          r2: r2.ok ? { pfx: r2.prefix, phrase: r2.phrase, cumul: r2.isCumulative } : 'fail',
          today: productMap[prodId].purchase_count_today,
          weekly: productMap[prodId].purchase_count_weekly
        });
      }

      if (!r1.ok && !r2.ok && purchaseDebug.errors.length < 3) {
        purchaseDebug.errors.push({ pid: prodId, msgId: msgId });
      }

      if (mi > 0 && mi % 5 === 0) await page.waitForTimeout(300);
    }

    result.debug.purchase = purchaseDebug;
    console.log('[v24] P3: today=' + purchaseDebug.todayCount + ', weekly=' + purchaseDebug.weeklyCount + ', ignored=' + purchaseDebug.ignoredCumul);

    // ===== PHASE 4: 결과 =====
    var pids = Object.keys(productMap);
    for (var fi = 0; fi < pids.length; fi++) {
      var prod = productMap[pids[fi]];
      result.data.push({
        product_id: prod.product_id, product_name: prod.product_name,
        sale_price: prod.sale_price, discount_price: prod.discount_price,
        review_count: prod.review_count,
        purchase_count_today: prod.purchase_count_today,
        purchase_text_today: prod.purchase_text_today,
        purchase_prefix_today: prod.purchase_prefix_today,
        purchase_count_weekly: prod.purchase_count_weekly,
        purchase_text_weekly: prod.purchase_text_weekly,
        purchase_prefix_weekly: prod.purchase_prefix_weekly,
        product_image_url: prod.product_image_url, category_name: prod.category_name,
        is_sold_out: prod.is_sold_out, product_url: prod.product_url
      });
    }

    result.debug.total = result.data.length;
    if (result.data.length === 0) { result.status = 'EMPTY'; result.error = 'No products found'; }
  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message || String(e);
  } finally {
    try { if (page) await page.close(); } catch(x) {}
    try { if (ctx) await ctx.close(); } catch(x) {}
  }
  return result;
}

// ============ SPY ============
async function spy(params) {
  var url = params.url || 'https://brand.naver.com/dcurvin/products/12569074482';
  var br = null; var ctx = null; var page = null; var captured = [];
  try {
    br = await getBrowser(); ctx = await br.newContext(ctxOpts()); page = await ctx.newPage();
    page.on('response', async function(response) {
      try {
        var reqUrl = response.url(); var ct = response.headers()['content-type'] || '';
        if (ct.indexOf('json') > -1 && response.status() === 200) {
          var body = await response.text();
          captured.push({ url: reqUrl.length > 200 ? reqUrl.slice(0, 200) + '...' : reqUrl, status: response.status(), size: body.length, snippet: body.slice(0, 500) });
        }
      } catch(e) {}
    });
    await page.addInitScript(stealth);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
    return { status: 'OK', url: url, captured_count: captured.length, captured: captured };
  } catch(e) { return { status: 'ERROR', error: e.message, captured: captured };
  } finally { try { if (page) await page.close(); } catch(x) {} try { if (ctx) await ctx.close(); } catch(x) {} }
}

async function execute(action, req, res) {
  console.log('[naver_store v24] action=' + action);
  try {
    if (action === 'scrape') return res.json(await scrape(req.body));
    if (action === 'spy') return res.json(await spy(req.body));
    return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
  } catch(e) { if (!res.headersSent) return res.status(500).json({ status: 'ERROR', error: e.message || String(e) }); }
}

module.exports = { execute };
