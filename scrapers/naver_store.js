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
};

// ============ SCRAPE v17: brand store + proxy HTTP API (no browser page!) ============
async function scrape(params) {
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
  var storeName = params.store_name || storeSlug;
  var result = { status: 'OK', data: [], channel_uid: '', error: null, method_used: '', debug: {} };

  var proxy = null;
  if (params.proxy_host && params.proxy_port) {
    proxy = { server: 'http://' + params.proxy_host + ':' + params.proxy_port };
    if (params.proxy_user && params.proxy_pass) {
      proxy.username = params.proxy_user;
      proxy.password = params.proxy_pass;
    }
    result.debug.proxyEnabled = true;
  }

  var br = await getBrowser();
  var ctx = await br.newContext(ctxOpts());
  var page = await ctx.newPage();
  await page.addInitScript(stealth);

  try {
    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    // ===== PHASE 1+2: 브랜드스토어 (프록시 없이) =====
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v17] P1: ' + targetUrl);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    var prevHeight = 0;
    for (var si = 0; si < 5; si++) {
      await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
      await page.waitForTimeout(1500);
      var curHeight = await page.evaluate(function() { return document.body.scrollHeight; });
      if (curHeight === prevHeight) break;
      prevHeight = curHeight;
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
        if (state.categoryMenu && state.categoryMenu.firstCategories) {
          var cats = state.categoryMenu.firstCategories;
          for (var ci = 0; ci < cats.length; ci++) {
            if (cats[ci].mappingConfig && cats[ci].mappingConfig.mappingType === 'PRODUCT') {
              var ids = (cats[ci].mappingConfig.mappingContent || '').split('|');
              for (var mi = 0; mi < ids.length; mi++) if (ids[mi]) idSet[ids[mi]] = true;
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

    var productMap = {};
    if (stateInfo.channelUid && stateInfo.allIds.length > 0) {
      var batchSize = 20;
      for (var bi = 0; bi < stateInfo.allIds.length; bi += batchSize) {
        var batch = stateInfo.allIds.slice(bi, bi + batchSize);
        try {
          var apiResult = await page.evaluate(function(args) {
            var params = args.ids.map(function(id) { return 'ids[]=' + id; }).join('&');
            return fetch('https://brand.naver.com/n/v2/channels/' + args.uid + '/simple-products?' + params, { credentials: 'include' })
              .then(function(r) { return r.ok ? r.json() : null; })
              .catch(function() { return null; });
          }, { uid: stateInfo.channelUid, ids: batch });

          if (Array.isArray(apiResult)) {
            for (var ai = 0; ai < apiResult.length; ai++) {
              var p = apiResult[ai];
              var pid = String(p.id || '');
              if (!pid) continue;
              var rc = 0;
              if (p.reviewAmount && typeof p.reviewAmount === 'object') rc = p.reviewAmount.totalReviewCount || 0;
              var dp = null;
              if (p.benefitsView && p.benefitsView.discountedSalePrice) dp = p.benefitsView.discountedSalePrice;
              productMap[pid] = {
                product_id: pid,
                product_name: p.name || p.dispName || '',
                sale_price: p.salePrice || 0,
                discount_price: dp,
                review_count: rc,
                purchase_count: 0,
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
    await page.close();
    await ctx.close();

    // ===== PHASE 3: 프록시로 순수 HTTP 요청 (페이지 렌더링 없음!) =====
    var purchaseMap = {};
    var searchDebug = { totalItems: 0, matched: 0, errors: [], method: 'api_request' };

    if (proxy) {
      try {
        console.log('[v17] P3: using APIRequestContext with proxy');

        // 프록시 설정된 새 브라우저 컨텍스트의 request API 사용
        // 이건 페이지를 열지 않고 순수 HTTP 요청만 보냄 — headless 감지 불가!
        var proxyBrowser = await chromium.launch({
          headless: true,
          proxy: proxy,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        var apiCtx = await proxyBrowser.newContext({
          userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          extraHTTPHeaders: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': 'https://search.shopping.naver.com/search/all?query=' + encodeURIComponent(storeName),
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin'
          }
        });

        var apiUrl = 'https://search.shopping.naver.com/api/search/all?sort=rel&pagingIndex=1&pagingSize=80&viewType=list&query=' + encodeURIComponent(storeName);
        console.log('[v17] P3: requesting ' + apiUrl);

        var response = await apiCtx.request.get(apiUrl);
        searchDebug.status = response.status();

        if (response.ok()) {
          var data = await response.json();
          searchDebug.responseKeys = Object.keys(data).slice(0, 20);

          var items = [];
          if (data.shoppingResult && data.shoppingResult.products) {
            items = data.shoppingResult.products;
            searchDebug.source = 'shoppingResult.products';
          } else if (data.products) {
            items = data.products;
            searchDebug.source = 'products';
          }

          searchDebug.totalItems = items.length;

          if (items.length > 0) {
            searchDebug.firstItemKeys = Object.keys(items[0]).slice(0, 40);
            // purchase 관련 필드
            var fp = items[0];
            var pf = {};
            var fKeys = Object.keys(fp);
            for (var fk = 0; fk < fKeys.length; fk++) {
              var key = fKeys[fk];
              var lower = key.toLowerCase();
              if (lower.indexOf('purchase') > -1 || lower.indexOf('count') > -1 ||
                  lower.indexOf('cumul') > -1 || lower.indexOf('mall') > -1 ||
                  lower.indexOf('channel') > -1) {
                pf[key] = typeof fp[key] === 'object' ? JSON.stringify(fp[key]).slice(0, 100) : fp[key];
              }
            }
            searchDebug.purchaseFields = pf;
            searchDebug.sampleItems = items.slice(0, 3).map(function(item) {
              return {
                cpn: String(item.channelProductNo || ''),
                mpid: String(item.mallProductId || ''),
                pc: item.purchaseCnt || item.purchaseCount || 0,
                name: (item.productName || item.productTitle || '').slice(0, 40)
              };
            });
          }

          for (var ii = 0; ii < items.length; ii++) {
            var item = items[ii];
            var pc = item.purchaseCnt || item.purchaseCount || 0;
            var cpn = String(item.channelProductNo || '');
            var mpid = String(item.mallProductId || '');
            var pno = String(item.productNo || item.id || '');
            if (pc > 0) {
              if (cpn) purchaseMap[cpn] = pc;
              if (mpid) purchaseMap[mpid] = pc;
              if (pno) purchaseMap[pno] = pc;
              searchDebug.matched++;
            }
          }
        } else {
          searchDebug.error = 'HTTP ' + response.status();
          // 응답 body 일부 캡처
          try {
            var bodyText = await response.text();
            searchDebug.errorBody = bodyText.slice(0, 300);
          } catch(e) {}
        }

        console.log('[v17] P3: status=' + searchDebug.status + ', items=' + searchDebug.totalItems + ', matched=' + searchDebug.matched);

        await apiCtx.dispose();
        await proxyBrowser.close();
      } catch(searchErr) {
        searchDebug.errors.push(searchErr.message || String(searchErr));
        console.log('[v17] P3 error: ' + searchErr.message);
      }
    } else {
      searchDebug.errors.push('no proxy');
    }

    result.debug.search = searchDebug;

    // ===== PHASE 4: 병합 =====
    result.method_used = proxy ? 'api+http_proxy' : 'api_only';
    var pids = Object.keys(productMap);
    for (var fi = 0; fi < pids.length; fi++) {
      var prod = productMap[pids[fi]];
      if (purchaseMap[prod.product_id]) prod.purchase_count = purchaseMap[prod.product_id];
      result.data.push(prod);
    }

    result.debug.total = result.data.length;
    result.debug.withPurchase = 0;
    for (var ci = 0; ci < result.data.length; ci++) {
      if (result.data[ci].purchase_count > 0) result.debug.withPurchase++;
    }

    if (result.data.length === 0) { result.status = 'EMPTY'; result.error = 'No products found'; }
  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message || String(e);
    try { await page.close(); await ctx.close(); } catch(x) {}
  }
  return result;
}

// ============ SPY ============
async function spy(params) {
  var url = params.url || 'https://www.naver.com';
  var proxy = null;
  if (params.proxy_host && params.proxy_port) {
    proxy = { server: 'http://' + params.proxy_host + ':' + params.proxy_port };
    if (params.proxy_user && params.proxy_pass) {
      proxy.username = params.proxy_user;
      proxy.password = params.proxy_pass;
    }
  }
  var br = await getBrowser();
  var ctx = await br.newContext(ctxOpts());
  var page = await ctx.newPage();
  var captured = [];
  page.on('response', async function(response) {
    try {
      var reqUrl = response.url();
      var ct = response.headers()['content-type'] || '';
      if (ct.indexOf('json') > -1 && response.status() === 200) {
        var body = await response.text();
        captured.push({
          url: reqUrl.length > 200 ? reqUrl.slice(0, 200) + '...' : reqUrl,
          status: response.status(), size: body.length,
          keys: (function() { try { return Object.keys(JSON.parse(body)).slice(0, 20); } catch(e) { return []; } })(),
          has_purchase: body.indexOf('urchase') > -1 || body.indexOf('saleCount') > -1,
          snippet: body.slice(0, 500)
        });
      }
    } catch(e) {}
  });
  try {
    await page.addInitScript(stealth);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
    return { status: 'OK', url: url, proxy: !!proxy, captured_count: captured.length, captured: captured };
  } catch(e) {
    return { status: 'ERROR', error: e.message, proxy: !!proxy, captured: captured };
  } finally {
    await page.close();
    await ctx.close();
  }
}

async function execute(action, req, res) {
  console.log('[naver_store] action=' + action);
  if (action === 'scrape') return res.json(await scrape(req.body));
  if (action === 'spy') return res.json(await spy(req.body));
  return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
}

module.exports = { execute };
