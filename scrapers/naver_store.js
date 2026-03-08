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
    method_used: 'v33_split',
    debug: { build: 'V33_SPLIT', storeSlug: storeSlug, storeType: storeType }
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
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v33] P1: ' + targetUrl);

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
        console.log('[v33] smartstore state wait timeout, continuing...');
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
      console.log('[v33] smartstore fallback: DOM scraping');
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
        console.log('[v33] DOM fallback found ' + domInfo.allIds.length + ' products');
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
        console.log('[v33] smartstore: opened brand.naver.com API page');
      } catch(e) {
        console.log('[v33] smartstore: brand page open failed, using original page');
        apiPage = page; // 실패하면 원래 페이지 사용
      }
    }

    // ===== PHASE 2: simple-products API =====
    // ★ v25.1: smartstore는 API 경로가 다름 + __PRELOADED_STATE__ fallback
    var productMap = {};
    var productNoMap = {};

    // ★ smartstore는 먼저 __PRELOADED_STATE__에서 직접 상품 데이터 추출 시도
    if (storeType === 'smartstore') {
      console.log('[v33] smartstore: extracting products from __PRELOADED_STATE__');
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

      console.log('[v33] smartstore state products: ' + stateProducts.products.length);

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
      console.log('[v33] missing IDs from state: ' + missingIds.length);
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
              console.log('[v33] API path ' + currentPath + ' failed: ' + (apiResult._status || apiResult._error));
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
          console.log('[v33] API path worked: ' + currentPath + ', products: ' + Object.keys(productMap).length);
          result.debug.apiPathUsed = currentPath;
          break;
        }
      }
    }

    result.debug.apiProducts = Object.keys(productMap).length;
    result.debug.productNoMapped = Object.keys(productNoMap).length;


    // ===== PHASE 3: marketing-message 구매건수 수집 =====
    // ★★★ v33: 오늘/주간 조회 완전 분리
    //
    // [근본 원인] usePurchased=true & useRepurchased=true 동시 전송 시
    //   API가 "오늘" 규칙을 우선 선택 → basisRepurchased 무시
    //
    // [해결] 두 번 분리 호출:
    //   1) 오늘 전용: usePurchased=true, useRepurchased=false
    //   2) 주간 전용: usePurchased=false, useRepurchased=true, basisRepurchased=(todayCount+1)
    //
    // ★ 실패 = null. 절대 0을 넣지 않는다. ★
    // ★★★

    var purchaseDebug = { total: 0, todayOk: 0, weeklyOk: 0, skipped: 0, errors: [] };
    var allPids = Object.keys(productMap);
    var msgApiPath = '/n/v1/marketing-message/';
    console.log('[v33] PHASE 3 시작: ' + allPids.length + '개 상품');

    for (var mi = 0; mi < allPids.length; mi++) {
      var prodId = allPids[mi];
      var msgId = productNoMap[prodId] || prodId;
      purchaseDebug.total++;

      try {
        var result33 = await apiPage.evaluate(function(args) {
          var base = args.apiBase + args.path + args.id + '?currentPurchaseType=Paid&usePurchasedIn2Y=true';

          function doFetch(url, retry) {
            retry = retry || 0;
            return fetch(url, { credentials: 'include', cache: 'no-store' })
              .then(function(r) { return r.ok ? r.json() : null; })
              .catch(function() { return null; })
              .then(function(d) {
                if (!d && retry < 2) {
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

          // ★ 1) 오늘 전용 조회: usePurchased=true, useRepurchased=false
          var todayUrl = base + '&usePurchased=true&basisPurchased=1&useRepurchased=false';
          out.log.push({ step: 'today', url_params: 'usePurchased=true&useRepurchased=false' });

          return doFetch(todayUrl).then(function(todayData) {
            if (todayData && todayData.mainPhrase) {
              var pfx = (todayData.prefix || '').trim();
              var cnt = getCount(todayData.mainPhrase);
              out.log.push({ step: 'today_result', prefix: pfx, count: cnt, phrase: todayData.mainPhrase });

              if (cnt > 0 && pfx.indexOf('\uC624\uB298') > -1) {
                out.today_count = cnt;
                out.today_phrase = todayData.mainPhrase;
                out.today_prefix = pfx;
              } else if (cnt > 0 && pfx.indexOf('\uCD5C\uADFC') > -1) {
                // usePurchased=true인데 "최근 1주간"이 나옴 = 오늘 구매 없음
                out.weekly_count = cnt;
                out.weekly_phrase = todayData.mainPhrase;
                out.weekly_prefix = pfx;
                out.log.push({ step: 'weekly_from_today_call', count: cnt });
              }
            } else {
              out.log.push({ step: 'today_fail' });
            }

            // ★ 2) 주간 전용 조회: usePurchased=false, useRepurchased=true
            //    오늘 구매가 있으면 basis=(todayCount+1), 없으면 basis=1
            var weeklyBasis = out.today_count ? (out.today_count + 1) : 1;
            // 이미 weekly를 확보했으면 skip
            if (out.weekly_count !== null) {
              out.log.push({ step: 'weekly_skip', reason: 'already_have' });
              return out;
            }

            var weeklyUrl = base + '&usePurchased=false&useRepurchased=true&basisRepurchased=' + weeklyBasis;
            out.log.push({ step: 'weekly', basis: weeklyBasis, url_params: 'usePurchased=false&useRepurchased=true&basisRepurchased=' + weeklyBasis });

            return new Promise(function(res) { setTimeout(res, 200); }).then(function() {
              return doFetch(weeklyUrl);
            }).then(function(weeklyData) {
              if (weeklyData && weeklyData.mainPhrase) {
                var wPfx = (weeklyData.prefix || '').trim();
                var wCnt = getCount(weeklyData.mainPhrase);
                out.log.push({ step: 'weekly_result', prefix: wPfx, count: wCnt, phrase: weeklyData.mainPhrase });

                if (wCnt > 0 && wPfx.indexOf('\uCD5C\uADFC') > -1) {
                  out.weekly_count = wCnt;
                  out.weekly_phrase = weeklyData.mainPhrase;
                  out.weekly_prefix = wPfx;
                }
                // "오늘"이 나오면 무시 (주간 전용인데 오늘이 나온 경우)
              } else {
                out.log.push({ step: 'weekly_fail' });
              }
              return out;
            });
          });

        }, { id: msgId, apiBase: apiBase, path: msgApiPath });

        // ★ 결과 저장
        if (result33) {
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
              purchaseDebug.errors.push({ pid: prodId, reason: 'weekly_miss', log: result33.log });
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

      await apiPage.waitForTimeout(300);
    }

    result.debug.purchase = purchaseDebug;
    console.log('[v33] PHASE 3 완료: today=' + purchaseDebug.todayOk + ' weekly=' + purchaseDebug.weeklyOk + ' skip=' + purchaseDebug.skipped);


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
  console.log('[naver_store v33] action=' + action);
  try {
    if (action === 'scrape') return res.json(await scrape(req.body));
    if (action === 'spy') return res.json(await spy(req.body));
    return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
  } catch(e) { if (!res.headersSent) return res.status(500).json({ status: 'ERROR', error: e.message || String(e) }); }
}

module.exports = { execute };
