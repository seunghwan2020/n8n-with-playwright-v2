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
    method_used: 'v34_fullscan',
    debug: { build: 'V34_FULLSCAN', storeSlug: storeSlug, storeType: storeType }
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

    // ★ v27: 병렬 실행 시 동시 시작 방지 — 1~3초 랜덤 딜레이
    var staggerDelay = Math.floor(Math.random() * 2000) + 1000;
    await page.waitForTimeout(staggerDelay);
    

    // ===== PHASE 1: 상품 ID 수집 =====
    // ★ v34: 네이버 HTML 80개씩 보기 지원 확인됨
    var pageSize = 80;
    var maxPages = 3; // 80 x 3 = 최대 240개 상품
    var waitStrategy = (storeType === 'smartstore') ? 'domcontentloaded' : 'networkidle';

    // ★ page 1 로드 (메인 페이지 — channelUid, channelName 추출용)
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=' + pageSize;
    console.log('[v34] P1: ' + targetUrl);
    await page.goto(targetUrl, { waitUntil: waitStrategy, timeout: 45000 });
    await page.waitForTimeout(3000);

    // ★ smartstore: __PRELOADED_STATE__ 로딩 대기
    if (storeType === 'smartstore') {
      try {
        await page.waitForFunction(function() {
          return window.__PRELOADED_STATE__ || window.__NEXT_DATA__;
        }, { timeout: 10000 });
      } catch(e) {
        console.log('[v34] smartstore state wait timeout, continuing...');
      }
      await page.waitForTimeout(2000);
    }

    for (var si = 0; si < 5; si++) {
      try { await page.evaluate(function() { if (document.body) window.scrollTo(0, document.body.scrollHeight); }); } catch(e) { break; }
      await page.waitForTimeout(1500);
    }

    // ★ page 2, 3 추가 수집 (별도 페이지로 열어서 ID만 추출)
    var extraPageIds = [];
    for (var pgNum = 2; pgNum <= maxPages; pgNum++) {
      try {
        var pgUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=' + pgNum + '&size=' + pageSize;
        var pgPage = await ctx.newPage();
        await pgPage.addInitScript(stealth);
        await pgPage.goto(pgUrl, { waitUntil: waitStrategy, timeout: 30000 });
        await pgPage.waitForTimeout(2000);
        // 스크롤해서 lazy-load 상품도 로드
        for (var ssi = 0; ssi < 3; ssi++) {
          try { await pgPage.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); }); } catch(e) { break; }
          await pgPage.waitForTimeout(1000);
        }
        var pgIds = await pgPage.evaluate(function() {
          var ids = {};
          try {
            // __PRELOADED_STATE__에서 추출
            var state = window.__PRELOADED_STATE__;
            if (state && state.categoryProducts && state.categoryProducts.simpleProducts) {
              var sp = state.categoryProducts.simpleProducts;
              for (var i = 0; i < sp.length; i++) {
                var pid = typeof sp[i] === 'object' ? String(sp[i].id || '') : String(sp[i]);
                if (pid) ids[pid] = true;
              }
            }
            // DOM 링크에서도 추출
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
          console.log('[v34] page ' + pgNum + ': ' + pgIds.length + ' IDs');
        } else {
          console.log('[v34] page ' + pgNum + ': empty, stopping');
          break; // 빈 페이지면 더 이상 없음
        }
      } catch(e) {
        console.log('[v34] page ' + pgNum + ' error: ' + (e.message || '').substring(0, 50));
      }
    }

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
      console.log('[v34] smartstore fallback: DOM scraping');
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
        console.log('[v34] DOM fallback found ' + domInfo.allIds.length + ' products');
      }
    }

    // 추가 페이지 ID 합치기
    for (var p2i = 0; p2i < extraPageIds.length; p2i++) {
      if (stateInfo.allIds.indexOf(extraPageIds[p2i]) === -1) {
        stateInfo.allIds.push(extraPageIds[p2i]);
      }
    }

    result.channel_uid = stateInfo.channelUid;
    result.brand_name = stateInfo.channelName || '';
    result.debug.totalIds = stateInfo.allIds.length;
    result.debug.extraPageIds = extraPageIds.length;
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
        console.log('[v34] smartstore: opened brand.naver.com API page');
      } catch(e) {
        console.log('[v34] smartstore: brand page open failed, using original page');
        apiPage = page; // 실패하면 원래 페이지 사용
      }
    }

    // ★ PHASE 1.5: 채널 상품 API로 전체 상품 ID 누락 보완
    // 실제 브라우저 요청 패턴:
    // 브랜드: brand.naver.com/n/v2/channels/{uid}/categories/ALL/products?categorySearchType=DISPCATG&sortType=POPULAR&page=1&pageSize=40
    // 스마트: smartstore.naver.com/i/v2/channels/{uid}/categories/ALL/products?categorySearchType=DISPCATG&sortType=POPULAR&page=1&pageSize=40
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

          if (!productsResult || !Array.isArray(productsResult.simpleProducts) || productsResult.simpleProducts.length === 0) {
            console.log('[v34] P1.5: page ' + apiPg + ' empty, stopping');
            break;
          }

          var newCount = 0;
          for (var pri = 0; pri < productsResult.simpleProducts.length; pri++) {
            var sp = productsResult.simpleProducts[pri];
            var spid = String(typeof sp === 'object' ? (sp.id || '') : sp);
            if (spid && stateInfo.allIds.indexOf(spid) === -1) {
              stateInfo.allIds.push(spid);
              newCount++;
            }
          }
          console.log('[v34] P1.5: p' + apiPg + ' → ' + productsResult.simpleProducts.length + ' products, ' + newCount + ' new');
          if (productsResult.simpleProducts.length < 40) break;
          await p15Page.waitForTimeout(300);
        }
      } catch(e) {
        console.log('[v34] PHASE 1.5 error: ' + (e.message || '').substring(0, 50));
      }
      result.debug.phase15_added = stateInfo.allIds.length - beforeCount;
      result.debug.totalIds = stateInfo.allIds.length;
      console.log('[v34] PHASE 1.5: ' + beforeCount + ' → ' + stateInfo.allIds.length + ' IDs (+' + (stateInfo.allIds.length - beforeCount) + ')');
    }

    // ===== PHASE 2: simple-products API =====
    // ★ v25.1: smartstore는 API 경로가 다름 + __PRELOADED_STATE__ fallback
    var productMap = {};
    var productNoMap = {};

    // ★ smartstore는 먼저 __PRELOADED_STATE__에서 직접 상품 데이터 추출 시도
    if (storeType === 'smartstore') {
      console.log('[v34] smartstore: extracting products from __PRELOADED_STATE__');
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

      console.log('[v34] smartstore state products: ' + stateProducts.products.length);

      if (stateProducts.products.length > 0) {
        for (var spi = 0; spi < stateProducts.products.length; spi++) {
          var sp = stateProducts.products[spi];
          productMap[sp.product_id] = {
            product_id: sp.product_id,
            product_name: sp.product_name,
            sale_price: sp.sale_price,
            discount_price: sp.discount_price,
            review_count: sp.review_count,
            purchase_count_today: null, purchase_text_today: null, purchase_prefix_today: null,
            purchase_count_weekly: null, purchase_text_weekly: null, purchase_prefix_weekly: null,
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
    // ★ smartstore에서 일부만 state에서 추출된 경우, page2 ID도 추가 조회
    var missingIds = [];
    if (Object.keys(productMap).length > 0 && stateInfo.allIds.length > Object.keys(productMap).length) {
      for (var mi2 = 0; mi2 < stateInfo.allIds.length; mi2++) {
        if (!productMap[stateInfo.allIds[mi2]]) missingIds.push(stateInfo.allIds[mi2]);
      }
      console.log('[v34] missing IDs from state: ' + missingIds.length);
    }
    var idsToFetch = (Object.keys(productMap).length === 0) ? stateInfo.allIds : missingIds;

    if (idsToFetch.length > 0 && stateInfo.channelUid) {
      var apiPaths = ['/n/v2/channels/'];

      var batchSize = 20;
      for (var pathIdx = 0; pathIdx < apiPaths.length; pathIdx++) {
        var currentPath = apiPaths[pathIdx];
        var pathWorked = false;

        for (var bi = 0; bi < idsToFetch.length; bi += batchSize) {
          var batch = idsToFetch.slice(bi, bi + batchSize);
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
              console.log('[v34] API path ' + currentPath + ' failed: ' + (apiResult._status || apiResult._error));
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

        if (pathWorked) {
          console.log('[v34] API path worked: ' + currentPath + ', products: ' + Object.keys(productMap).length);
          result.debug.apiPathUsed = currentPath;
          break;
        }
      }
    }

    result.debug.apiProducts = Object.keys(productMap).length;
    result.debug.productNoMapped = Object.keys(productNoMap).length;


    // ===== PHASE 3: marketing-message 구매건수 수집 =====
    // ★★★ v33: basisPurchased로 오늘/주간 제어
    //
    // [핵심 발견] "최근 1주간 구매"는 usePurchased 메트릭 안에 있다.
    //   useRepurchased → "최근 3개월간 재구매" (다른 메트릭!)
    //   usePurchased   → "오늘 N명 구매" 또는 "최근 1주간 M명 구매"
    //
    // [전략] useRepurchased=false 고정, basisPurchased만 조절:
    //   1) basisPurchased=1                → "오늘 N명" or "최근 1주간 M명"
    //   2) basisPurchased=(todayCount+1)   → "최근 1주간 M명" (오늘 규칙 스킵!)
    //
    // ★ 실패 = null. 절대 0을 넣지 않는다. ★
    // ★★★

    var purchaseDebug = { total: 0, todayOk: 0, weeklyOk: 0, skipped: 0, errors: [] };
    var allPids = Object.keys(productMap);

    // ★ v34: 스마트스토어는 smartstore.naver.com/i/v1/ 경유!
    // brand.naver.com/n/v1/은 브랜드스토어 상품만 인식 — 스마트스토어 상품은 call1_fail
    // 스마트스토어 page에서 same-origin 호출하면 CORS 문제 없음
    var msgApiBase, msgApiPath, msgPage;
    if (storeType === 'smartstore') {
      msgApiBase = 'https://smartstore.naver.com';
      msgApiPath = '/i/v1/marketing-message/';
      msgPage = page; // 원래 스마트스토어 페이지 (same-origin)
    } else {
      msgApiBase = apiBase; // brand.naver.com
      msgApiPath = '/n/v1/marketing-message/';
      msgPage = apiPage;
    }
    console.log('[v34] PHASE 3 시작: ' + allPids.length + '개 상품, msgBase=' + msgApiBase + msgApiPath);

    // ★ 디버그: msgPage 현재 URL 확인
    var msgPageUrl = '';
    try { msgPageUrl = await msgPage.url(); } catch(e) {}
    console.log('[v34] PHASE 3 msgPage URL: ' + msgPageUrl);
    result.debug.msgPageUrl = msgPageUrl;
    result.debug.msgApiBase = msgApiBase + msgApiPath;

    var consecutive429 = 0; // ★ 연속 429 카운터 — 5회 연속이면 나머지 스킵 (타임아웃 방지)

    for (var mi = 0; mi < allPids.length; mi++) {
      // ★ 연속 429가 5회 이상이면 rate limit 상태 → 나머지 스킵
      if (consecutive429 >= 5) {
        purchaseDebug.skipped += (allPids.length - mi);
        console.log('[v34] 429 rate limit: skipping remaining ' + (allPids.length - mi) + ' products');
        break;
      }

      var prodId = allPids[mi];
      var msgId = productNoMap[prodId] || prodId;
      purchaseDebug.total++;

      try {
        var result33 = await msgPage.evaluate(function(args) {
          function buildUrl(basisPurchased) {
            var url = args.msgApiBase + args.path + args.id
              + '?currentPurchaseType=Paid'
              + '&usePurchased=true&basisPurchased=' + basisPurchased
              + '&usePurchasedIn2Y=true';
            // ★ 스마트스토어: useRepurchased=true 필수 (false면 API 실패)
            // ★ 브랜드스토어: useRepurchased=false (분리 호출로 정확한 주간 데이터)
            if (args.isSmartstore) {
              url += '&useRepurchased=true&basisRepurchased=' + basisPurchased;
            } else {
              url += '&useRepurchased=false';
            }
            return url;
          }

          function doFetch(url, retry) {
            retry = retry || 0;
            return fetch(url, { credentials: 'include', cache: 'no-store' })
              .then(function(r) {
                if (r.status === 429) return { _fail: true, _status: 429, _rateLimited: true, _url: url.substring(0, 120) };
                if (!r.ok) return { _fail: true, _status: r.status, _url: url.substring(0, 120) };
                return r.json();
              })
              .catch(function(e) { return { _fail: true, _error: String(e).substring(0, 80), _url: url.substring(0, 120) }; })
              .then(function(d) {
                // ★ 429: 1회만 재시도, 2초 대기
                if (d && d._rateLimited && retry < 1) {
                  return new Promise(function(res) { setTimeout(res, 2000); })
                    .then(function() { return doFetch(url, retry + 1); });
                }
                // 일반 실패: 1회 재시도
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
            today_count: null, today_phrase: null, today_prefix: null,
            weekly_count: null, weekly_phrase: null, weekly_prefix: null,
            log: []
          };

          // ★ 1) basisPurchased=1 → "오늘 N명" or "최근 1주간 M명"
          var url1 = buildUrl(1);
          out.log.push({ step: 'call1', params: 'basisPurchased=1&useRepurchased=' + (args.isSmartstore ? 'true' : 'false'), msgId: args.id });

          return doFetch(url1).then(function(d1) {
            if (!d1 || d1._fail || !d1.mainPhrase) {
              out.log.push({ step: 'call1_fail', detail: d1 && d1._fail ? { status: d1._status, error: d1._error, url: d1._url } : 'empty_response' });
              return out;
            }

            var pfx1 = (d1.prefix || '').trim();
            var cnt1 = getCount(d1.mainPhrase);
            out.log.push({ step: 'call1_result', prefix: pfx1, count: cnt1, phrase: d1.mainPhrase });

            if (cnt1 === 0) return out;

            // CASE A: "최근 1주간" → 오늘 구매 없음, weekly 바로 저장. 끝.
            if (pfx1.indexOf('\uCD5C\uADFC') > -1) {
              out.weekly_count = cnt1;
              out.weekly_phrase = d1.mainPhrase;
              out.weekly_prefix = pfx1;
              return out;
            }

            // CASE B: "오늘" → today 저장 후 call 2
            if (pfx1.indexOf('\uC624\uB298') > -1) {
              out.today_count = cnt1;
              out.today_phrase = d1.mainPhrase;
              out.today_prefix = pfx1;

              // ★ 2) basisPurchased=(todayCount+1) → "최근 1주간 M명"
              var nextBasis = cnt1 + 1;
              var url2 = buildUrl(nextBasis);
              out.log.push({ step: 'call2', params: 'basisPurchased=' + nextBasis + '&useRepurchased=' + (args.isSmartstore ? 'true' : 'false') });

              return new Promise(function(res) { setTimeout(res, 200); }).then(function() {
                return doFetch(url2);
              }).then(function(d2) {
                if (!d2 || d2._fail || !d2.mainPhrase) {
                  out.log.push({ step: 'call2_fail', detail: d2 && d2._fail ? { status: d2._status, error: d2._error } : 'empty_response' });
                  return out;
                }

                var pfx2 = (d2.prefix || '').trim();
                var cnt2 = getCount(d2.mainPhrase);
                out.log.push({ step: 'call2_result', prefix: pfx2, count: cnt2, phrase: d2.mainPhrase, basis: nextBasis });

                if (cnt2 > 0 && pfx2.indexOf('\uCD5C\uADFC') > -1) {
                  out.weekly_count = cnt2;
                  out.weekly_phrase = d2.mainPhrase;
                  out.weekly_prefix = pfx2;
                }
                return out;
              });
            }

            // CASE C: prefix 없음 ("N명 이상 구매" 누적) → 무시
            out.log.push({ step: 'cumulative', phrase: d1.mainPhrase });
            return out;
          });

        }, { id: msgId, msgApiBase: msgApiBase, path: msgApiPath, isSmartstore: (storeType === 'smartstore') });

        // ★ 결과 저장 + 429 카운터 관리
        if (result33) {
          // 429 체크: log에서 rateLimited 확인
          var got429 = false;
          if (result33.log) {
            for (var li = 0; li < result33.log.length; li++) {
              if (result33.log[li].detail && result33.log[li].detail.status === 429) { got429 = true; break; }
            }
          }
          if (got429) {
            consecutive429++;
          } else {
            consecutive429 = 0; // 성공하면 리셋
          }

          if (result33.today_count !== null) {
            productMap[prodId].purchase_count_today = result33.today_count;
            productMap[prodId].purchase_text_today = result33.today_phrase;
            productMap[prodId].purchase_prefix_today = result33.today_prefix;
            purchaseDebug.todayOk++;
          }
          if (result33.weekly_count !== null) {
            productMap[prodId].purchase_count_weekly = result33.weekly_count;
            productMap[prodId].purchase_text_weekly = result33.weekly_phrase;
            productMap[prodId].purchase_prefix_weekly = result33.weekly_prefix;
            purchaseDebug.weeklyOk++;
          }
          productMap[prodId]._log = result33.log || [];

          if (result33.today_count !== null && result33.weekly_count === null) {
            if (purchaseDebug.errors.length < 15) {
              purchaseDebug.errors.push({ pid: prodId, msgId: msgId, reason: 'weekly_miss', log: result33.log });
            }
          }
          // ★ 완전 실패 (today+weekly 둘 다 null) 진단 — 첫 5개만
          if (result33.today_count === null && result33.weekly_count === null) {
            if (purchaseDebug.errors.length < 5) {
              purchaseDebug.errors.push({ pid: prodId, msgId: msgId, reason: 'all_fail', log: result33.log });
            }
          }
        } else {
          purchaseDebug.skipped++;
        }

      } catch(e) {
        purchaseDebug.skipped++;
        if (purchaseDebug.errors.length < 10) {
          purchaseDebug.errors.push({ pid: prodId, err: String(e).substring(0, 60) });
        }
      }

      // ★ 스마트스토어: 429 방지를 위해 더 긴 딜레이
      await msgPage.waitForTimeout(storeType === 'smartstore' ? 800 : 300);
    }

    result.debug.purchase = purchaseDebug;
    console.log('[v34] PHASE 3 완료: today=' + purchaseDebug.todayOk + ' weekly=' + purchaseDebug.weeklyOk + ' skip=' + purchaseDebug.skipped);


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
        is_sold_out: prod.is_sold_out, product_url: prod.product_url,
        _log: prod._log || []
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
  console.log('[naver_store v34] action=' + action);
  try {
    if (action === 'scrape') return res.json(await scrape(req.body));
    if (action === 'spy') return res.json(await spy(req.body));
    return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
  } catch(e) { if (!res.headersSent) return res.status(500).json({ status: 'ERROR', error: e.message || String(e) }); }
}

module.exports = { execute };
