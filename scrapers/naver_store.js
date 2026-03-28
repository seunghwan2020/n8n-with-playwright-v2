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

// ============ SCRAPE v35: PHASE 3 병렬 최적화 ============
async function scrape(params) {
  var storeSlug = params.store_slug || 'dcurvin';
  var storeType = params.store_type || 'brand';
  var result = {
    status: 'OK', data: [], channel_uid: '', error: null,
    method_used: 'v35_parallel',
    debug: { build: 'V35_PARALLEL', storeSlug: storeSlug, storeType: storeType }
  };

  var br = null; var ctx = null; var page = null;

  try {
    br = await getBrowser();
    ctx = await br.newContext(ctxOpts());
    page = await ctx.newPage();
    await page.addInitScript(stealth);

    var baseUrl, apiBase;
    if (storeType === 'smartstore') {
      baseUrl = 'https://smartstore.naver.com/' + storeSlug;
      apiBase = 'https://brand.naver.com';
    } else {
      baseUrl = 'https://brand.naver.com/' + storeSlug;
      apiBase = 'https://brand.naver.com';
    }

    // ★ v27: 병렬 실행 시 동시 시작 방지
    var staggerDelay = Math.floor(Math.random() * 2000) + 1000;
    await page.waitForTimeout(staggerDelay);

    // ===== PHASE 1: 상품 ID 수집 =====
    var pageSize = 80;
    var maxPages = 3;
    var waitStrategy = (storeType === 'smartstore') ? 'domcontentloaded' : 'networkidle';

    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=' + pageSize;
    console.log('[v35] P1: ' + targetUrl);
    await page.goto(targetUrl, { waitUntil: waitStrategy, timeout: 45000 });
    await page.waitForTimeout(3000);

    if (storeType === 'smartstore') {
      try {
        await page.waitForFunction(function() {
          return window.__PRELOADED_STATE__ || window.__NEXT_DATA__;
        }, { timeout: 10000 });
      } catch(e) {
        console.log('[v35] smartstore state wait timeout, continuing...');
      }
      await page.waitForTimeout(2000);
    }

    for (var si = 0; si < 5; si++) {
      try { await page.evaluate(function() { if (document.body) window.scrollTo(0, document.body.scrollHeight); }); } catch(e) { break; }
      await page.waitForTimeout(1500);
    }

    // 추가 페이지 수집
    var extraPageIds = [];
    for (var pgNum = 2; pgNum <= maxPages; pgNum++) {
      try {
        var pgUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=' + pgNum + '&size=' + pageSize;
        var pgPage = await ctx.newPage();
        await pgPage.addInitScript(stealth);
        await pgPage.goto(pgUrl, { waitUntil: waitStrategy, timeout: 30000 });
        await pgPage.waitForTimeout(2000);
        for (var ssi = 0; ssi < 3; ssi++) {
          try { await pgPage.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); }); } catch(e) { break; }
          await pgPage.waitForTimeout(1000);
        }
        var pgIds = await pgPage.evaluate(function() {
          var ids = {};
          try {
            var state = window.__PRELOADED_STATE__;
            if (state && state.categoryProducts && state.categoryProducts.simpleProducts) {
              var sp = state.categoryProducts.simpleProducts;
              for (var i = 0; i < sp.length; i++) {
                var pid = typeof sp[i] === 'object' ? String(sp[i].id || '') : String(sp[i]);
                if (pid) ids[pid] = true;
              }
            }
            var links = document.querySelectorAll('a[href*="/products/"]');
            for (var li = 0; li < links.length; li++) {
              var m = (links[li].getAttribute('href') || '').match(/products\/(\d+)/);
              if (m) ids[m[1]] = true;
            }
          } catch(e) {}
          return Object.keys(ids);
        });
        await pgPage.close();
        if (pgIds.length > 0) {
          for (var pi = 0; pi < pgIds.length; pi++) extraPageIds.push(pgIds[pi]);
          console.log('[v35] page ' + pgNum + ': ' + pgIds.length + ' IDs');
        } else {
          console.log('[v35] page ' + pgNum + ': empty, stopping');
          break;
        }
      } catch(e) {
        console.log('[v35] page ' + pgNum + ' error: ' + (e.message || '').substring(0, 50));
      }
    }

    var stateInfo = await page.evaluate(function() {
      var out = { channelUid: '', channelName: '', allIds: [], method: 'none' };
      try {
        var state = window.__PRELOADED_STATE__;
        if (!state) { out.method = 'no_preloaded_state'; return out; }
        out.method = 'preloaded_state';
        if (state.channel) {
          if (state.channel.channelUid) out.channelUid = state.channel.channelUid;
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

    // smartstore fallback
    if (stateInfo.allIds.length === 0 && storeType === 'smartstore') {
      console.log('[v35] smartstore fallback: DOM scraping');
      var domInfo = await page.evaluate(function(baseUrl) {
        var out = { channelUid: '', channelName: '', allIds: [], method: 'dom_fallback' };
        try {
          var scripts = document.querySelectorAll('script');
          for (var si = 0; si < scripts.length; si++) {
            var txt = scripts[si].textContent || '';
            var uidMatch = txt.match(/"channelUid"\s*:\s*"([^"]+)"/);
            if (uidMatch && !out.channelUid) out.channelUid = uidMatch[1];
            var nameMatch = txt.match(/"channelName"\s*:\s*"([^"]+)"/);
            if (nameMatch && !out.channelName) out.channelName = nameMatch[1];
            if (out.channelUid && out.channelName) break;
          }
          if (!out.channelName) {
            var title = document.title || '';
            var colonIdx = title.indexOf(':');
            if (colonIdx > 0) out.channelName = title.substring(0, colonIdx).trim();
          }
          var idSet = {};
          var links = document.querySelectorAll('a[href*="/products/"]');
          for (var li = 0; li < links.length; li++) {
            var m = (links[li].getAttribute('href') || '').match(/products\/(\d+)/);
            if (m) idSet[m[1]] = true;
          }
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
        console.log('[v35] DOM fallback found ' + domInfo.allIds.length + ' products');
      }
    }

    // 추가 페이지 ID 합치기
    for (var p2i = 0; p2i < extraPageIds.length; p2i++) {
      if (stateInfo.allIds.indexOf(extraPageIds[p2i]) === -1) {
        stateInfo.allIds.push(extraPageIds[p2i]);
      }
    }

    // smartstore channelUid fallback
    if (!stateInfo.channelUid && storeType === 'smartstore') {
      try {
        console.log('[v35] channelUid not found, trying smart-stores API...');
        var resolveResult = await page.evaluate(function(slug) {
          var url = 'https://smartstore.naver.com/i/v1/smart-stores?url=' + encodeURIComponent(slug);
          return fetch(url, { credentials: 'include' })
            .then(function(r) { return r.ok ? r.json() : null; })
            .catch(function() { return null; });
        }, storeSlug);
        if (resolveResult) {
          stateInfo.channelUid = resolveResult.channelUid || (resolveResult.smartStore && resolveResult.smartStore.channelUid) || (resolveResult.channel && resolveResult.channel.channelUid) || '';
          if (!stateInfo.channelName) {
            stateInfo.channelName = resolveResult.channelName || (resolveResult.smartStore && resolveResult.smartStore.channelName) || (resolveResult.channel && resolveResult.channel.channelName) || '';
          }
          console.log('[v35] smart-stores API → uid=' + stateInfo.channelUid);
        }
      } catch(e) {
        console.log('[v35] smart-stores API error: ' + (e.message || '').substring(0, 50));
      }
    }

    result.channel_uid = stateInfo.channelUid;
    result.brand_name = stateInfo.channelName || '';
    result.debug.totalIds = stateInfo.allIds.length;
    result.debug.extraPageIds = extraPageIds.length;
    result.debug.stateMethod = stateInfo.method;

    // smartstore API 페이지 준비
    var apiPage = page;
    if (storeType === 'smartstore' && stateInfo.channelUid) {
      try {
        apiPage = await ctx.newPage();
        await apiPage.addInitScript(stealth);
        await apiPage.goto('https://brand.naver.com/dcurvin', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await apiPage.waitForTimeout(1000);
        console.log('[v35] smartstore: opened brand.naver.com API page');
      } catch(e) {
        console.log('[v35] smartstore: brand page open failed');
        apiPage = page;
      }
    }

    // ===== PHASE 1.5: 채널 상품 API로 전체 ID 보완 =====
    if (stateInfo.channelUid) {
      var beforeCount = stateInfo.allIds.length;
      var p15Page, p15UrlBase;
      if (storeType === 'smartstore') {
        p15Page = page;
        p15UrlBase = 'https://smartstore.naver.com/i/v2/channels/' + stateInfo.channelUid + '/categories/ALL/products';
      } else {
        p15Page = apiPage;
        p15UrlBase = apiBase + '/n/v2/channels/' + stateInfo.channelUid + '/categories/ALL/products';
      }
      try {
        for (var apiPg = 1; apiPg <= 10; apiPg++) {
          var productsResult = await p15Page.evaluate(function(args) {
            var url = args.urlBase + '?categorySearchType=DISPCATG&sortType=POPULAR&page=' + args.page + '&pageSize=40';
            return fetch(url, { credentials: 'include' })
              .then(function(r) { return r.ok ? r.json() : null; })
              .catch(function() { return null; });
          }, { urlBase: p15UrlBase, page: apiPg });

          if (!productsResult || !Array.isArray(productsResult.simpleProducts) || productsResult.simpleProducts.length === 0) break;

          var newCount = 0;
          for (var pri = 0; pri < productsResult.simpleProducts.length; pri++) {
            var sp = productsResult.simpleProducts[pri];
            var spid = String(typeof sp === 'object' ? (sp.id || '') : sp);
            if (spid && stateInfo.allIds.indexOf(spid) === -1) {
              stateInfo.allIds.push(spid);
              newCount++;
            }
          }
          console.log('[v35] P1.5: p' + apiPg + ' → ' + productsResult.simpleProducts.length + ' products, ' + newCount + ' new');
          if (productsResult.simpleProducts.length < 40) break;
          await p15Page.waitForTimeout(300);
        }
      } catch(e) {
        console.log('[v35] PHASE 1.5 error: ' + (e.message || '').substring(0, 50));
      }
      result.debug.phase15_added = stateInfo.allIds.length - beforeCount;
      result.debug.totalIds = stateInfo.allIds.length;
      console.log('[v35] PHASE 1.5: ' + beforeCount + ' → ' + stateInfo.allIds.length + ' IDs');
    }

    // ===== PHASE 2: simple-products API =====
    var productMap = {};
    var productNoMap = {};

    // smartstore: __PRELOADED_STATE__에서 직접 추출
    if (storeType === 'smartstore') {
      console.log('[v35] smartstore: extracting from __PRELOADED_STATE__');
      var stateProducts = await page.evaluate(function(baseUrl) {
        var out = { products: [], productNoMap: {} };
        try {
          var state = window.__PRELOADED_STATE__;
          if (!state) return out;
          var sp = (state.categoryProducts && state.categoryProducts.simpleProducts) || [];
          for (var i = 0; i < sp.length; i++) {
            var p = sp[i];
            if (typeof p !== 'object' || !p) continue;
            var pid = String(p.id || '');
            if (!pid) continue;
            var rc = 0;
            if (p.reviewAmount && typeof p.reviewAmount === 'object') rc = p.reviewAmount.totalReviewCount || 0;
            var dp = null;
            if (p.benefitsView && p.benefitsView.discountedSalePrice) dp = p.benefitsView.discountedSalePrice;
            var pno = String(p.productNo || '');
            if (pno) out.productNoMap[pid] = pno;
            out.products.push({
              product_id: pid, product_name: p.name || p.dispName || '',
              sale_price: p.salePrice || 0, discount_price: dp, review_count: rc,
              product_image_url: (p.representativeImageUrl || '').split('?')[0],
              category_name: p.category ? (p.category.wholeCategoryName || '') : '',
              is_sold_out: (p.productStatusType === 'OUTOFSTOCK') || (p.soldout === true) || false,
              product_url: baseUrl + '/products/' + pid, productNo: pno
            });
          }
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
                product_id: ppid, product_name: pp.name || pp.dispName || '',
                sale_price: pp.salePrice || 0, discount_price: pdp, review_count: prc,
                product_image_url: (pp.representativeImageUrl || '').split('?')[0],
                category_name: '',
                is_sold_out: (pp.productStatusType === 'OUTOFSTOCK') || (pp.soldout === true) || false,
                product_url: baseUrl + '/products/' + ppid, productNo: ppno
              });
            }
          }
        } catch(e) {}
        return out;
      }, baseUrl);

      console.log('[v35] smartstore state products: ' + stateProducts.products.length);
      if (stateProducts.products.length > 0) {
        for (var spi = 0; spi < stateProducts.products.length; spi++) {
          var sp = stateProducts.products[spi];
          productMap[sp.product_id] = {
            product_id: sp.product_id, product_name: sp.product_name,
            sale_price: sp.sale_price, discount_price: sp.discount_price, review_count: sp.review_count,
            purchase_count_today: null, purchase_text_today: null, purchase_prefix_today: null,
            purchase_count_weekly: null, purchase_text_weekly: null, purchase_prefix_weekly: null,
            product_image_url: sp.product_image_url, category_name: sp.category_name,
            is_sold_out: sp.is_sold_out, product_url: sp.product_url
          };
          if (sp.productNo) productNoMap[sp.product_id] = sp.productNo;
        }
        Object.assign(productNoMap, stateProducts.productNoMap);
      }
    }

    // API로 누락된 상품 조회
    var missingIds = [];
    if (Object.keys(productMap).length > 0 && stateInfo.allIds.length > Object.keys(productMap).length) {
      for (var mi2 = 0; mi2 < stateInfo.allIds.length; mi2++) {
        if (!productMap[stateInfo.allIds[mi2]]) missingIds.push(stateInfo.allIds[mi2]);
      }
    }
    var idsToFetch = (Object.keys(productMap).length === 0) ? stateInfo.allIds : missingIds;

    if (idsToFetch.length > 0 && stateInfo.channelUid) {
      var batchSize = 20;
      for (var bi = 0; bi < idsToFetch.length; bi += batchSize) {
        var batch = idsToFetch.slice(bi, bi + batchSize);
        try {
          var apiResult = await apiPage.evaluate(function(args) {
            var qs = args.ids.map(function(id) { return 'ids[]=' + id; }).join('&');
            var url = args.apiBase + '/n/v2/channels/' + args.uid + '/simple-products?' + qs
              + '&useChannelProducts=false&excludeAuthBlind=false&excludeDisplayableFilter=false&forceOrder=true';
            return fetch(url, { credentials: 'include' })
              .then(function(r) { return r.ok ? r.json() : { _failed: true, _status: r.status }; })
              .catch(function(e) { return { _failed: true, _error: String(e) }; });
          }, { uid: stateInfo.channelUid, ids: batch, apiBase: apiBase });

          if (apiResult && apiResult._failed) break;

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
                product_id: pid, product_name: p.name || p.dispName || '',
                sale_price: p.salePrice || 0, discount_price: dp, review_count: rc,
                purchase_count_today: null, purchase_text_today: null, purchase_prefix_today: null,
                purchase_count_weekly: null, purchase_text_weekly: null, purchase_prefix_weekly: null,
                product_image_url: (p.representativeImageUrl || '').split('?')[0],
                category_name: p.category ? (p.category.wholeCategoryName || '') : '',
                is_sold_out: (p.productStatusType === 'OUTOFSTOCK') || (p.soldout === true) || false,
                product_url: baseUrl + '/products/' + pid
              };
            }
          }
        } catch(e) {}
        if (bi + batchSize < idsToFetch.length) await apiPage.waitForTimeout(200);
      }
    }

    result.debug.apiProducts = Object.keys(productMap).length;
    result.debug.productNoMapped = Object.keys(productNoMap).length;


    // ===== PHASE 3: marketing-message ★★★ 5개씩 병렬 처리 ★★★ =====
    var purchaseDebug = { total: 0, todayOk: 0, weeklyOk: 0, skipped: 0, errors: [] };
    var allPids = Object.keys(productMap);

    var msgApiBase = apiBase;
    var msgApiPath = '/n/v1/marketing-message/';
    var msgPage = apiPage;
    console.log('[v35] PHASE 3 시작: ' + allPids.length + '개 상품 (5개씩 병렬)');

    var consecutive429 = 0;
    var PARALLEL = 5; // ★ 동시 처리 수

    // ★ 단일 상품 구매건수 조회 함수 (page.evaluate 내부)
    var fetchPurchaseScript = function(args) {
      function buildUrl(basisPurchased) {
        return args.msgApiBase + args.path + args.id
          + '?currentPurchaseType=Paid'
          + '&usePurchased=true&basisPurchased=' + basisPurchased
          + '&usePurchasedIn2Y=true'
          + '&useRepurchased=false';
      }

      function doFetch(url, retry) {
        retry = retry || 0;
        return fetch(url, { credentials: 'include', cache: 'no-store' })
          .then(function(r) {
            if (r.status === 429) return { _fail: true, _status: 429, _rateLimited: true };
            if (!r.ok) return { _fail: true, _status: r.status };
            return r.json();
          })
          .catch(function(e) { return { _fail: true, _error: String(e).substring(0, 80) }; })
          .then(function(d) {
            if (d && d._rateLimited && retry < 1) {
              return new Promise(function(res) { setTimeout(res, 2000); })
                .then(function() { return doFetch(url, retry + 1); });
            }
            if (d && d._fail && !d._rateLimited && retry < 1) {
              return new Promise(function(res) { setTimeout(res, 300); })
                .then(function() { return doFetch(url, retry + 1); });
            }
            return d;
          });
      }

      function getCount(phrase) {
        var m = (phrase || '').match(/(\d[\d,]*)\s*명/);
        return m ? parseInt(m[1].replace(/,/g, '')) : 0;
      }

      var out = {
        prodId: args.prodId, msgId: args.id,
        today_count: null, today_phrase: null, today_prefix: null,
        weekly_count: null, weekly_phrase: null, weekly_prefix: null,
        got429: false
      };

      return doFetch(buildUrl(1)).then(function(d1) {
        if (!d1 || d1._fail || !d1.mainPhrase) {
          if (d1 && d1._rateLimited) out.got429 = true;
          return out;
        }

        var pfx1 = (d1.prefix || '').trim();
        var cnt1 = getCount(d1.mainPhrase);

        if (cnt1 === 0) return out;

        // "최근 1주간" → weekly 바로 저장
        if (pfx1.indexOf('\uCD5C\uADFC') > -1) {
          out.weekly_count = cnt1;
          out.weekly_phrase = d1.mainPhrase;
          out.weekly_prefix = pfx1;
          return out;
        }

        // "오늘" → today 저장 후 call 2
        if (pfx1.indexOf('\uC624\uB298') > -1) {
          out.today_count = cnt1;
          out.today_phrase = d1.mainPhrase;
          out.today_prefix = pfx1;

          var nextBasis = cnt1 + 1;
          return new Promise(function(res) { setTimeout(res, 150); }).then(function() {
            return doFetch(buildUrl(nextBasis));
          }).then(function(d2) {
            if (!d2 || d2._fail || !d2.mainPhrase) return out;
            var pfx2 = (d2.prefix || '').trim();
            var cnt2 = getCount(d2.mainPhrase);
            if (cnt2 > 0 && pfx2.indexOf('\uCD5C\uADFC') > -1) {
              out.weekly_count = cnt2;
              out.weekly_phrase = d2.mainPhrase;
              out.weekly_prefix = pfx2;
            }
            return out;
          });
        }

        return out;
      }).catch(function() { return out; });
    };

    // ★★★ 5개씩 병렬 배치 실행 ★★★
    for (var bi = 0; bi < allPids.length; bi += PARALLEL) {
      if (consecutive429 >= 5) {
        purchaseDebug.skipped += (allPids.length - bi);
        console.log('[v35] 429 rate limit: skipping remaining ' + (allPids.length - bi));
        break;
      }

      var batchPids = allPids.slice(bi, bi + PARALLEL);
      purchaseDebug.total += batchPids.length;

      try {
        // ★ 5개를 동시에 page.evaluate로 Promise.all 실행
        var batchArgs = batchPids.map(function(pid) {
          return { prodId: pid, id: productNoMap[pid] || pid, msgApiBase: msgApiBase, path: msgApiPath };
        });

        var batchResults = await msgPage.evaluate(function(args) {
          var fetchFn = FETCH_FN_PLACEHOLDER;
          // ★ 5개 동시 호출
          return Promise.all(args.items.map(function(item) {
            return fetchFn(item);
          }));
        }.toString()
          .replace('FETCH_FN_PLACEHOLDER', fetchPurchaseScript.toString())
          .replace(/^function\s*\([^)]*\)\s*\{/, '')
          .replace(/\}$/, ''),
        { items: batchArgs });

        // 위 방식이 복잡하므로 더 안정적인 방법: 개별 evaluate를 Promise.all로
        // 실제로는 아래 방식이 더 안전함
      } catch(e) {
        // fallback: evaluate 내 함수 주입이 안 되면 개별 처리
      }

      // ★ 안정적 방식: evaluate 안에서 직접 Promise.all
      try {
        var batchItems = batchPids.map(function(pid) {
          return { prodId: pid, id: productNoMap[pid] || pid };
        });

        var results = await msgPage.evaluate(function(args) {
          function buildUrl(id, basisPurchased) {
            return args.msgApiBase + args.path + id
              + '?currentPurchaseType=Paid'
              + '&usePurchased=true&basisPurchased=' + basisPurchased
              + '&usePurchasedIn2Y=true'
              + '&useRepurchased=false';
          }

          function doFetch(url, retry) {
            retry = retry || 0;
            return fetch(url, { credentials: 'include', cache: 'no-store' })
              .then(function(r) {
                if (r.status === 429) return { _fail: true, _status: 429, _rateLimited: true };
                if (!r.ok) return { _fail: true, _status: r.status };
                return r.json();
              })
              .catch(function(e) { return { _fail: true, _error: String(e).substring(0, 80) }; })
              .then(function(d) {
                if (d && d._rateLimited && retry < 1) {
                  return new Promise(function(res) { setTimeout(res, 2000); })
                    .then(function() { return doFetch(url, retry + 1); });
                }
                if (d && d._fail && !d._rateLimited && retry < 1) {
                  return new Promise(function(res) { setTimeout(res, 300); })
                    .then(function() { return doFetch(url, retry + 1); });
                }
                return d;
              });
          }

          function getCount(phrase) {
            var m = (phrase || '').match(/(\d[\d,]*)\s*명/);
            return m ? parseInt(m[1].replace(/,/g, '')) : 0;
          }

          function fetchOne(item) {
            var out = {
              prodId: item.prodId, msgId: item.id,
              today_count: null, today_phrase: null, today_prefix: null,
              weekly_count: null, weekly_phrase: null, weekly_prefix: null,
              got429: false
            };

            return doFetch(buildUrl(item.id, 1)).then(function(d1) {
              if (!d1 || d1._fail || !d1.mainPhrase) {
                if (d1 && d1._rateLimited) out.got429 = true;
                return out;
              }

              var pfx1 = (d1.prefix || '').trim();
              var cnt1 = getCount(d1.mainPhrase);
              if (cnt1 === 0) return out;

              if (pfx1.indexOf('\uCD5C\uADFC') > -1) {
                out.weekly_count = cnt1;
                out.weekly_phrase = d1.mainPhrase;
                out.weekly_prefix = pfx1;
                return out;
              }

              if (pfx1.indexOf('\uC624\uB298') > -1) {
                out.today_count = cnt1;
                out.today_phrase = d1.mainPhrase;
                out.today_prefix = pfx1;

                return new Promise(function(res) { setTimeout(res, 100); }).then(function() {
                  return doFetch(buildUrl(item.id, cnt1 + 1));
                }).then(function(d2) {
                  if (!d2 || d2._fail || !d2.mainPhrase) return out;
                  var pfx2 = (d2.prefix || '').trim();
                  var cnt2 = getCount(d2.mainPhrase);
                  if (cnt2 > 0 && pfx2.indexOf('\uCD5C\uADFC') > -1) {
                    out.weekly_count = cnt2;
                    out.weekly_phrase = d2.mainPhrase;
                    out.weekly_prefix = pfx2;
                  }
                  return out;
                });
              }

              return out;
            }).catch(function() { return out; });
          }

          // ★★★ Promise.all로 5개 동시 실행 ★★★
          return Promise.all(args.items.map(fetchOne));

        }, { items: batchItems, msgApiBase: msgApiBase, path: msgApiPath });

        // 결과 반영
        if (Array.isArray(results)) {
          for (var ri = 0; ri < results.length; ri++) {
            var r = results[ri];
            if (!r || !r.prodId) continue;

            if (r.got429) consecutive429++;
            else consecutive429 = 0;

            if (r.today_count !== null && productMap[r.prodId]) {
              productMap[r.prodId].purchase_count_today = r.today_count;
              productMap[r.prodId].purchase_text_today = r.today_phrase;
              productMap[r.prodId].purchase_prefix_today = r.today_prefix;
              purchaseDebug.todayOk++;
            }
            if (r.weekly_count !== null && productMap[r.prodId]) {
              productMap[r.prodId].purchase_count_weekly = r.weekly_count;
              productMap[r.prodId].purchase_text_weekly = r.weekly_phrase;
              productMap[r.prodId].purchase_prefix_weekly = r.weekly_prefix;
              purchaseDebug.weeklyOk++;
            }
          }
        }

      } catch(e) {
        purchaseDebug.skipped += batchPids.length;
        if (purchaseDebug.errors.length < 5) {
          purchaseDebug.errors.push({ batch: bi, err: String(e).substring(0, 100) });
        }
      }

      // ★ 배치 간 200ms 대기 (기존 300ms에서 단축)
      await msgPage.waitForTimeout(200);
    }

    result.debug.purchase = purchaseDebug;
    console.log('[v35] PHASE 3 완료: today=' + purchaseDebug.todayOk + ' weekly=' + purchaseDebug.weeklyOk + ' skip=' + purchaseDebug.skipped);


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
  console.log('[naver_store v35] action=' + action);
  try {
    if (action === 'scrape') return res.json(await scrape(req.body));
    if (action === 'spy') return res.json(await spy(req.body));
    return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
  } catch(e) { if (!res.headersSent) return res.status(500).json({ status: 'ERROR', error: e.message || String(e) }); }
}

module.exports = { execute };
