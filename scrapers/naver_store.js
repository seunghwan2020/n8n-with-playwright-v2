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

// ============ SCRAPE v9: __PRELOADED_STATE__ + direct API ============
async function scrape(params) {
  var url = params.url;
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

    // STEP 1: 전체상품 카테고리 페이지 로드
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[naver_store] ' + storeSlug + ' -> ' + targetUrl);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // 스크롤로 전체 로드
    var prevHeight = 0;
    for (var si = 0; si < 15; si++) {
      await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
      await page.waitForTimeout(2000);
      var curHeight = await page.evaluate(function() { return document.body.scrollHeight; });
      if (curHeight === prevHeight) break;
      prevHeight = curHeight;
    }

    // STEP 2: __PRELOADED_STATE__ 에서 데이터 추출
    var stateData = await page.evaluate(function() {
      var out = { channelUid: '', products: [], totalCount: 0, stateKeys: [], error: null };
      try {
        var state = window.__PRELOADED_STATE__;
        if (!state) { out.error = 'no __PRELOADED_STATE__'; return out; }
        out.stateKeys = Object.keys(state).slice(0, 30);

        // channelUid
        if (state.channel && state.channel.channelUid) {
          out.channelUid = state.channel.channelUid;
        }

        // 상품 데이터 소스 탐색 (카테고리 페이지)
        var sources = [];

        // 소스 1: categoryProducts
        if (state.categoryProducts && state.categoryProducts.simpleProducts) {
          var sp = state.categoryProducts.simpleProducts;
          if (sp.length > 0) sources.push({ name: 'categoryProducts', data: sp });
        }

        // 소스 2: bestProducts
        if (state.bestProducts) {
          var bpKeys = Object.keys(state.bestProducts);
          for (var bk = 0; bk < bpKeys.length; bk++) {
            var bp = state.bestProducts[bpKeys[bk]];
            if (bp && bp.bestProducts) {
              var bpTypes = Object.keys(bp.bestProducts);
              for (var bt = 0; bt < bpTypes.length; bt++) {
                var bpt = bp.bestProducts[bpTypes[bt]];
                if (bpt && bpt.simpleProducts && bpt.simpleProducts.length > 0) {
                  sources.push({ name: 'bestProducts.' + bpTypes[bt], data: bpt.simpleProducts });
                }
              }
            }
          }
        }

        // 소스 3: wholeProducts 또는 allProducts
        if (state.wholeProducts && state.wholeProducts.simpleProducts && state.wholeProducts.simpleProducts.length > 0) {
          sources.push({ name: 'wholeProducts', data: state.wholeProducts.simpleProducts });
        }

        // 소스 4: homeSetting의 위젯에 있는 productNos
        if (state.homeSetting && state.homeSetting.widgets) {
          var widgets = state.homeSetting.widgets;
          var wKeys = Object.keys(widgets);
          var allProductNos = [];
          for (var wi = 0; wi < wKeys.length; wi++) {
            var w = widgets[wKeys[wi]];
            if (w && w.productNos && w.productNos.length > 0) {
              for (var pi = 0; pi < w.productNos.length; pi++) {
                allProductNos.push(w.productNos[pi]);
              }
            }
          }
          if (allProductNos.length > 0) {
            sources.push({ name: 'homeSetting.productNos', data: allProductNos, idsOnly: true });
          }
        }

        // 가장 많은 상품 가진 소스 선택
        var bestSource = null;
        for (var s = 0; s < sources.length; s++) {
          if (!bestSource || sources[s].data.length > bestSource.data.length) {
            bestSource = sources[s];
          }
        }

        out.sourcesFound = sources.map(function(s) { return s.name + ':' + s.data.length; });

        if (bestSource && !bestSource.idsOnly) {
          out.totalCount = bestSource.data.length;
          var seen = {};
          for (var i = 0; i < bestSource.data.length; i++) {
            var p = bestSource.data[i];
            var pid = String(p.id || p.channelProductNo || p.productNo || '');
            if (!pid || seen[pid]) continue;
            seen[pid] = true;

            var reviewCount = 0;
            if (p.reviewAmount) {
              if (typeof p.reviewAmount === 'object' && p.reviewAmount.totalReviewCount !== undefined) {
                reviewCount = p.reviewAmount.totalReviewCount;
              } else if (typeof p.reviewAmount === 'number') {
                reviewCount = p.reviewAmount;
              }
            }

            var discountPrice = null;
            if (p.benefitsView && p.benefitsView.discountedSalePrice) {
              discountPrice = p.benefitsView.discountedSalePrice;
            }

            var categoryName = '';
            if (p.category) {
              categoryName = p.category.wholeCategoryName || p.category.categoryName || '';
            }

            // purchaseCount 관련 필드 모두 체크
            var purchaseCount = 0;
            if (p.purchaseCount !== undefined) purchaseCount = p.purchaseCount;
            else if (p.purchaseAmount !== undefined) purchaseCount = p.purchaseAmount;
            else if (p.totalPurchaseCount !== undefined) purchaseCount = p.totalPurchaseCount;
            else if (p.cumulationSaleCount !== undefined) purchaseCount = p.cumulationSaleCount;

            out.products.push({
              product_id: pid,
              product_name: p.name || p.dispName || '',
              sale_price: p.salePrice || p.price || 0,
              discount_price: discountPrice,
              review_count: reviewCount,
              purchase_count: purchaseCount,
              product_image_url: (p.representativeImageUrl || '').split('?')[0],
              category_name: categoryName,
              is_sold_out: (p.productStatusType === 'OUTOFSTOCK') || (p.soldout === true) || false
            });
          }
          // 디버그: 첫 상품의 키 구조
          if (bestSource.data.length > 0) {
            out.firstProductKeys = Object.keys(bestSource.data[0]).slice(0, 40);
            // purchase 관련 필드값 모두
            var fp = bestSource.data[0];
            out.purchaseFields = {};
            var allKeys = Object.keys(fp);
            for (var fk = 0; fk < allKeys.length; fk++) {
              var key = allKeys[fk];
              if (key.toLowerCase().indexOf('purchase') > -1 ||
                  key.toLowerCase().indexOf('sale') > -1 ||
                  key.toLowerCase().indexOf('count') > -1 ||
                  key.toLowerCase().indexOf('cumul') > -1 ||
                  key.toLowerCase().indexOf('order') > -1) {
                out.purchaseFields[key] = fp[key];
              }
            }
          }
        } else if (bestSource && bestSource.idsOnly) {
          // productNos만 있는 경우 — ID 목록만 반환
          out.productNosOnly = bestSource.data;
        }
      } catch(e) {
        out.error = e.message || String(e);
      }
      return out;
    });

    result.channel_uid = stateData.channelUid;
    result.debug.channelUid = stateData.channelUid;
    result.debug.stateKeys = stateData.stateKeys;
    result.debug.sourcesFound = stateData.sourcesFound;
    result.debug.preloaded_products = stateData.products.length;
    result.debug.firstProductKeys = stateData.firstProductKeys;
    result.debug.purchaseFields = stateData.purchaseFields;
    result.debug.stateError = stateData.error;

    // __PRELOADED_STATE__ 에서 상품 나왔으면 사용
    if (stateData.products.length > 0) {
      result.method_used = 'preloaded_state';
      for (var pi = 0; pi < stateData.products.length; pi++) {
        var sp = stateData.products[pi];
        sp.product_url = baseUrl + '/products/' + sp.product_id;
        result.data.push(sp);
      }
    }

    // DOM fallback: __PRELOADED_STATE__ 안 됐으면
    if (result.data.length === 0) {
      var domIds = await page.evaluate(function() {
        var ids = [];
        var seen = {};
        var links = document.querySelectorAll('a[href*="/products/"]');
        for (var i = 0; i < links.length; i++) {
          var m = (links[i].getAttribute('href') || '').match(/products\/(\d+)/);
          if (m && !seen[m[1]]) { seen[m[1]] = true; ids.push(m[1]); }
        }
        return ids;
      });
      result.debug.dom_ids_count = domIds.length;

      // DOM ID로 직접 상품 정보 추출
      if (domIds.length > 0) {
        var domProducts = await page.evaluate(function() {
          var items = [];
          var seen = {};
          var links = document.querySelectorAll('a[href*="/products/"]');
          for (var i = 0; i < links.length; i++) {
            var href = links[i].getAttribute('href') || '';
            var m = href.match(/products\/(\d+)/);
            if (!m || seen[m[1]]) continue;
            seen[m[1]] = true;
            var container = links[i].closest('li') || links[i].closest('[class*="product"]') || links[i].parentElement.parentElement;
            if (!container) container = links[i].parentElement;
            var text = (container.innerText || '').trim();
            var img = container.querySelector('img');
            var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 3; });
            var name = '';
            for (var k = 0; k < lines.length; k++) {
              if (!/^\d/.test(lines[k]) && !/\uc6d0$/.test(lines[k]) && lines[k].length > 3) {
                name = lines[k]; break;
              }
            }
            var priceMatch = text.match(/(\d{1,3}(?:,\d{3})+)\uc6d0/);
            if (name) {
              items.push({
                product_id: m[1], product_name: name,
                sale_price: priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0,
                product_image_url: img ? (img.getAttribute('src') || '').split('?')[0] : ''
              });
            }
          }
          return items;
        });

        result.method_used = 'dom_fallback';
        for (var d = 0; d < domProducts.length; d++) {
          var dp = domProducts[d];
          result.data.push({
            product_id: dp.product_id, product_name: dp.product_name, sale_price: dp.sale_price,
            discount_price: null, review_count: 0, purchase_count: 0,
            product_image_url: dp.product_image_url, category_name: '', is_sold_out: false,
            product_url: baseUrl + '/products/' + dp.product_id
          });
        }
      }
    }

    // STEP 3: purchaseCount가 전부 0이면 simple-products API 시도
    var allZeroPurchase = true;
    for (var ci = 0; ci < result.data.length; ci++) {
      if (result.data[ci].purchase_count > 0) { allZeroPurchase = false; break; }
    }

    if (allZeroPurchase && stateData.channelUid && result.data.length > 0) {
      console.log('[naver_store] All purchase_count=0, trying simple-products API...');
      var productIds = result.data.map(function(p) { return p.product_id; });

      // 배치 20개씩
      var purchaseMap = {};
      var apiDebug = { batches: 0, success: 0, errors: [], sampleResponse: null };
      var batchSize = 20;

      for (var bi = 0; bi < productIds.length; bi += batchSize) {
        var batch = productIds.slice(bi, bi + batchSize);
        apiDebug.batches++;

        try {
          var apiResult = await page.evaluate(function(args) {
            var uid = args.uid;
            var ids = args.ids;
            // ids[]=ID1&ids[]=ID2 형태
            var params = ids.map(function(id) { return 'ids[]=' + id; }).join('&');
            var apiUrl = 'https://brand.naver.com/n/v2/channels/' + uid + '/simple-products?' + params;

            return fetch(apiUrl, { credentials: 'include' })
              .then(function(resp) {
                return resp.text().then(function(txt) {
                  return {
                    ok: resp.ok,
                    status: resp.status,
                    body: txt.slice(0, 2000),
                    full: txt
                  };
                });
              })
              .catch(function(err) {
                return { ok: false, status: 0, error: err.message || String(err) };
              });
          }, { uid: stateData.channelUid, ids: batch });

          // 디버그: 첫 배치 응답 저장
          if (apiDebug.batches === 1) {
            apiDebug.sampleResponse = {
              ok: apiResult.ok,
              status: apiResult.status,
              bodyPreview: (apiResult.body || '').slice(0, 500)
            };
          }

          if (apiResult.ok) {
            apiDebug.success++;
            try {
              var parsed = JSON.parse(apiResult.full);
              var items = Array.isArray(parsed) ? parsed : [];
              for (var ai = 0; ai < items.length; ai++) {
                var item = items[ai];
                var itemId = String(item.id || '');
                var pc = item.purchaseCount || item.purchaseAmount || item.totalPurchaseCount || item.cumulationSaleCount || 0;
                if (itemId) purchaseMap[itemId] = pc;
              }
            } catch(pe) {
              apiDebug.errors.push('parse: ' + pe.message);
            }
          } else {
            apiDebug.errors.push('batch' + apiDebug.batches + ': status=' + apiResult.status);
          }
        } catch(batchErr) {
          apiDebug.errors.push('batch' + apiDebug.batches + ': ' + (batchErr.message || String(batchErr)));
        }

        if (bi + batchSize < productIds.length) {
          await page.waitForTimeout(500);
        }
      }

      result.debug.api = apiDebug;
      result.debug.purchaseMapSize = Object.keys(purchaseMap).length;

      // 병합
      if (Object.keys(purchaseMap).length > 0) {
        result.method_used = result.method_used + '+api';
        for (var mi = 0; mi < result.data.length; mi++) {
          if (purchaseMap[result.data[mi].product_id]) {
            result.data[mi].purchase_count = purchaseMap[result.data[mi].product_id];
          }
        }
      }
    }

    // 최종 통계
    result.debug.total = result.data.length;
    result.debug.withPurchase = 0;
    for (var fi = 0; fi < result.data.length; fi++) {
      if (result.data[fi].purchase_count > 0) result.debug.withPurchase++;
    }

    console.log('[naver_store] FINAL: ' + result.data.length + ' products, method=' + result.method_used);

    if (result.data.length === 0) {
      result.status = 'EMPTY';
      result.error = 'No products found';
    }
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

// ============ 진입점 ============
async function execute(action, req, res) {
  console.log('[naver_store] action=' + action);
  if (action === 'scrape') return res.json(await scrape(req.body));
  if (action === 'spy') return res.json(await spy(req.body));
  return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
}

module.exports = { execute };
