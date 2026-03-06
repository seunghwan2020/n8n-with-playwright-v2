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

// ============ SCRAPE v11: brand store + naver shopping search ============
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

    // ===== PHASE 1: 브랜드스토어에서 상품 ID 수집 =====
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v11] Phase1: ' + targetUrl);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // 스크롤
    var prevHeight = 0;
    for (var si = 0; si < 15; si++) {
      await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
      await page.waitForTimeout(2000);
      var curHeight = await page.evaluate(function() { return document.body.scrollHeight; });
      if (curHeight === prevHeight) break;
      prevHeight = curHeight;
    }

    // __PRELOADED_STATE__ + DOM에서 전체 상품 ID 수집
    var stateInfo = await page.evaluate(function() {
      var out = { channelUid: '', channelNo: '', allIds: [] };
      try {
        var state = window.__PRELOADED_STATE__;
        if (!state) return out;
        if (state.channel) {
          out.channelUid = state.channel.channelUid || '';
          out.channelNo = String(state.channel.id || state.channel.channelNo || '');
        }
        var idSet = {};

        // categoryProducts
        if (state.categoryProducts && state.categoryProducts.simpleProducts) {
          var sp = state.categoryProducts.simpleProducts;
          for (var i = 0; i < sp.length; i++) {
            var pid = typeof sp[i] === 'object' ? String(sp[i].id || '') : String(sp[i]);
            if (pid) idSet[pid] = true;
          }
        }
        // homeSetting widgets
        if (state.homeSetting && state.homeSetting.widgets) {
          var wKeys = Object.keys(state.homeSetting.widgets);
          for (var wi = 0; wi < wKeys.length; wi++) {
            var w = state.homeSetting.widgets[wKeys[wi]];
            if (w && w.productNos) {
              for (var pi = 0; pi < w.productNos.length; pi++) idSet[String(w.productNos[pi])] = true;
            }
          }
        }
        // categoryMenu mappingContent
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

    // DOM IDs 추가
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
    result.debug.channelUid = stateInfo.channelUid;
    result.debug.channelNo = stateInfo.channelNo;
    result.debug.totalIds = allIds.length;

    // ===== PHASE 2: simple-products API로 상품 상세 가져오기 =====
    var productMap = {};
    if (stateInfo.channelUid && allIds.length > 0) {
      var batchSize = 20;
      for (var bi = 0; bi < allIds.length; bi += batchSize) {
        var batch = allIds.slice(bi, bi + batchSize);
        try {
          var apiResult = await page.evaluate(function(args) {
            var params = args.ids.map(function(id) { return 'ids[]=' + id; }).join('&');
            var apiUrl = 'https://brand.naver.com/n/v2/channels/' + args.uid + '/simple-products?' + params;
            return fetch(apiUrl, { credentials: 'include' })
              .then(function(r) { return r.ok ? r.json() : null; })
              .catch(function() { return null; });
          }, { uid: stateInfo.channelUid, ids: batch });

          if (Array.isArray(apiResult)) {
            for (var ai = 0; ai < apiResult.length; ai++) {
              var p = apiResult[ai];
              var pid = String(p.id || '');
              if (!pid) continue;

              var reviewCount = 0;
              if (p.reviewAmount && typeof p.reviewAmount === 'object') {
                reviewCount = p.reviewAmount.totalReviewCount || 0;
              }

              var discountPrice = null;
              if (p.benefitsView && p.benefitsView.discountedSalePrice) {
                discountPrice = p.benefitsView.discountedSalePrice;
              }

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
    console.log('[v11] Phase2: ' + Object.keys(productMap).length + ' products from API');

    // ===== PHASE 3: 네이버 쇼핑 검색에서 구매건수 수집 =====
    var purchaseMap = {};
    var searchDebug = { pages: 0, matched: 0, totalFound: 0, errors: [] };

    try {
      // 네이버 쇼핑에서 스토어명으로 검색
      var searchQuery = storeName;
      var searchUrl = 'https://search.shopping.naver.com/search/all?query=' + encodeURIComponent(searchQuery)
        + '&channel=naver_store&pageSize=80&sort=rel';

      console.log('[v11] Phase3: searching ' + searchUrl);
      await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 45000 });
      await page.waitForTimeout(3000);

      // __NEXT_DATA__ 에서 검색 결과 추출
      var searchResult = await page.evaluate(function() {
        var out = { products: [], error: null, source: '' };
        try {
          // 방법 1: __NEXT_DATA__
          var nextDataEl = document.getElementById('__NEXT_DATA__');
          if (nextDataEl) {
            var nextData = JSON.parse(nextDataEl.textContent);
            out.source = '__NEXT_DATA__';

            // 검색 결과에서 상품 목록 찾기
            var props = nextData.props || {};
            var pageProps = props.pageProps || {};
            var initialState = pageProps.initialState || {};

            // products 경로 탐색
            var productsData = null;
            if (initialState.products && initialState.products.list) {
              productsData = initialState.products.list;
            } else if (pageProps.products) {
              productsData = pageProps.products;
            }

            if (productsData && Array.isArray(productsData)) {
              for (var i = 0; i < productsData.length; i++) {
                var item = productsData[i];
                // item.item 구조일 수 있음
                var product = item.item || item;
                var channelProductNo = String(product.channelProductNo || product.id || product.productNo || '');
                var purchaseCount = product.purchaseCnt || product.purchaseCount || product.purchase_cnt || 0;
                var mallName = product.mallName || product.storeName || '';

                if (channelProductNo) {
                  out.products.push({
                    id: channelProductNo,
                    productNo: String(product.productNo || ''),
                    purchaseCount: purchaseCount,
                    mallName: mallName,
                    productName: (product.productName || product.name || '').slice(0, 50)
                  });
                }
              }
            }

            // 디버그: 구조 확인
            if (out.products.length === 0) {
              out.nextDataKeys = Object.keys(pageProps).slice(0, 20);
              if (initialState) out.initialStateKeys = Object.keys(initialState).slice(0, 20);
              // 다른 경로 탐색
              var searchProducts = initialState.products || {};
              out.productsKeys = Object.keys(searchProducts).slice(0, 20);
            }
          }

          // 방법 2: window.__SEARCH_STORE__ 또는 유사 글로벌
          if (out.products.length === 0) {
            var globals = ['__SEARCH_STORE__', '__PRELOADED_STATE__', '__INITIAL_STATE__'];
            for (var gi = 0; gi < globals.length; gi++) {
              if (window[globals[gi]]) {
                out.source = globals[gi];
                out.globalKeys = Object.keys(window[globals[gi]]).slice(0, 20);
                break;
              }
            }
          }

          // 방법 3: DOM에서 구매건수 텍스트 추출
          if (out.products.length === 0) {
            out.source = 'dom_text';
            var allItems = document.querySelectorAll('[class*="product_item"], [class*="basicList_item"]');
            for (var di = 0; di < allItems.length; di++) {
              var el = allItems[di];
              var text = (el.innerText || '').trim();
              var linkEl = el.querySelector('a[href*="smartstore.naver.com"], a[href*="brand.naver.com"], a[href*="naver.com/products/"]');
              var href = linkEl ? (linkEl.getAttribute('href') || '') : '';
              var pidMatch = href.match(/products\/(\d+)/);
              var purchaseMatch = text.match(/(\d[\d,]*)\s*\uAD6C\uB9E4/);
              if (pidMatch) {
                out.products.push({
                  id: pidMatch[1],
                  purchaseCount: purchaseMatch ? parseInt(purchaseMatch[1].replace(/,/g, '')) : 0,
                  mallName: '',
                  productName: ''
                });
              }
            }
          }
        } catch(e) {
          out.error = e.message || String(e);
        }
        return out;
      });

      searchDebug.source = searchResult.source;
      searchDebug.totalFound = searchResult.products.length;
      searchDebug.nextDataKeys = searchResult.nextDataKeys;
      searchDebug.initialStateKeys = searchResult.initialStateKeys;
      searchDebug.productsKeys = searchResult.productsKeys;
      searchDebug.globalKeys = searchResult.globalKeys;
      searchDebug.searchError = searchResult.error;
      searchDebug.pages = 1;

      // 검색 결과를 purchaseMap에 매핑
      for (var si2 = 0; si2 < searchResult.products.length; si2++) {
        var sp = searchResult.products[si2];
        if (sp.id && sp.purchaseCount > 0) {
          purchaseMap[sp.id] = sp.purchaseCount;
          // productNo로도 매핑 (ID 형식이 다를 수 있음)
          if (sp.productNo) purchaseMap[sp.productNo] = sp.purchaseCount;
        }
      }

      // 디버그: 첫 3개 검색 결과 샘플
      searchDebug.sampleResults = searchResult.products.slice(0, 5).map(function(p) {
        return { id: p.id, purchase: p.purchaseCount, name: p.productName };
      });

      searchDebug.matched = Object.keys(purchaseMap).length;
      console.log('[v11] Phase3: ' + searchResult.products.length + ' search results, ' + Object.keys(purchaseMap).length + ' with purchaseCount');

    } catch(searchErr) {
      searchDebug.errors.push(searchErr.message || String(searchErr));
      console.log('[v11] Phase3 error: ' + searchErr.message);
    }

    result.debug.search = searchDebug;

    // ===== PHASE 4: 데이터 병합 =====
    result.method_used = 'api+shopping_search';
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

    console.log('[v11] FINAL: ' + result.data.length + ' products, ' + result.debug.withPurchase + ' with purchase count');
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
