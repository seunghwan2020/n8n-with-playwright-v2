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
    timezoneId: 'Asia/Seoul'
  };
}

// ============ SCRAPE v12: brand store + naver shopping API ============
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
    });

    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    // ===== PHASE 1: 브랜드스토어 상품 ID 수집 =====
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v12] Phase1: ' + targetUrl);
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

    // ===== PHASE 3: 네이버 쇼핑 API로 구매건수 수집 =====
    var purchaseMap = {};
    var searchDebug = { pages: 0, totalProducts: 0, matched: 0, errors: [], apiUrl: '' };

    try {
      // 먼저 네이버 쇼핑 페이지로 이동 (쿠키/세션 확보)
      console.log('[v12] Phase3: navigating to shopping search');
      await page.goto('https://search.shopping.naver.com/search/all?query=' + encodeURIComponent(storeName), {
        waitUntil: 'networkidle', timeout: 45000
      });
      await page.waitForTimeout(2000);

      // 네이버 쇼핑 내부 JSON API 호출
      var pageIdx = 1;
      var maxPages = 3;
      var totalMatched = 0;

      while (pageIdx <= maxPages) {
        var apiUrl = 'https://search.shopping.naver.com/api/search/all?sort=rel&pagingIndex=' + pageIdx + '&pagingSize=80&viewType=list&query=' + encodeURIComponent(storeName);
        searchDebug.apiUrl = apiUrl;

        var searchResult = await page.evaluate(function(args) {
          return fetch(args.url, {
            credentials: 'include',
            headers: { 'accept': 'application/json' }
          })
          .then(function(r) {
            if (!r.ok) return { ok: false, status: r.status };
            return r.json().then(function(json) { return { ok: true, data: json }; });
          })
          .catch(function(err) {
            return { ok: false, error: err.message || String(err) };
          });
        }, { url: apiUrl });

        searchDebug.pages = pageIdx;

        if (!searchResult || !searchResult.ok) {
          searchDebug.errors.push('page' + pageIdx + ': ' + (searchResult ? ('status=' + searchResult.status + ' ' + (searchResult.error || '')) : 'null'));
          break;
        }

        // API 응답 구조 파싱
        var items = [];
        var data = searchResult.data;

        // 디버그: 첫 페이지 응답 키
        if (pageIdx === 1) {
          searchDebug.responseKeys = data ? Object.keys(data).slice(0, 20) : [];
        }

        // 방법 A: shoppingResult.products
        if (data && data.shoppingResult && data.shoppingResult.products) {
          items = data.shoppingResult.products;
          if (pageIdx === 1) searchDebug.source = 'shoppingResult.products';
        }
        // 방법 B: data.products
        else if (data && data.products) {
          items = data.products;
          if (pageIdx === 1) searchDebug.source = 'data.products';
        }
        // 방법 C: data 자체가 배열
        else if (Array.isArray(data)) {
          items = data;
          if (pageIdx === 1) searchDebug.source = 'array';
        }

        if (pageIdx === 1) {
          searchDebug.itemCount = items.length;
          // 첫 상품의 키 구조
          if (items.length > 0) {
            searchDebug.firstItemKeys = Object.keys(items[0]).slice(0, 30);
            // purchase 관련 필드 모두
            var fp = items[0];
            var pf = {};
            var fKeys = Object.keys(fp);
            for (var fk = 0; fk < fKeys.length; fk++) {
              var key = fKeys[fk];
              var lower = key.toLowerCase();
              if (lower.indexOf('purchase') > -1 || lower.indexOf('count') > -1 ||
                  lower.indexOf('cumul') > -1 || lower.indexOf('mall') > -1 ||
                  lower.indexOf('channel') > -1 || lower.indexOf('product') > -1) {
                pf[key] = typeof fp[key] === 'object' ? JSON.stringify(fp[key]).slice(0, 100) : fp[key];
              }
            }
            searchDebug.firstItemPurchaseFields = pf;
          }
        }

        // 상품별 purchaseCount 매핑
        for (var ii = 0; ii < items.length; ii++) {
          var item = items[ii];
          var purchaseCnt = item.purchaseCnt || item.purchaseCount || item.purchase_cnt || 0;
          var channelProductNo = String(item.channelProductNo || '');
          var productNo = String(item.productNo || item.id || '');
          var mallProductId = String(item.mallProductId || '');

          if (purchaseCnt > 0) {
            if (channelProductNo) purchaseMap[channelProductNo] = purchaseCnt;
            if (productNo) purchaseMap[productNo] = purchaseCnt;
            if (mallProductId) purchaseMap[mallProductId] = purchaseCnt;
            totalMatched++;
          }
        }

        searchDebug.totalProducts += items.length;

        // 다음 페이지 있는지
        if (items.length < 80) break;
        pageIdx++;
        await page.waitForTimeout(500);
      }

      searchDebug.matched = totalMatched;
      searchDebug.purchaseMapSize = Object.keys(purchaseMap).length;
      console.log('[v12] Phase3: ' + searchDebug.totalProducts + ' search items, ' + totalMatched + ' with purchaseCount');

    } catch(searchErr) {
      searchDebug.errors.push(searchErr.message || String(searchErr));
    }

    result.debug.search = searchDebug;

    // ===== PHASE 4: 데이터 병합 =====
    result.method_used = 'api+shopping_api';
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

    console.log('[v12] FINAL: ' + result.data.length + ' products, ' + result.debug.withPurchase + ' with purchase');
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
