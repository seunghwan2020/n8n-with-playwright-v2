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

// ============ SCRAPE v25: isCumulative 버그 수정 + smartstore 개선 ============
async function scrape(params) {
  var storeSlug = params.store_slug || 'dcurvin';
  var storeType = params.store_type || 'brand';
  var result = {
    status: 'OK', data: [], channel_uid: '', error: null,
    method_used: 'v26.3_retry',
    debug: { build: 'V26.3_RETRY', storeSlug: storeSlug, storeType: storeType }
  };

  var br = null; var ctx = null; var page = null;

  try {
    br = await getBrowser();
    ctx = await br.newContext(ctxOpts());
    page = await ctx.newPage();
    await page.addInitScript(stealth);

    // ★ baseUrl과 apiBase를 스토어 타입에 맞게 설정
    var baseUrl, apiBase;
    if (storeType === 'smartstore') {
      baseUrl = 'https://smartstore.naver.com/' + storeSlug;
      // ★ v26.3: smartstore도 API는 brand.naver.com 사용!
      // 확장프로그램 분석: smartstore.naver.com → 실패, brand.naver.com → 성공
      apiBase = 'https://brand.naver.com';
    } else {
      baseUrl = 'https://brand.naver.com/' + storeSlug;
      apiBase = 'https://brand.naver.com';
    }

    // ===== PHASE 1: 상품 ID 수집 =====
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v25] P1: ' + targetUrl);

    // ★ smartstore는 networkidle 대신 domcontentloaded + 충분한 대기
    var waitStrategy = (storeType === 'smartstore') ? 'domcontentloaded' : 'networkidle';
    await page.goto(targetUrl, { waitUntil: waitStrategy, timeout: 45000 });
    await page.waitForTimeout(3000);

    // ★ smartstore: __NEXT_DATA__ 또는 __PRELOADED_STATE__ 로딩 대기
    if (storeType === 'smartstore') {
      try {
        await page.waitForFunction(function() {
          return window.__PRELOADED_STATE__ || window.__NEXT_DATA__;
        }, { timeout: 10000 });
      } catch(e) {
        console.log('[v25] smartstore state wait timeout, continuing...');
      }
      await page.waitForTimeout(2000);
    }

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
      await p2.goto(page2Url, { waitUntil: waitStrategy, timeout: 30000 });
      await p2.waitForTimeout(2000);
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
      var out = { channelUid: '', channelName: '', allIds: [], method: 'none' };
      try {
        var state = window.__PRELOADED_STATE__;
        if (!state) {
          out.method = 'no_preloaded_state';
          return out;
        }
        out.method = 'preloaded_state';
        if (state.channel) {
          if (state.channel.channelUid) out.channelUid = state.channel.channelUid;
          // ★ 브랜드명 자동 추출
          out.channelName = state.channel.channelName || state.channel.displayName || state.channel.name || '';
        }
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
      } catch(e) { out.method = 'error: ' + e.message; }
      return out;
    });

    // ★ smartstore fallback: __PRELOADED_STATE__ 실패 시 DOM에서 직접 추출
    if (stateInfo.allIds.length === 0 && storeType === 'smartstore') {
      console.log('[v25] smartstore fallback: DOM scraping');
      var domInfo = await page.evaluate(function(baseUrl) {
        var out = { channelUid: '', channelName: '', allIds: [], method: 'dom_fallback' };
        try {
          // channelUid, channelName을 스크립트에서 추출 시도
          var scripts = document.querySelectorAll('script');
          for (var si = 0; si < scripts.length; si++) {
            var txt = scripts[si].textContent || '';
            var uidMatch = txt.match(/"channelUid"\s*:\s*"([^"]+)"/);
            if (uidMatch && !out.channelUid) out.channelUid = uidMatch[1];
            var nameMatch = txt.match(/"channelName"\s*:\s*"([^"]+)"/);
            if (nameMatch && !out.channelName) out.channelName = nameMatch[1];
            if (out.channelUid && out.channelName) break;
          }
          // title 태그에서도 브랜드명 추출 시도
          if (!out.channelName) {
            var title = document.title || '';
            var colonIdx = title.indexOf(':');
            if (colonIdx > 0) out.channelName = title.substring(0, colonIdx).trim();
          }
          // DOM에서 상품 링크 추출
          var idSet = {};
          var links = document.querySelectorAll('a[href*="/products/"]');
          for (var li = 0; li < links.length; li++) {
            var m = (links[li].getAttribute('href') || '').match(/products\/(\d+)/);
            if (m) idSet[m[1]] = true;
          }
          // 이미지의 data-* 속성이나 product card에서도 시도
          var cards = document.querySelectorAll('[data-product-no], [data-nclick*="product"]');
          for (var ci = 0; ci < cards.length; ci++) {
            var pno = cards[ci].getAttribute('data-product-no');
            if (pno) idSet[pno] = true;
          }
          out.allIds = Object.keys(idSet);
        } catch(e) { out.method = 'dom_error: ' + e.message; }
        return out;
      }, baseUrl);

      if (domInfo.allIds.length > 0) {
        stateInfo = domInfo;
        if (domInfo.channelName) result.brand_name = domInfo.channelName;
        console.log('[v25] DOM fallback found ' + domInfo.allIds.length + ' products');
      }
    }

    // page2 ID 합치기
    for (var p2i = 0; p2i < page2Ids.length; p2i++) {
      if (stateInfo.allIds.indexOf(page2Ids[p2i]) === -1) {
        stateInfo.allIds.push(page2Ids[p2i]);
      }
    }

    result.channel_uid = stateInfo.channelUid;
    result.brand_name = stateInfo.channelName || '';
    result.debug.totalIds = stateInfo.allIds.length;
    result.debug.page2Ids = page2Ids.length;
    result.debug.stateMethod = stateInfo.method;

    // ★ v26.3: smartstore는 brand.naver.com 페이지를 열어서 API 호출 (CORS 우회)
    var apiPage = page; // brand store는 그대로 사용
    if (storeType === 'smartstore' && stateInfo.channelUid) {
      try {
        apiPage = await ctx.newPage();
        await apiPage.addInitScript(stealth);
        // brand.naver.com의 아무 페이지나 열면 됨 (API만 사용할 거라서)
        await apiPage.goto('https://brand.naver.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await apiPage.waitForTimeout(1000);
        console.log('[v26.3] smartstore: opened brand.naver.com API page');
      } catch(e) {
        console.log('[v26.3] smartstore: brand page open failed, using original page');
        apiPage = page; // 실패하면 원래 페이지 사용
      }
    }

    // ===== PHASE 2: simple-products API =====
    // ★ v25.1: smartstore는 API 경로가 다름 + __PRELOADED_STATE__ fallback
    var productMap = {};
    var productNoMap = {};

    // ★ smartstore는 먼저 __PRELOADED_STATE__에서 직접 상품 데이터 추출 시도
    if (storeType === 'smartstore') {
      console.log('[v25] smartstore: extracting products from __PRELOADED_STATE__');
      var stateProducts = await page.evaluate(function(baseUrl) {
        var out = { products: [], productNoMap: {} };
        try {
          var state = window.__PRELOADED_STATE__;
          if (!state) return out;

          // categoryProducts.simpleProducts에 상품 객체가 있는 경우
          var sp = (state.categoryProducts && state.categoryProducts.simpleProducts) || [];
          for (var i = 0; i < sp.length; i++) {
            var p = sp[i];
            if (typeof p !== 'object' || !p) continue;
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
            if (pno) out.productNoMap[pid] = pno;
            out.products.push({
              product_id: pid,
              product_name: p.name || p.dispName || '',
              sale_price: p.salePrice || 0,
              discount_price: dp,
              review_count: rc,
              product_image_url: (p.representativeImageUrl || '').split('?')[0],
              category_name: p.category ? (p.category.wholeCategoryName || '') : '',
              is_sold_out: (p.productStatusType === 'OUTOFSTOCK') || (p.soldout === true) || false,
              product_url: baseUrl + '/products/' + pid,
              productNo: pno
            });
          }

          // products 객체에서도 시도 (다른 state 구조)
          if (out.products.length === 0 && state.products) {
            var pKeys = Object.keys(state.products);
            for (var pi = 0; pi < pKeys.length; pi++) {
              var pp = state.products[pKeys[pi]];
              if (!pp || typeof pp !== 'object') continue;
              var ppid = String(pp.id || pp.productId || pKeys[pi]);
              var prc = 0;
              if (pp.reviewAmount) prc = pp.reviewAmount.totalReviewCount || 0;
              var pdp = null;
              if (pp.benefitsView && pp.benefitsView.discountedSalePrice) pdp = pp.benefitsView.discountedSalePrice;
              var ppno = String(pp.productNo || '');
              if (ppno) out.productNoMap[ppid] = ppno;
              out.products.push({
                product_id: ppid,
                product_name: pp.name || pp.dispName || '',
                sale_price: pp.salePrice || 0,
                discount_price: pdp,
                review_count: prc,
                product_image_url: (pp.representativeImageUrl || '').split('?')[0],
                category_name: '',
                is_sold_out: (pp.productStatusType === 'OUTOFSTOCK') || (pp.soldout === true) || false,
                product_url: baseUrl + '/products/' + ppid,
                productNo: ppno
              });
            }
          }
        } catch(e) {}
        return out;
      }, baseUrl);

      console.log('[v25] smartstore state products: ' + stateProducts.products.length);

      if (stateProducts.products.length > 0) {
        for (var spi = 0; spi < stateProducts.products.length; spi++) {
          var sp = stateProducts.products[spi];
          productMap[sp.product_id] = {
            product_id: sp.product_id,
            product_name: sp.product_name,
            sale_price: sp.sale_price,
            discount_price: sp.discount_price,
            review_count: sp.review_count,
            purchase_count_today: 0, purchase_text_today: '', purchase_prefix_today: '',
            purchase_count_weekly: 0, purchase_text_weekly: '', purchase_prefix_weekly: '',
            product_image_url: sp.product_image_url,
            category_name: sp.category_name,
            is_sold_out: sp.is_sold_out,
            product_url: sp.product_url
          };
          if (sp.productNo) productNoMap[sp.product_id] = sp.productNo;
        }
        Object.assign(productNoMap, stateProducts.productNoMap);
      }
    }

    // ★ brand store이거나, smartstore에서 state 추출 실패 시 API 호출
    if (Object.keys(productMap).length === 0 && stateInfo.channelUid && stateInfo.allIds.length > 0) {
      // smartstore는 여러 API 경로 시도
      var apiPaths = ['/n/v2/channels/'];

      var batchSize = 20;
      for (var pathIdx = 0; pathIdx < apiPaths.length; pathIdx++) {
        var currentPath = apiPaths[pathIdx];
        var pathWorked = false;

        for (var bi = 0; bi < stateInfo.allIds.length; bi += batchSize) {
          var batch = stateInfo.allIds.slice(bi, bi + batchSize);
          try {
            var apiResult = await apiPage.evaluate(function(args) {
              var qs = args.ids.map(function(id) { return 'ids[]=' + id; }).join('&');
              var url = args.apiBase + args.path + args.uid + '/simple-products?' + qs
                + '&useChannelProducts=false&excludeAuthBlind=false&excludeDisplayableFilter=false&forceOrder=true';
              return fetch(url, { credentials: 'include' })
                .then(function(r) { return r.ok ? r.json() : { _failed: true, _status: r.status }; })
                .catch(function(e) { return { _failed: true, _error: String(e) }; });
            }, { uid: stateInfo.channelUid, ids: batch, apiBase: apiBase, path: currentPath });

            if (apiResult && apiResult._failed) {
              console.log('[v25] API path ' + currentPath + ' failed: ' + (apiResult._status || apiResult._error));
              break; // 이 경로는 실패, 다음 경로 시도
            }

            if (Array.isArray(apiResult)) {
              pathWorked = true;
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
          if (bi + batchSize < stateInfo.allIds.length) await apiPage.waitForTimeout(200);
        }

        if (pathWorked) {
          console.log('[v25] API path worked: ' + currentPath + ', products: ' + Object.keys(productMap).length);
          result.debug.apiPathUsed = currentPath;
          break;
        }
      }
    }

    result.debug.apiProducts = Object.keys(productMap).length;
    result.debug.productNoMapped = Object.keys(productNoMap).length;

    // ===== PHASE 3: marketing-message API =====
    // ★★★ v26.2: basis=1과 basis=2를 Promise.all로 동시 호출
    // basis=1 → "오늘 N명" or "최근 1주간 M명"
    // basis=2 → "최근 1주간 M명" (오늘 1명일 때) or "오늘 N명" (오늘 >1일 때)
    // 오늘 >1이면 추가로 basis=(count+1) 호출
    // → 대부분 상품 1회 evaluate (2 fetch 동시), 최대 2회 ★★★
    var purchaseDebug = { total: 0, todayCount: 0, weeklyCount: 0, ignoredCumul: 0, errors: [], samples: [] };
    var allPids = Object.keys(productMap);
    console.log('[v26.3] P3: marketing-message for ' + allPids.length + ' products');

    var msgApiPath = '/n/v1/marketing-message/';

    function parseMsgData(data) {
      if (!data || !data.mainPhrase) return null;
      var phrase = data.mainPhrase || '';
      var prefix = (data.prefix || '').trim();
      var count = 0;
      var nm = phrase.match(/(\d[\d,]*)\s*\uBA85/);
      if (nm) count = parseInt(nm[1].replace(/,/g, ''));
      var isToday = prefix.indexOf('\uC624\uB298') > -1;
      var isWeekly = prefix.indexOf('\uCD5C\uADFC') > -1;
      return { count: count, phrase: phrase, prefix: prefix, isToday: isToday, isWeekly: isWeekly };
    }

    for (var mi = 0; mi < allPids.length; mi++) {
      var prodId = allPids[mi];
      var msgId = productNoMap[prodId] || prodId;
      purchaseDebug.total++;

      // ★ Step 1: basis=1 과 basis=2를 동시에 호출 (자동 3회 재시도)
      var bothResults = await apiPage.evaluate(function(args) {
        function doFetch(basis, retry) {
          retry = retry || 0;
          var url = args.apiBase + args.path + args.id
            + '?currentPurchaseType=Paid&usePurchased=true&basisPurchased=1'
            + '&usePurchasedIn2Y=true&useRepurchased=true&basisRepurchased=' + basis;
          return fetch(url, { credentials: 'include' })
            .then(function(r) {
              if (!r.ok) {
                if (retry < 2) return new Promise(function(res) { setTimeout(res, 300); }).then(function() { return doFetch(basis, retry + 1); });
                return { ok: false, basis: basis, status: r.status };
              }
              return r.json().then(function(data) { return { ok: true, basis: basis, data: data }; });
            })
            .catch(function(e) {
              if (retry < 2) return new Promise(function(res) { setTimeout(res, 300); }).then(function() { return doFetch(basis, retry + 1); });
              return { ok: false, basis: basis, error: String(e) };
            });
        }
        return Promise.all([doFetch(1), doFetch(2)]);
      }, { id: msgId, apiBase: apiBase, path: msgApiPath });

      var r1 = bothResults[0].ok ? parseMsgData(bothResults[0].data) : null;
      var r2 = bothResults[1].ok ? parseMsgData(bothResults[1].data) : null;

      var todayResult = null;
      var weeklyResult = null;

      // ★ r1 (basis=1) 분석
      if (r1 && r1.count > 0) {
        if (r1.isToday) todayResult = r1;
        else if (r1.isWeekly) weeklyResult = r1;
      }

      // ★ r2 (basis=2) 분석
      if (r2 && r2.count > 0) {
        if (r2.isToday && !todayResult) todayResult = r2;
        else if (r2.isWeekly && !weeklyResult) weeklyResult = r2;
      }

      // ★ 오늘 count > 1인 경우: basis=(count+1)로 추가 호출 필요
      if (todayResult && todayResult.count > 1 && !weeklyResult) {
        var exactBasis = todayResult.count + 1;
        var r3 = await apiPage.evaluate(function(args) {
          function doFetch(retry) {
            retry = retry || 0;
            var url = args.apiBase + args.path + args.id
              + '?currentPurchaseType=Paid&usePurchased=true&basisPurchased=1'
              + '&usePurchasedIn2Y=true&useRepurchased=true&basisRepurchased=' + args.basis;
            return fetch(url, { credentials: 'include' })
              .then(function(r) {
                if (!r.ok) {
                  if (retry < 2) return new Promise(function(res) { setTimeout(res, 300); }).then(function() { return doFetch(retry + 1); });
                  return { ok: false };
                }
                return r.json().then(function(data) { return { ok: true, data: data }; });
              })
              .catch(function() {
                if (retry < 2) return new Promise(function(res) { setTimeout(res, 300); }).then(function() { return doFetch(retry + 1); });
                return { ok: false };
              });
          }
          return doFetch(0);
        }, { id: msgId, apiBase: apiBase, path: msgApiPath, basis: exactBasis });

        var p3 = r3.ok ? parseMsgData(r3.data) : null;
        if (p3 && p3.count > 0 && p3.isWeekly) {
          weeklyResult = p3;
        }
      }

      // ★ 결과 저장
      if (todayResult) {
        productMap[prodId].purchase_count_today = todayResult.count;
        productMap[prodId].purchase_text_today = todayResult.phrase;
        productMap[prodId].purchase_prefix_today = todayResult.prefix;
        purchaseDebug.todayCount++;
      }
      if (weeklyResult) {
        productMap[prodId].purchase_count_weekly = weeklyResult.count;
        productMap[prodId].purchase_text_weekly = weeklyResult.phrase;
        productMap[prodId].purchase_prefix_weekly = weeklyResult.prefix;
        purchaseDebug.weeklyCount++;
      }
      if (!todayResult && !weeklyResult) {
        purchaseDebug.ignoredCumul++;
      }

      if (purchaseDebug.samples.length < 8) {
        purchaseDebug.samples.push({
          pid: prodId, msgId: msgId,
          r1: r1 ? { pfx: r1.prefix, count: r1.count, isT: r1.isToday, isW: r1.isWeekly } : 'fail',
          r2: r2 ? { pfx: r2.prefix, count: r2.count, isT: r2.isToday, isW: r2.isWeekly } : 'fail',
          today: productMap[prodId].purchase_count_today,
          weekly: productMap[prodId].purchase_count_weekly
        });
      }

      if (!todayResult && !weeklyResult && purchaseDebug.errors.length < 5) {
        purchaseDebug.errors.push({ pid: prodId, msgId: msgId });
      }

      // 10개 상품마다 200ms 대기
      if (mi > 0 && mi % 10 === 0) await apiPage.waitForTimeout(200);
    }

    result.debug.purchase = purchaseDebug;
    console.log('[v26.3] P3: today=' + purchaseDebug.todayCount + ', weekly=' + purchaseDebug.weeklyCount + ', ignored=' + purchaseDebug.ignoredCumul);

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
    try { if (apiPage && apiPage !== page) await apiPage.close(); } catch(x) {}
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
  console.log('[naver_store v26.3] action=' + action);
  try {
    if (action === 'scrape') return res.json(await scrape(req.body));
    if (action === 'spy') return res.json(await spy(req.body));
    return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
  } catch(e) { if (!res.headersSent) return res.status(500).json({ status: 'ERROR', error: e.message || String(e) }); }
}

module.exports = { execute };
