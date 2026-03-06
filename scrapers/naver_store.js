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

// ============ SCRAPE v10 ============
async function scrape(params) {
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
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

    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v10] ' + storeSlug + ' -> ' + targetUrl);
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
    result.debug.scrolls = si;

    // STEP 1: __PRELOADED_STATE__ 디버그 + 전체 상품 ID 수집
    var stateInfo = await page.evaluate(function() {
      var out = { channelUid: '', allProductIds: [], categoryProductsSample: null, error: null };
      try {
        var state = window.__PRELOADED_STATE__;
        if (!state) { out.error = 'no state'; return out; }

        // channelUid
        if (state.channel && state.channel.channelUid) out.channelUid = state.channel.channelUid;

        var idSet = {};

        // categoryProducts.simpleProducts 구조 확인
        if (state.categoryProducts && state.categoryProducts.simpleProducts) {
          var sp = state.categoryProducts.simpleProducts;
          out.categoryProductsCount = sp.length;
          out.categoryProductsType = typeof sp[0];
          if (sp.length > 0) {
            // 첫 번째 아이템이 숫자인지 객체인지 확인
            var first = sp[0];
            if (typeof first === 'number' || typeof first === 'string') {
              out.categoryProductsSample = { type: 'id', value: first };
              for (var i = 0; i < sp.length; i++) idSet[String(sp[i])] = true;
            } else if (typeof first === 'object' && first !== null) {
              out.categoryProductsSample = { type: 'object', keys: Object.keys(first).slice(0, 50) };
              // 모든 필드값 중 purchase/sale/count 관련 찾기
              var purchaseDebug = {};
              var allKeys = Object.keys(first);
              for (var pk = 0; pk < allKeys.length; pk++) {
                var key = allKeys[pk];
                var lower = key.toLowerCase();
                if (lower.indexOf('purchase') > -1 || lower.indexOf('count') > -1 ||
                    lower.indexOf('cumul') > -1 || lower.indexOf('order') > -1 ||
                    (lower.indexOf('sale') > -1 && lower !== 'salePrice' && lower !== 'saleType')) {
                  purchaseDebug[key] = first[key];
                }
              }
              out.categoryProductsPurchaseFields = purchaseDebug;

              for (var j = 0; j < sp.length; j++) {
                var pid = String(sp[j].id || sp[j].channelProductNo || sp[j].productNo || '');
                if (pid) idSet[pid] = true;
              }
            }
          }
        }

        // homeSetting.widgets productNos
        if (state.homeSetting && state.homeSetting.widgets) {
          var widgets = state.homeSetting.widgets;
          var wKeys = Object.keys(widgets);
          for (var wi = 0; wi < wKeys.length; wi++) {
            var w = widgets[wKeys[wi]];
            if (w && w.productNos && w.productNos.length > 0) {
              for (var pi = 0; pi < w.productNos.length; pi++) {
                idSet[String(w.productNos[pi])] = true;
              }
            }
          }
        }

        // categoryMenu mappingContent (상품 ID 목록)
        if (state.categoryMenu && state.categoryMenu.firstCategories) {
          var cats = state.categoryMenu.firstCategories;
          for (var ci = 0; ci < cats.length; ci++) {
            if (cats[ci].mappingConfig && cats[ci].mappingConfig.mappingType === 'PRODUCT') {
              var content = cats[ci].mappingConfig.mappingContent || '';
              var ids = content.split('|');
              for (var mi = 0; mi < ids.length; mi++) {
                if (ids[mi]) idSet[ids[mi]] = true;
              }
            }
          }
        }

        out.allProductIds = Object.keys(idSet);
      } catch(e) {
        out.error = e.message || String(e);
      }
      return out;
    });

    result.channel_uid = stateInfo.channelUid;
    result.debug.channelUid = stateInfo.channelUid;
    result.debug.categoryProductsCount = stateInfo.categoryProductsCount;
    result.debug.categoryProductsType = stateInfo.categoryProductsType;
    result.debug.categoryProductsSample = stateInfo.categoryProductsSample;
    result.debug.categoryProductsPurchaseFields = stateInfo.categoryProductsPurchaseFields;
    result.debug.stateError = stateInfo.error;
    result.debug.allProductIdsFromState = stateInfo.allProductIds.length;

    // DOM에서도 ID 수집
    var domIds = await page.evaluate(function() {
      var ids = {};
      var links = document.querySelectorAll('a[href*="/products/"]');
      for (var i = 0; i < links.length; i++) {
        var m = (links[i].getAttribute('href') || '').match(/products\/(\d+)/);
        if (m) ids[m[1]] = true;
      }
      return Object.keys(ids);
    });
    result.debug.domIdsCount = domIds.length;

    // 전체 ID 합치기
    var allIdSet = {};
    for (var si2 = 0; si2 < stateInfo.allProductIds.length; si2++) allIdSet[stateInfo.allProductIds[si2]] = true;
    for (var di = 0; di < domIds.length; di++) allIdSet[domIds[di]] = true;
    var allIds = Object.keys(allIdSet);
    result.debug.totalUniqueIds = allIds.length;

    // STEP 2: simple-products API 호출 (전체 ID)
    if (stateInfo.channelUid && allIds.length > 0) {
      var batchSize = 20;
      var apiProducts = [];
      var apiDebug = { batches: 0, success: 0, errors: [], firstProductAllKeys: null, firstProductPurchaseFields: null };

      for (var bi = 0; bi < allIds.length; bi += batchSize) {
        var batch = allIds.slice(bi, bi + batchSize);
        apiDebug.batches++;

        try {
          var apiResult = await page.evaluate(function(args) {
            var uid = args.uid;
            var ids = args.ids;
            var params = ids.map(function(id) { return 'ids[]=' + id; }).join('&');
            var apiUrl = 'https://brand.naver.com/n/v2/channels/' + uid + '/simple-products?' + params;

            return fetch(apiUrl, { credentials: 'include' })
              .then(function(resp) {
                if (!resp.ok) return { ok: false, status: resp.status };
                return resp.json().then(function(json) {
                  return { ok: true, data: json };
                });
              })
              .catch(function(err) {
                return { ok: false, error: err.message || String(err) };
              });
          }, { uid: stateInfo.channelUid, ids: batch });

          if (apiResult && apiResult.ok && Array.isArray(apiResult.data)) {
            apiDebug.success++;

            // 디버그: 첫 상품의 전체 키 목록
            if (!apiDebug.firstProductAllKeys && apiResult.data.length > 0) {
              var fp = apiResult.data[0];
              apiDebug.firstProductAllKeys = Object.keys(fp);
              // purchase 관련 필드 전부
              var pf = {};
              var fKeys = Object.keys(fp);
              for (var fk = 0; fk < fKeys.length; fk++) {
                var key = fKeys[fk];
                var lower = key.toLowerCase();
                if (lower.indexOf('purchase') > -1 || lower.indexOf('count') > -1 ||
                    lower.indexOf('cumul') > -1 || lower.indexOf('order') > -1 ||
                    lower.indexOf('amount') > -1 ||
                    (lower.indexOf('sale') > -1 && lower !== 'saleprice' && lower !== 'saletype')) {
                  pf[key] = fp[key];
                }
              }
              apiDebug.firstProductPurchaseFields = pf;

              // reviewAmount 구조도 확인
              if (fp.reviewAmount) {
                apiDebug.reviewAmountType = typeof fp.reviewAmount;
                if (typeof fp.reviewAmount === 'object') {
                  apiDebug.reviewAmountKeys = Object.keys(fp.reviewAmount);
                  apiDebug.reviewAmountSample = fp.reviewAmount;
                }
              }
            }

            for (var ai = 0; ai < apiResult.data.length; ai++) {
              apiProducts.push(apiResult.data[ai]);
            }
          } else {
            apiDebug.errors.push('batch' + apiDebug.batches + ': ' + (apiResult ? ('status=' + apiResult.status + ' ' + (apiResult.error || '')) : 'null'));
          }
        } catch(batchErr) {
          apiDebug.errors.push('batch' + apiDebug.batches + ': ' + (batchErr.message || String(batchErr)));
        }

        if (bi + batchSize < allIds.length) await page.waitForTimeout(500);
      }

      result.debug.api = apiDebug;
      result.debug.apiProductsTotal = apiProducts.length;

      // 상품 데이터 변환
      if (apiProducts.length > 0) {
        result.method_used = 'api_direct';
        var seen = {};
        for (var pi2 = 0; pi2 < apiProducts.length; pi2++) {
          var p = apiProducts[pi2];
          var pid = String(p.id || '');
          if (!pid || seen[pid]) continue;
          seen[pid] = true;

          // review
          var reviewCount = 0;
          if (p.reviewAmount) {
            if (typeof p.reviewAmount === 'object' && p.reviewAmount.totalReviewCount !== undefined) {
              reviewCount = p.reviewAmount.totalReviewCount;
            } else if (typeof p.reviewAmount === 'number') {
              reviewCount = p.reviewAmount;
            }
          }

          // discount
          var discountPrice = null;
          if (p.benefitsView && p.benefitsView.discountedSalePrice) {
            discountPrice = p.benefitsView.discountedSalePrice;
          }

          // category
          var categoryName = '';
          if (p.category) {
            categoryName = p.category.wholeCategoryName || p.category.categoryName || '';
          }

          // purchase — 가능한 모든 필드 체크
          var purchaseCount = 0;
          if (p.purchaseCount) purchaseCount = p.purchaseCount;
          else if (p.purchaseAmount) purchaseCount = p.purchaseAmount;
          else if (p.totalPurchaseCount) purchaseCount = p.totalPurchaseCount;
          else if (p.cumulationSaleCount) purchaseCount = p.cumulationSaleCount;
          else if (p.saleCount) purchaseCount = p.saleCount;

          result.data.push({
            product_id: pid,
            product_name: p.name || p.dispName || '',
            sale_price: p.salePrice || p.price || 0,
            discount_price: discountPrice,
            review_count: reviewCount,
            purchase_count: purchaseCount,
            product_image_url: (p.representativeImageUrl || '').split('?')[0],
            category_name: categoryName,
            is_sold_out: (p.productStatusType === 'OUTOFSTOCK') || (p.soldout === true) || false,
            product_url: baseUrl + '/products/' + pid
          });
        }
      }
    }

    result.debug.total = result.data.length;
    result.debug.withPurchase = 0;
    for (var fi = 0; fi < result.data.length; fi++) {
      if (result.data[fi].purchase_count > 0) result.debug.withPurchase++;
    }

    console.log('[v10] FINAL: ' + result.data.length + ' products, method=' + result.method_used);
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
