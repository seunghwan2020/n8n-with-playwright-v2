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

// ============ SCRAPE v20: 오늘 + 주간 구매건수 분리 수집 ============
async function scrape(params) {
  var storeSlug = params.store_slug || 'dcurvin';
  var storeType = params.store_type || 'brand';
  var result = {
    status: 'OK',
    data: [],
    channel_uid: '',
    error: null,
    method_used: 'v22_prefix_based',
    debug: { build: 'V22_PREFIX_BASED' }
  };

  var br = null;
  var ctx = null;
  var page = null;

  try {
    br = await getBrowser();
    ctx = await br.newContext(ctxOpts());
    page = await ctx.newPage();
    await page.addInitScript(stealth);

    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    // ===== PHASE 1: 상품 ID 수집 =====
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v22] P1: ' + targetUrl);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    for (var si = 0; si < 5; si++) {
      try {
        await page.evaluate(function() {
          if (document.body) window.scrollTo(0, document.body.scrollHeight);
        });
      } catch(e) { break; }
      await page.waitForTimeout(1500);
    }

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

    result.channel_uid = stateInfo.channelUid;
    result.debug.totalIds = stateInfo.allIds.length;

    // ===== PHASE 2: simple-products API =====
    var productMap = {};
    var productNoMap = {};

    if (stateInfo.channelUid && stateInfo.allIds.length > 0) {
      var batchSize = 20;
      for (var bi = 0; bi < stateInfo.allIds.length; bi += batchSize) {
        var batch = stateInfo.allIds.slice(bi, bi + batchSize);
        try {
          var apiResult = await page.evaluate(function(args) {
            var qs = args.ids.map(function(id) { return 'ids[]=' + id; }).join('&');
            var url = 'https://brand.naver.com/n/v2/channels/' + args.uid + '/simple-products?' + qs
              + '&useChannelProducts=false&excludeAuthBlind=false&excludeDisplayableFilter=false&forceOrder=true';
            return fetch(url, { credentials: 'include' })
              .then(function(r) { return r.ok ? r.json() : null; })
              .catch(function() { return null; });
          }, { uid: stateInfo.channelUid, ids: batch });

          if (Array.isArray(apiResult)) {
            for (var ai = 0; ai < apiResult.length; ai++) {
              var p = apiResult[ai];
              var pid = String(p.id || '');
              if (!pid) continue;

              var rc = 0;
              if (p.reviewAmount && typeof p.reviewAmount === 'object') {
                rc = p.reviewAmount.totalReviewCount || 0;
              }
              var dp = null;
              if (p.benefitsView && p.benefitsView.discountedSalePrice) {
                dp = p.benefitsView.discountedSalePrice;
              }

              var pno = String(p.productNo || '');
              if (pno) productNoMap[pid] = pno;

              productMap[pid] = {
                product_id: pid,
                product_name: p.name || p.dispName || '',
                sale_price: p.salePrice || 0,
                discount_price: dp,
                review_count: rc,
                purchase_count_today: 0,
                purchase_text_today: '',
                purchase_prefix_today: '',
                purchase_count_weekly: 0,
                purchase_text_weekly: '',
                purchase_prefix_weekly: '',
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

    // ===== PHASE 3: marketing-message API — 2회 호출 (오늘 + 주간) =====
    var purchaseDebug = { total: 0, todaySuccess: 0, weeklySuccess: 0, errors: [], samples: [] };
    var allPids = Object.keys(productMap);

    console.log('[v22] P3: marketing-message x2 for ' + allPids.length + ' products');

    // 호출 함수 (basisRepurchased 파라미터만 다름)
    // basisRepurchased=1: 짧은 기간 (보통 오늘)
    // basisRepurchased=2: 최근 1주간
    async function fetchPurchase(productNoId, basis) {
      try {
        var msgResult = await page.evaluate(function(args) {
          var url = 'https://brand.naver.com/n/v1/marketing-message/' + args.id
            + '?currentPurchaseType=Paid&usePurchased=true&basisPurchased=1'
            + '&usePurchasedIn2Y=true&useRepurchased=true&basisRepurchased=' + args.basis;
          return fetch(url, { credentials: 'include' })
            .then(function(r) {
              if (!r.ok) return { ok: false, status: r.status };
              return r.json().then(function(data) {
                return { ok: true, data: data };
              });
            })
            .catch(function(err) {
              return { ok: false, error: String(err) };
            });
        }, { id: productNoId, basis: basis });

        if (msgResult && msgResult.ok && msgResult.data) {
          var phrase = msgResult.data.mainPhrase || '';
          var prefix = msgResult.data.prefix || '';
          var count = 0;
          var numMatch = phrase.match(/(\d[\d,]*)\s*\uBA85/);
          if (numMatch) count = parseInt(numMatch[1].replace(/,/g, ''));
          return { ok: true, count: count, phrase: phrase, prefix: prefix };
        }
        return { ok: false };
      } catch(e) {
        return { ok: false, error: String(e).slice(0, 100) };
      }
    }

    for (var mi = 0; mi < allPids.length; mi++) {
      var prodId = allPids[mi];
      var msgId = productNoMap[prodId] || prodId;
      purchaseDebug.total++;

      // 호출 1: basisRepurchased=1, 호출 2: basisRepurchased=2
      var r1 = await fetchPurchase(msgId, 1);
      var r2 = await fetchPurchase(msgId, 2);

      // prefix 텍스트 기반으로 today/weekly 분류
      var allResults = [];
      if (r1.ok) { allResults.push(r1); purchaseDebug.todaySuccess++; }
      if (r2.ok) { allResults.push(r2); purchaseDebug.weeklySuccess++; }

      for (var ri = 0; ri < allResults.length; ri++) {
        var r = allResults[ri];
        var pfx = (r.prefix || '').trim();
        var isWeekly = pfx.indexOf('\uCD5C\uADFC') > -1;
        var isToday = pfx.indexOf('\uC624\uB298') > -1;

        if (isWeekly) {
          if (r.count >= productMap[prodId].purchase_count_weekly) {
            productMap[prodId].purchase_count_weekly = r.count;
            productMap[prodId].purchase_text_weekly = r.phrase;
            productMap[prodId].purchase_prefix_weekly = pfx;
          }
        } else if (isToday || pfx === '') {
          if (r.count >= productMap[prodId].purchase_count_today) {
            productMap[prodId].purchase_count_today = r.count;
            productMap[prodId].purchase_text_today = r.phrase;
            productMap[prodId].purchase_prefix_today = pfx || '';
          }
        } else {
          // prefix 알 수 없으면 큰 값 = weekly
          if (r.count >= productMap[prodId].purchase_count_weekly) {
            productMap[prodId].purchase_count_weekly = r.count;
            productMap[prodId].purchase_text_weekly = r.phrase;
            productMap[prodId].purchase_prefix_weekly = pfx;
          }
        }
      }

      // 디버그 샘플
      if (purchaseDebug.samples.length < 3) {
        purchaseDebug.samples.push({
          pid: prodId,
          msgId: msgId,
          today: todayResult.ok ? { prefix: todayResult.prefix, phrase: todayResult.phrase, count: todayResult.count } : 'fail',
          weekly: weeklyResult.ok ? { prefix: weeklyResult.prefix, phrase: weeklyResult.phrase, count: weeklyResult.count } : 'fail'
        });
      }

      // 에러 로깅
      if (!todayResult.ok && !weeklyResult.ok && purchaseDebug.errors.length < 3) {
        purchaseDebug.errors.push({ pid: prodId, msgId: msgId });
      }

      // Rate limit: 5개마다 300ms (2배 호출이니 좀 더 여유)
      if (mi > 0 && mi % 5 === 0) await page.waitForTimeout(300);
    }

    result.debug.purchase = purchaseDebug;
    console.log('[v22] P3 done: today=' + purchaseDebug.todaySuccess + ', weekly=' + purchaseDebug.weeklySuccess);

    // ===== PHASE 4: 결과 조립 =====
    var pids = Object.keys(productMap);
    for (var fi = 0; fi < pids.length; fi++) {
      var prod = productMap[pids[fi]];
      result.data.push({
        product_id: prod.product_id,
        product_name: prod.product_name,
        sale_price: prod.sale_price,
        discount_price: prod.discount_price,
        review_count: prod.review_count,
        purchase_count_today: prod.purchase_count_today,
        purchase_text_today: prod.purchase_text_today,
        purchase_prefix_today: prod.purchase_prefix_today,
        purchase_count_weekly: prod.purchase_count_weekly,
        purchase_text_weekly: prod.purchase_text_weekly,
        purchase_prefix_weekly: prod.purchase_prefix_weekly,
        product_image_url: prod.product_image_url,
        category_name: prod.category_name,
        is_sold_out: prod.is_sold_out,
        product_url: prod.product_url
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
  var br = null;
  var ctx = null;
  var page = null;
  var captured = [];

  try {
    br = await getBrowser();
    ctx = await br.newContext(ctxOpts());
    page = await ctx.newPage();
    page.on('response', async function(response) {
      try {
        var reqUrl = response.url();
        var ct = response.headers()['content-type'] || '';
        if (ct.indexOf('json') > -1 && response.status() === 200) {
          var body = await response.text();
          captured.push({
            url: reqUrl.length > 200 ? reqUrl.slice(0, 200) + '...' : reqUrl,
            status: response.status(),
            size: body.length,
            has_purchase: body.indexOf('\uAD6C\uB9E4') > -1,
            snippet: body.slice(0, 500)
          });
        }
      } catch(e) {}
    });
    await page.addInitScript(stealth);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
    return { status: 'OK', url: url, captured_count: captured.length, captured: captured };
  } catch(e) {
    return { status: 'ERROR', error: e.message, captured: captured };
  } finally {
    try { if (page) await page.close(); } catch(x) {}
    try { if (ctx) await ctx.close(); } catch(x) {}
  }
}

async function execute(action, req, res) {
  console.log('[naver_store v20] action=' + action);
  try {
    if (action === 'scrape') return res.json(await scrape(req.body));
    if (action === 'spy') return res.json(await spy(req.body));
    return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
  } catch(e) {
    if (!res.headersSent) {
      return res.status(500).json({ status: 'ERROR', error: e.message || String(e) });
    }
  }
}

module.exports = { execute };
