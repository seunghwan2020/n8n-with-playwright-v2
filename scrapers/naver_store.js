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
    method_used: 'v31_cookie',
    debug: { build: 'V31_COOKIE', storeSlug: storeSlug, storeType: storeType }
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
    console.log('[v31] stagger delay: ' + staggerDelay + 'ms');

    // ★ v31: naver.com 방문하여 세션 쿠키(NNB, NAC 등) 확보
    // basisRepurchased가 작동하려면 네이버 세션 쿠키가 필수
    try {
      await page.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForTimeout(1000);
      console.log('[v31] naver.com 쿠키 확보 완료');
    } catch(e) {
      console.log('[v31] naver.com 쿠키 확보 실패 (계속 진행): ' + e.message);
    }

    // ===== PHASE 1: 상품 ID 수집 =====
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v31] P1: ' + targetUrl);

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
        console.log('[v31] smartstore state wait timeout, continuing...');
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
      console.log('[v31] smartstore fallback: DOM scraping');
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
        console.log('[v31] DOM fallback found ' + domInfo.allIds.length + ' products');
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
        console.log('[v31] smartstore: opened brand.naver.com API page');
      } catch(e) {
        console.log('[v31] smartstore: brand page open failed, using original page');
        apiPage = page; // 실패하면 원래 페이지 사용
      }
    }

    // ===== PHASE 2: simple-products API =====
    // ★ v25.1: smartstore는 API 경로가 다름 + __PRELOADED_STATE__ fallback
    var productMap = {};
    var productNoMap = {};

    // ★ smartstore는 먼저 __PRELOADED_STATE__에서 직접 상품 데이터 추출 시도
    if (storeType === 'smartstore') {
      console.log('[v31] smartstore: extracting products from __PRELOADED_STATE__');
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

      console.log('[v31] smartstore state products: ' + stateProducts.products.length);

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
    // ★ v27: smartstore에서 page1만 state에서 추출된 경우, page2 ID도 추가 조회
    var missingIds = [];
    if (Object.keys(productMap).length > 0 && stateInfo.allIds.length > Object.keys(productMap).length) {
      for (var mi2 = 0; mi2 < stateInfo.allIds.length; mi2++) {
        if (!productMap[stateInfo.allIds[mi2]]) missingIds.push(stateInfo.allIds[mi2]);
      }
      console.log('[v31] missing IDs from state: ' + missingIds.length);
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
              console.log('[v31] API path ' + currentPath + ' failed: ' + (apiResult._status || apiResult._error));
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
          console.log('[v31] API path worked: ' + currentPath + ', products: ' + Object.keys(productMap).length);
          result.debug.apiPathUsed = currentPath;
          break;
        }
      }
    }

    result.debug.apiProducts = Object.keys(productMap).length;
    result.debug.productNoMapped = Object.keys(productNoMap).length;


    // ===== PHASE 3: marketing-message 구매건수 수집 =====
    // ★★★ v30: 캐시 방지 + 완전한 디버그 로깅
    // 모든 fetch에 cache:'no-store' 추가
    // 실제 호출 URL, 응답 원문, prefix, count 전부 기록
    // ★★★

    var purchaseDebug = { total: 0, todayOk: 0, weeklyOk: 0, skipped: 0, errors: [] };
    var allPids = Object.keys(productMap);
    console.log('[v31] PHASE 3 시작: ' + allPids.length + '개 상품');

    for (var mi = 0; mi < allPids.length; mi++) {
      var prodId = allPids[mi];
      var msgId = productNoMap[prodId] || prodId;
      purchaseDebug.total++;

      try {
        var msgResult = await apiPage.evaluate(function(args) {
          var log = [];

          function buildUrl(basis) {
            return args.apiBase + '/n/v1/marketing-message/' + args.id
              + '?currentPurchaseType=Paid&usePurchased=true&basisPurchased=1'
              + '&usePurchasedIn2Y=true&useRepurchased=true&basisRepurchased=' + basis;
          }

          function doFetch(basis) {
            var url = buildUrl(basis);
            log.push({ action: 'fetch', basis: basis, url_tail: '...basisRepurchased=' + basis });
            return fetch(url, { credentials: 'include', cache: 'no-store' })
              .then(function(r) {
                if (!r.ok) {
                  log.push({ action: 'http_error', basis: basis, status: r.status });
                  return null;
                }
                return r.text().then(function(raw) {
                  log.push({ action: 'raw_response', basis: basis, raw: raw.substring(0, 200) });
                  try { return JSON.parse(raw); } catch(e) { return null; }
                });
              })
              .catch(function(e) {
                log.push({ action: 'fetch_error', basis: basis, err: String(e).substring(0, 80) });
                return null;
              });
          }

          function getCount(phrase) {
            var m = (phrase || '').match(/(\d[\d,]*)\s*명/);
            return m ? parseInt(m[1].replace(/,/g, '')) : 0;
          }

          function wait(ms) {
            return new Promise(function(res) { setTimeout(res, ms); });
          }

          // ========== Step 1: basisRepurchased=1 ==========
          return doFetch(1).then(function(d1) {
            if (!d1 || !d1.mainPhrase) {
              log.push({ action: 'step1_retry' });
              return wait(500).then(function() { return doFetch(1); });
            }
            return d1;
          }).then(function(d1) {
            if (!d1 || !d1.mainPhrase) {
              return { status: 'skip', reason: 'step1_fail', log: log };
            }

            var pfx1 = (d1.prefix || '').trim();
            var cnt1 = getCount(d1.mainPhrase);
            log.push({ action: 'step1_parsed', prefix: pfx1, count: cnt1, phrase: d1.mainPhrase });

            if (cnt1 === 0) {
              return { status: 'skip', reason: 'count_zero', log: log };
            }

            var out = {
              status: 'ok', log: log,
              today_count: null, today_phrase: null, today_prefix: null,
              weekly_count: null, weekly_phrase: null, weekly_prefix: null
            };

            // ★ "최근 1주간" → weekly 저장, 끝
            if (pfx1.indexOf('\uCD5C\uADFC') > -1) {
              out.weekly_count = cnt1;
              out.weekly_phrase = d1.mainPhrase;
              out.weekly_prefix = pfx1;
              log.push({ action: 'weekly_saved', count: cnt1 });
              return out;
            }

            // ★ "오늘" → today 저장, Step 2로
            if (pfx1.indexOf('\uC624\uB298') > -1) {
              out.today_count = cnt1;
              out.today_phrase = d1.mainPhrase;
              out.today_prefix = pfx1;
              log.push({ action: 'today_saved', count: cnt1 });

              // ========== Step 2: basisRepurchased=(cnt1 + 1) ==========
              var nextBasis = cnt1 + 1;
              log.push({ action: 'step2_start', next_basis: nextBasis, formula: cnt1 + '+1=' + nextBasis });

              return wait(500).then(function() {
                return doFetch(nextBasis);
              }).then(function(d2) {
                if (!d2 || !d2.mainPhrase) {
                  log.push({ action: 'step2_retry' });
                  return wait(1000).then(function() { return doFetch(nextBasis); });
                }
                return d2;
              }).then(function(d2) {
                if (!d2 || !d2.mainPhrase) {
                  log.push({ action: 'step2_fail' });
                  return out;
                }

                var pfx2 = (d2.prefix || '').trim();
                var cnt2 = getCount(d2.mainPhrase);
                log.push({ action: 'step2_parsed', prefix: pfx2, count: cnt2, phrase: d2.mainPhrase, basis_used: nextBasis });

                if (cnt2 > 0 && pfx2.indexOf('\uCD5C\uADFC') > -1) {
                  out.weekly_count = cnt2;
                  out.weekly_phrase = d2.mainPhrase;
                  out.weekly_prefix = pfx2;
                  log.push({ action: 'weekly_saved', count: cnt2, from_basis: nextBasis });
                } else if (cnt2 > 0 && pfx2.indexOf('\uC624\uB298') > -1) {
                  // ★ 아직 "오늘" → cnt2+1로 추적 (최대 3회)
                  log.push({ action: 'still_today', count: cnt2, will_chase: cnt2 + 1 });
                  out.today_count = cnt2;
                  out.today_phrase = d2.mainPhrase;

                  function chase(b, att) {
                    if (att > 3) { log.push({ action: 'chase_limit' }); return Promise.resolve(out); }
                    return wait(300).then(function() { return doFetch(b); }).then(function(d3) {
                      if (!d3 || !d3.mainPhrase) { log.push({ action: 'chase_fail', basis: b }); return out; }
                      var p3 = (d3.prefix || '').trim();
                      var c3 = getCount(d3.mainPhrase);
                      log.push({ action: 'chase_parsed', basis: b, prefix: p3, count: c3, attempt: att });
                      if (c3 > 0 && p3.indexOf('\uCD5C\uADFC') > -1) {
                        out.weekly_count = c3; out.weekly_phrase = d3.mainPhrase; out.weekly_prefix = p3;
                        return out;
                      }
                      if (c3 > 0 && p3.indexOf('\uC624\uB298') > -1) {
                        out.today_count = c3; return chase(c3 + 1, att + 1);
                      }
                      return out;
                    });
                  }
                  return chase(cnt2 + 1, 1);
                } else {
                  log.push({ action: 'step2_unexpected', prefix: pfx2, count: cnt2 });
                }
                return out;
              });
            }

            log.push({ action: 'unknown_prefix', prefix: pfx1 });
            return out;
          });

        }, { id: msgId, apiBase: apiBase });

        // ★ 결과 처리
        if (!msgResult || msgResult.status === 'skip') {
          purchaseDebug.skipped++;
          if (purchaseDebug.errors.length < 20) {
            purchaseDebug.errors.push({ pid: prodId, reason: msgResult ? msgResult.reason : 'null', log: msgResult ? msgResult.log : [] });
          }
        } else {
          if (msgResult.today_count !== null) {
            productMap[prodId].purchase_count_today = msgResult.today_count;
            productMap[prodId].purchase_text_today = msgResult.today_phrase;
            productMap[prodId].purchase_prefix_today = msgResult.today_prefix;
            purchaseDebug.todayOk++;
          }
          if (msgResult.weekly_count !== null) {
            productMap[prodId].purchase_count_weekly = msgResult.weekly_count;
            productMap[prodId].purchase_text_weekly = msgResult.weekly_phrase;
            productMap[prodId].purchase_prefix_weekly = msgResult.weekly_prefix;
            purchaseDebug.weeklyOk++;
          }
          productMap[prodId]._log = msgResult.log || [];

          // weekly 실패한 상품만 에러에 기록 (로그 포함)
          if (msgResult.today_count !== null && msgResult.weekly_count === null) {
            if (purchaseDebug.errors.length < 20) {
              purchaseDebug.errors.push({ pid: prodId, reason: 'weekly_miss', log: msgResult.log || [] });
            }
          }
        }

      } catch(err) {
        if (purchaseDebug.errors.length < 20) {
          purchaseDebug.errors.push({ pid: prodId, reason: String(err).substring(0, 100) });
        }
      }

      await apiPage.waitForTimeout(300);
    }

    result.debug.purchase = purchaseDebug;
    console.log('[v31] PHASE 3 완료: today=' + purchaseDebug.todayOk + ' weekly=' + purchaseDebug.weeklyOk + ' skip=' + purchaseDebug.skipped + ' err=' + purchaseDebug.errors.length);

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
  console.log('[naver_store v31] action=' + action);
  try {
    if (action === 'scrape') return res.json(await scrape(req.body));
    if (action === 'spy') return res.json(await spy(req.body));
    return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
  } catch(e) { if (!res.headersSent) return res.status(500).json({ status: 'ERROR', error: e.message || String(e) }); }
}

module.exports = { execute };
