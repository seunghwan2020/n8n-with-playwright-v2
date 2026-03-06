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
    extraHTTPHeaders: {
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  };
}

// ============ SCRAPE v13: brand store + naver shopping DOM ============
async function scrape(params) {
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
  var storeName = params.store_name || storeSlug;
  var result = { status: 'OK', data: [], channel_uid: '', error: null, method_used: '', debug: {} };

  var br = await getBrowser();
  var ctx = await br.newContext(ctxOpts());
  var page = await ctx.newPage();

  try {
    await page.addInitScript(function() {
      Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
      Object.defineProperty(navigator, 'plugins', { get: function() { return [1, 2, 3, 4, 5]; } });
      Object.defineProperty(navigator, 'languages', { get: function() { return ['ko-KR', 'ko', 'en-US', 'en']; } });
      window.chrome = { runtime: {} };
    });

    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    // ===== PHASE 1: 브랜드스토어 상품 ID + 상세 =====
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v13] Phase1: ' + targetUrl);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    var prevHeight = 0;
    for (var si = 0; si < 15; si++) {
      await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
      await page.waitForTimeout(2000);
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
        out.allIds = Object.keys(idSet);
      } catch(e) {}
      return out;
    });

    var domIds = await page.evaluate(function() {
      var ids = {};
      var links = document.querySelectorAll('a[href*="/products/"]');
      for (var i = 0; i < links.length; i++) {
        var m = (links[i].getAttribute('href') || '').match(/products\/(\d+)/);
        if (m) ids[m[1]] = true;
      }
      return Object.keys(ids);
    });

    var allIdSet = {};
    for (var s1 = 0; s1 < stateInfo.allIds.length; s1++) allIdSet[stateInfo.allIds[s1]] = true;
    for (var d1 = 0; d1 < domIds.length; d1++) allIdSet[domIds[d1]] = true;
    var allIds = Object.keys(allIdSet);

    result.channel_uid = stateInfo.channelUid;
    result.debug.totalIds = allIds.length;

    // ===== PHASE 2: simple-products API 상품 상세 =====
    var productMap = {};
    if (stateInfo.channelUid && allIds.length > 0) {
      var batchSize = 20;
      for (var bi = 0; bi < allIds.length; bi += batchSize) {
        var batch = allIds.slice(bi, bi + batchSize);
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
              var reviewCount = 0;
              if (p.reviewAmount && typeof p.reviewAmount === 'object') reviewCount = p.reviewAmount.totalReviewCount || 0;
              var discountPrice = null;
              if (p.benefitsView && p.benefitsView.discountedSalePrice) discountPrice = p.benefitsView.discountedSalePrice;
              productMap[pid] = {
                product_id: pid,
                product_name: p.name || p.dispName || '',
                sale_price: p.salePrice || 0,
                discount_price: discountPrice,
                review_count: reviewCount,
                purchase_count: 0,
                product_image_url: (p.representativeImageUrl || '').split('?')[0],
                category_name: p.category ? (p.category.wholeCategoryName || '') : '',
                is_sold_out: (p.productStatusType === 'OUTOFSTOCK') || (p.soldout === true) || false,
                product_url: baseUrl + '/products/' + pid
              };
            }
          }
        } catch(e) {}
        if (bi + batchSize < allIds.length) await page.waitForTimeout(300);
      }
    }
    result.debug.apiProducts = Object.keys(productMap).length;
    console.log('[v13] Phase2: ' + Object.keys(productMap).length + ' products');

    // ===== PHASE 3: 네이버 쇼핑 검색 — 렌더링된 DOM에서 구매건수 추출 =====
    var purchaseMap = {};
    var searchDebug = { pages: 0, totalItems: 0, matched: 0, errors: [], htmlSample: '' };

    try {
      // 새 컨텍스트로 네이버 쇼핑 접근 (브라우저 핑거프린트 초기화)
      var searchCtx = await br.newContext(ctxOpts());
      var searchPage = await searchCtx.newPage();

      await searchPage.addInitScript(function() {
        Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
        Object.defineProperty(navigator, 'plugins', { get: function() { return [1, 2, 3, 4, 5]; } });
        Object.defineProperty(navigator, 'languages', { get: function() { return ['ko-KR', 'ko', 'en-US', 'en']; } });
        window.chrome = { runtime: {} };
      });

      // 먼저 네이버 메인 방문 (쿠키 획득)
      console.log('[v13] Phase3: visiting naver.com first');
      await searchPage.goto('https://www.naver.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await searchPage.waitForTimeout(2000);

      // 네이버 쇼핑 검색
      var searchUrl = 'https://search.shopping.naver.com/search/all?query=' + encodeURIComponent(storeName)
        + '&origQuery=' + encodeURIComponent(storeName)
        + '&pagingSize=80&viewType=list&sort=rel&productSet=channel';

      console.log('[v13] Phase3: ' + searchUrl);
      await searchPage.goto(searchUrl, { waitUntil: 'networkidle', timeout: 45000 });

      // React 렌더링 대기 — 상품 리스트 나타날 때까지
      try {
        await searchPage.waitForSelector('[class*="product_item"], [class*="product_info"], [class*="basicList_info"], li[class*="item"]', { timeout: 10000 });
        console.log('[v13] Phase3: product elements found');
      } catch(e) {
        console.log('[v13] Phase3: no product selector found, trying general wait');
      }
      await searchPage.waitForTimeout(3000);

      // 스크롤로 전체 로드
      for (var ssi = 0; ssi < 5; ssi++) {
        await searchPage.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
        await searchPage.waitForTimeout(1500);
      }

      searchDebug.pages = 1;

      // DOM에서 구매건수 추출 — 다양한 방식 시도
      var searchResult = await searchPage.evaluate(function() {
        var out = { items: [], htmlDebug: '', selectors: {} };

        // 전체 텍스트에서 "건 구매" 패턴 찾기
        var bodyText = document.body.innerText || '';
        var purchaseMatches = bodyText.match(/\d[\d,]*\s*\uAD6C\uB9E4/g);
        out.purchaseTextFound = purchaseMatches ? purchaseMatches.length : 0;

        // 방법 A: 모든 a 태그 중 상품 링크 + 부모에서 구매건수
        var allLinks = document.querySelectorAll('a');
        var seen = {};

        for (var i = 0; i < allLinks.length; i++) {
          var link = allLinks[i];
          var href = link.getAttribute('href') || '';

          // 스마트스토어/브랜드스토어 상품 링크 매칭
          var pidMatch = href.match(/(?:smartstore|brand)\.naver\.com\/[^/]+\/products\/(\d+)/);
          if (!pidMatch) continue;
          var pid = pidMatch[1];
          if (seen[pid]) continue;
          seen[pid] = true;

          // 상위 컨테이너 찾기 (li 또는 특정 클래스)
          var container = link.closest('li') || link.closest('[class*="item"]') || link.closest('[class*="product"]');
          if (!container) container = link.parentElement;
          if (!container) continue;

          var text = container.innerText || '';

          // 구매건수 패턴 매칭: "1,234건 구매" 또는 "1,234구매" 또는 "구매 1,234"
          var purchaseMatch = text.match(/(\d[\d,]*)\s*\uAD6C\uB9E4/);
          var purchaseCount = 0;
          if (purchaseMatch) {
            purchaseCount = parseInt(purchaseMatch[1].replace(/,/g, ''));
          }

          out.items.push({
            pid: pid,
            purchaseCount: purchaseCount,
            textSnippet: text.slice(0, 200)
          });
        }

        // 방법 B: data 속성에서 상품 정보 추출
        if (out.items.length === 0) {
          var dataEls = document.querySelectorAll('[data-nclicks-aid], [data-shp-contents-id], [data-nclicks]');
          out.selectors.dataElements = dataEls.length;

          for (var di = 0; di < dataEls.length; di++) {
            var el = dataEls[di];
            var dataId = el.getAttribute('data-shp-contents-id') || '';
            var container2 = el.closest('li') || el.closest('[class*="item"]') || el;
            var text2 = container2.innerText || '';
            var link2 = container2.querySelector('a[href*="products/"]');
            var href2 = link2 ? (link2.getAttribute('href') || '') : '';
            var pidMatch2 = href2.match(/products\/(\d+)/);

            if (pidMatch2 || dataId) {
              var purchaseMatch2 = text2.match(/(\d[\d,]*)\s*\uAD6C\uB9E4/);
              out.items.push({
                pid: pidMatch2 ? pidMatch2[1] : dataId,
                purchaseCount: purchaseMatch2 ? parseInt(purchaseMatch2[1].replace(/,/g, '')) : 0,
                textSnippet: text2.slice(0, 200)
              });
            }
          }
        }

        // 방법 C: __NEXT_DATA__ 시도
        if (out.items.length === 0) {
          try {
            var nextEl = document.getElementById('__NEXT_DATA__');
            if (nextEl) {
              var nd = JSON.parse(nextEl.textContent || '{}');
              var pp = (nd.props || {}).pageProps || {};
              out.nextDataKeys = Object.keys(pp).slice(0, 15);

              // 깊이 탐색
              var searchStr = JSON.stringify(nd);
              var pcMatches = searchStr.match(/"purchaseCnt"\s*:\s*(\d+)/g);
              if (pcMatches) {
                out.purchaseCntInNextData = pcMatches.length;
                out.purchaseCntSamples = pcMatches.slice(0, 5);
              }

              // 상품 데이터 찾기
              var findProducts = function(obj, depth) {
                if (depth > 5 || !obj) return [];
                if (Array.isArray(obj) && obj.length > 0 && obj[0] && (obj[0].purchaseCnt !== undefined || obj[0].channelProductNo)) {
                  return obj;
                }
                if (typeof obj === 'object') {
                  var keys = Object.keys(obj);
                  for (var k = 0; k < keys.length; k++) {
                    var found = findProducts(obj[keys[k]], depth + 1);
                    if (found.length > 0) return found;
                  }
                }
                return [];
              };
              var products = findProducts(nd, 0);
              if (products.length > 0) {
                out.nextDataProductCount = products.length;
                if (products[0]) {
                  out.nextDataFirstKeys = Object.keys(products[0]).slice(0, 20);
                }
                for (var ni = 0; ni < products.length; ni++) {
                  var np = products[ni];
                  var npId = String(np.channelProductNo || np.id || np.productNo || np.mallProductId || '');
                  var npPurchase = np.purchaseCnt || np.purchaseCount || 0;
                  if (npId) {
                    out.items.push({ pid: npId, purchaseCount: npPurchase });
                  }
                }
              }
            }
          } catch(e) {
            out.nextDataError = e.message || String(e);
          }
        }

        // 디버그: 페이지 HTML 일부
        var bodyHtml = document.body.innerHTML || '';
        // 구매 텍스트 주변 HTML
        var purchaseIdx = bodyHtml.indexOf('\uAD6C\uB9E4');
        if (purchaseIdx > -1) {
          out.htmlDebug = bodyHtml.slice(Math.max(0, purchaseIdx - 200), purchaseIdx + 200);
        }

        out.selectors.totalLinks = document.querySelectorAll('a').length;
        out.selectors.productLinks = document.querySelectorAll('a[href*="products/"]').length;
        out.selectors.storeLinks = document.querySelectorAll('a[href*="brand.naver.com"], a[href*="smartstore.naver.com"]').length;

        return out;
      });

      searchDebug.totalItems = searchResult.items.length;
      searchDebug.purchaseTextFound = searchResult.purchaseTextFound;
      searchDebug.selectors = searchResult.selectors;
      searchDebug.htmlDebug = searchResult.htmlDebug ? searchResult.htmlDebug.slice(0, 300) : '';
      searchDebug.nextDataKeys = searchResult.nextDataKeys;
      searchDebug.purchaseCntInNextData = searchResult.purchaseCntInNextData;
      searchDebug.purchaseCntSamples = searchResult.purchaseCntSamples;
      searchDebug.nextDataProductCount = searchResult.nextDataProductCount;
      searchDebug.nextDataFirstKeys = searchResult.nextDataFirstKeys;
      searchDebug.nextDataError = searchResult.nextDataError;

      // 첫 5개 결과 샘플
      searchDebug.sampleItems = searchResult.items.slice(0, 5);

      // purchaseMap 구축
      for (var ri = 0; ri < searchResult.items.length; ri++) {
        var item = searchResult.items[ri];
        if (item.pid && item.purchaseCount > 0) {
          purchaseMap[item.pid] = item.purchaseCount;
          searchDebug.matched++;
        }
      }

      console.log('[v13] Phase3: ' + searchResult.items.length + ' items, ' + searchDebug.matched + ' with purchase count');

      await searchPage.close();
      await searchCtx.close();
    } catch(searchErr) {
      searchDebug.errors.push(searchErr.message || String(searchErr));
      console.log('[v13] Phase3 error: ' + searchErr.message);
    }

    result.debug.search = searchDebug;

    // ===== PHASE 4: 데이터 병합 =====
    result.method_used = 'api+shopping_dom';
    var productIds = Object.keys(productMap);
    for (var fi = 0; fi < productIds.length; fi++) {
      var product = productMap[productIds[fi]];
      if (purchaseMap[product.product_id]) {
        product.purchase_count = purchaseMap[product.product_id];
      }
      result.data.push(product);
    }

    result.debug.total = result.data.length;
    result.debug.withPurchase = 0;
    for (var ci = 0; ci < result.data.length; ci++) {
      if (result.data[ci].purchase_count > 0) result.debug.withPurchase++;
    }
    result.debug.purchaseMapSize = Object.keys(purchaseMap).length;

    console.log('[v13] FINAL: ' + result.data.length + ' products, ' + result.debug.withPurchase + ' with purchase');
    if (result.data.length === 0) { result.status = 'EMPTY'; result.error = 'No products found'; }
  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message || String(e);
  } finally {
    await page.close();
    await ctx.close();
  }
  return result;
}

// ============ SPY ============
async function spy(params) {
  var url = params.url || 'https://brand.naver.com/dcurvin/products/12569074482';
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
    await page.addInitScript(function() { Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } }); });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
    return { status: 'OK', url: url, captured_count: captured.length, captured: captured };
  } catch(e) {
    return { status: 'ERROR', error: e.message, captured: captured };
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
