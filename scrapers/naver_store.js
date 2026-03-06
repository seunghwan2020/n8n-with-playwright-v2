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

// ============ SCRAPE v8: 전체상품 + correct API ============
async function scrape(params) {
  var url = params.url;
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
  var result = { status: 'OK', data: [], channel_uid: '', error: null, method_used: '', debug: {} };

  var br = await getBrowser();
  var ctx = await br.newContext(ctxOpts());
  var page = await ctx.newPage();

  // 네트워크 캡처 변수
  var capturedChannelUid = '';
  var capturedSimpleProducts = [];

  page.on('response', async function(response) {
    try {
      var reqUrl = response.url();
      var ct = response.headers()['content-type'] || '';
      if (ct.indexOf('json') === -1 || response.status() !== 200) return;

      // channelUid 추출
      if (!capturedChannelUid) {
        var uidMatch = reqUrl.match(/channels\/([a-zA-Z0-9_-]+)\//);
        if (uidMatch) capturedChannelUid = uidMatch[1];
      }

      // simple-products 응답 캡처
      if (reqUrl.indexOf('simple-products') > -1) {
        var body = await response.json();
        if (Array.isArray(body)) {
          for (var i = 0; i < body.length; i++) capturedSimpleProducts.push(body[i]);
          console.log('[naver_store] captured simple-products batch: ' + body.length + ', total: ' + capturedSimpleProducts.length);
        }
      }
    } catch(e) {}
  });

  try {
    await page.addInitScript(function() {
      Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
    });

    // STEP 1: 전체상품 페이지로 이동 (모든 상품 노출)
    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    // URL에 category=ALL 추가하여 전체상품 페이지로 직접 이동
    var allProductsUrl = url;
    if (url.indexOf('category=') === -1) {
      allProductsUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    }

    console.log('[naver_store] ' + storeSlug + ' -> ' + allProductsUrl);
    await page.goto(allProductsUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // STEP 2: 반복 스크롤로 전체 상품 로드 (infinite scroll)
    var prevHeight = 0;
    for (var scrollIdx = 0; scrollIdx < 10; scrollIdx++) {
      await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
      await page.waitForTimeout(2000);
      var curHeight = await page.evaluate(function() { return document.body.scrollHeight; });
      if (curHeight === prevHeight) break;
      prevHeight = curHeight;
    }
    console.log('[naver_store] scroll complete, iterations: ' + (scrollIdx + 1));

    // channelUid fallback: __PRELOADED_STATE__에서 추출
    if (!capturedChannelUid) {
      capturedChannelUid = await page.evaluate(function() {
        try {
          var state = window.__PRELOADED_STATE__;
          if (state && state.channel && state.channel.channelUid) return state.channel.channelUid;
        } catch(e) {}
        try {
          var html = document.documentElement.innerHTML;
          var m = html.match(/"channelUid"\s*:\s*"([^"]+)"/);
          if (m) return m[1];
        } catch(e) {}
        return '';
      });
    }

    result.channel_uid = capturedChannelUid;
    result.debug.channelUid = capturedChannelUid;
    result.debug.captured_simple_products_count = capturedSimpleProducts.length;

    // ========== 방법 1: 네트워크 자동 캡처 사용 (최우선) ==========
    if (capturedSimpleProducts.length > 0) {
      result.method_used = 'network_capture';
      var seen = {};
      for (var i = 0; i < capturedSimpleProducts.length; i++) {
        var p = capturedSimpleProducts[i];
        var pid = String(p.id || '');
        if (!pid || seen[pid]) continue;
        seen[pid] = true;
        result.data.push(mapSimpleProduct(p, baseUrl));
      }
      console.log('[naver_store] method1 network_capture: ' + result.data.length + ' products');
    }

    // ========== 방법 2: DOM에서 ID 추출 → 올바른 API 직접 호출 ==========
    if (result.data.length < 10 && capturedChannelUid) {
      // DOM에서 상품 ID 수집
      var domProductIds = await page.evaluate(function() {
        var ids = [];
        var seen = {};
        var links = document.querySelectorAll('a[href*="/products/"]');
        for (var i = 0; i < links.length; i++) {
          var m = (links[i].getAttribute('href') || '').match(/products\/(\d+)/);
          if (m && !seen[m[1]]) {
            seen[m[1]] = true;
            ids.push(m[1]);
          }
        }
        return ids;
      });

      result.debug.dom_product_ids_count = domProductIds.length;
      console.log('[naver_store] DOM found ' + domProductIds.length + ' product IDs');

      if (domProductIds.length > 0) {
        // 배치 20개씩 API 호출
        var batchSize = 20;
        var allApiProducts = [];
        var apiErrors = [];

        for (var bi = 0; bi < domProductIds.length; bi += batchSize) {
          var batch = domProductIds.slice(bi, bi + batchSize);
          try {
            var batchResult = await page.evaluate(function(args) {
              var uid = args.uid;
              var ids = args.ids;
              // 올바른 URL: /n/v2/channels/{uid}/simple-products?ids[]=id1&ids[]=id2&...
              var params = ids.map(function(id) { return 'ids[]=' + id; }).join('&');
              var apiUrl = 'https://brand.naver.com/n/v2/channels/' + uid + '/simple-products?' + params;
              return fetch(apiUrl, { credentials: 'include' })
                .then(function(resp) {
                  if (!resp.ok) return { ok: false, status: resp.status, data: null };
                  return resp.json().then(function(json) {
                    return { ok: true, data: json };
                  });
                })
                .catch(function(err) {
                  return { ok: false, status: 0, error: err.message || String(err), data: null };
                });
            }, { uid: capturedChannelUid, ids: batch });

            if (batchResult && batchResult.ok && Array.isArray(batchResult.data)) {
              for (var ai = 0; ai < batchResult.data.length; ai++) {
                allApiProducts.push(batchResult.data[ai]);
              }
              console.log('[naver_store] API batch ok: +' + batchResult.data.length + ', total: ' + allApiProducts.length);
            } else {
              var errMsg = batchResult ? ('status=' + batchResult.status + ' ' + (batchResult.error || '')) : 'null';
              apiErrors.push(errMsg);
              console.log('[naver_store] API batch failed: ' + errMsg);
            }
          } catch(batchErr) {
            apiErrors.push(batchErr.message || String(batchErr));
          }

          // 레이트 리밋 방지
          if (bi + batchSize < domProductIds.length) {
            await page.waitForTimeout(500);
          }
        }

        result.debug.api_products_count = allApiProducts.length;
        result.debug.api_errors = apiErrors.length > 0 ? apiErrors.slice(0, 3) : [];

        // 네트워크 캡처 데이터와 API 데이터 병합
        if (allApiProducts.length > 0) {
          result.method_used = result.data.length > 0 ? 'network_plus_api' : 'direct_api';
          var existingIds = {};
          for (var ei = 0; ei < result.data.length; ei++) {
            existingIds[result.data[ei].product_id] = true;
          }
          for (var ni = 0; ni < allApiProducts.length; ni++) {
            var np = allApiProducts[ni];
            var npId = String(np.id || '');
            if (npId && !existingIds[npId]) {
              existingIds[npId] = true;
              result.data.push(mapSimpleProduct(np, baseUrl));
            }
          }
        }
      }
    }

    // ========== 방법 3: DOM fallback (API 전부 실패 시) ==========
    if (result.data.length === 0) {
      result.method_used = 'dom_fallback';
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

    // 디버그: 첫 상품 purchase_count 확인
    if (result.data.length > 0) {
      var sample = result.data[0];
      result.debug.first_product = {
        id: sample.product_id,
        name: (sample.product_name || '').slice(0, 30),
        purchase_count: sample.purchase_count,
        review_count: sample.review_count
      };
    }

    result.debug.total_products = result.data.length;
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

// simple-products API 응답 → 표준 상품 객체 변환
function mapSimpleProduct(p, baseUrl) {
  var pid = String(p.id || '');
  var reviewData = p.reviewAmount || {};
  var reviewCount = 0;
  if (typeof reviewData === 'object' && reviewData.totalReviewCount !== undefined) {
    reviewCount = reviewData.totalReviewCount;
  } else if (typeof reviewData === 'number') {
    reviewCount = reviewData;
  } else if (p.reviewCount) {
    reviewCount = p.reviewCount;
  }

  var purchaseCount = 0;
  if (p.purchaseCount !== undefined) purchaseCount = p.purchaseCount;
  else if (p.purchaseAmount !== undefined) purchaseCount = p.purchaseAmount;
  else if (p.totalPurchaseCount !== undefined) purchaseCount = p.totalPurchaseCount;
  else if (p.cumulationSaleCount !== undefined) purchaseCount = p.cumulationSaleCount;

  var discountPrice = null;
  if (p.benefitsView && p.benefitsView.discountedSalePrice) {
    discountPrice = p.benefitsView.discountedSalePrice;
  }

  var categoryName = '';
  if (p.category) {
    categoryName = p.category.wholeCategoryName || p.category.categoryName || '';
  }

  return {
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
  };
}

// ============ SPY (디버그용) ============
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
