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

// ============ SPY: 상품 페이지 네트워크 전수 캡처 ============
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
        var parsed = null;
        try { parsed = JSON.parse(body); } catch(e) {}
        captured.push({
          url: reqUrl.length > 200 ? reqUrl.slice(0, 200) + '...' : reqUrl,
          status: response.status(),
          size: body.length,
          keys: parsed ? Object.keys(parsed).slice(0, 30) : [],
          has_purchase: body.indexOf('urchase') > -1 || body.indexOf('saleCount') > -1 || body.indexOf('cumulat') > -1,
          snippet: body.slice(0, 400)
        });
      }
    } catch(e) {}
  });

  try {
    await page.addInitScript(function() { Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } }); });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    return { status: 'OK', url: url, final_url: page.url(), captured_count: captured.length, captured: captured };
  } catch(e) {
    return { status: 'ERROR', error: e.message, captured_count: captured.length, captured: captured };
  } finally {
    await page.close();
    await ctx.close();
  }
}

// ============ SCRAPE ============
async function scrape(params) {
  var url = params.url;
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
  var result = { status: 'OK', data: [], channel_uid: '', error: null, method_used: 'dom_plus_api', debug: {} };

  var br = await getBrowser();
  var ctx = await br.newContext(ctxOpts());
  var page = await ctx.newPage();

  try {
    await page.addInitScript(function() { Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } }); });
    console.log('[naver_store] ' + storeSlug + ' -> ' + url);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // 스크롤 — 모든 상품 로드
    await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight / 2); });
    await page.waitForTimeout(1500);
    await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(1500);

    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    // STEP 1: __PRELOADED_STATE__ 에서 channelUid 추출
    var channelUid = await page.evaluate(function() {
      try {
        var state = window.__PRELOADED_STATE__;
        if (state && state.channel && state.channel.channelUid) {
          return state.channel.channelUid;
        }
      } catch(e) {}
      // fallback: HTML에서 직접 찾기
      try {
        var html = document.documentElement.innerHTML;
        var m = html.match(/"channelUid"\s*:\s*"([^"]+)"/);
        if (m) return m[1];
      } catch(e) {}
      return '';
    });

    result.channel_uid = channelUid;
    result.debug.channelUid = channelUid;

    // STEP 2: DOM에서 상품 목록 추출
    var domProducts = await page.evaluate(function() {
      var items = [];
      var seen = {};
      var allLinks = document.querySelectorAll('a[href*="/products/"]');
      for (var i = 0; i < allLinks.length; i++) {
        var link = allLinks[i];
        var href = link.getAttribute('href') || '';
        var m = href.match(/products\/(\d+)/);
        if (!m) continue;
        var pid = m[1];
        if (seen[pid]) continue;
        seen[pid] = true;
        var container = link.closest('li') || link.closest('[class*="product"]') || link.parentElement.parentElement;
        if (!container) container = link.parentElement;
        var allText = (container.innerText || '').trim();
        var imgEl = container.querySelector('img');
        var lines = allText.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 3; });
        var productName = '';
        for (var k = 0; k < lines.length; k++) {
          if (!/^\d/.test(lines[k]) && !/\uc6d0$/.test(lines[k]) && lines[k] !== '\uc0c1\ud488 \ubc14\ub85c\uac00\uae30' && lines[k] !== '\ud604\uc7ac \ud398\uc774\uc9c0' && lines[k].length > 3) {
            productName = lines[k];
            break;
          }
        }
        var priceMatch = allText.match(/(\d{1,3}(?:,\d{3})+)\uc6d0/);
        var salePrice = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0;
        var reviewMatch = allText.match(/\ub9ac\ubdf0\s*(\d[\d,]*)/);
        var reviewCount = reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, '')) : 0;
        if (productName) {
          items.push({
            product_id: pid,
            product_name: productName,
            sale_price: salePrice,
            product_image_url: imgEl ? (imgEl.getAttribute('src') || '').split('?')[0] : '',
            review_count: reviewCount
          });
        }
      }
      return items;
    });

    console.log('[naver_store] ' + storeSlug + ': ' + domProducts.length + ' products from DOM');

    // STEP 3: simple-products API 호출로 purchaseCount 가져오기
    var purchaseMap = {};
    var apiSuccess = false;
    var apiError = '';

    if (channelUid && domProducts.length > 0) {
      var productIds = domProducts.map(function(p) { return p.product_id; });

      // 배치로 나눠서 호출 (한번에 최대 20개)
      var batchSize = 20;
      var batches = [];
      for (var bi = 0; bi < productIds.length; bi += batchSize) {
        batches.push(productIds.slice(bi, bi + batchSize));
      }

      console.log('[naver_store] Fetching purchaseCount via simple-products API, ' + batches.length + ' batches');

      for (var bIdx = 0; bIdx < batches.length; bIdx++) {
        var batch = batches[bIdx];
        try {
          // 브라우저 컨텍스트 안에서 fetch — 쿠키/세션 자동 포함
          var batchResult = await page.evaluate(function(args) {
            var chUid = args.chUid;
            var ids = args.ids;
            var apiUrl = 'https://brand.naver.com/n/v1/products/simple-products?channelUid=' + chUid + '&simpleProductNos=' + ids.join(',');
            return fetch(apiUrl)
              .then(function(resp) {
                if (!resp.ok) {
                  return { status: resp.status, error: 'HTTP ' + resp.status, data: null };
                }
                return resp.json().then(function(json) {
                  return { status: 200, data: json, error: null };
                });
              })
              .catch(function(err) {
                return { status: 0, error: err.message || String(err), data: null };
              });
          }, { chUid: channelUid, ids: batch });

          if (batchResult && batchResult.status === 200 && batchResult.data) {
            apiSuccess = true;
            // simple-products 응답 파싱
            var simpleProducts = [];
            if (Array.isArray(batchResult.data)) {
              simpleProducts = batchResult.data;
            } else if (batchResult.data.simpleProducts) {
              simpleProducts = batchResult.data.simpleProducts;
            } else if (batchResult.data.products) {
              simpleProducts = batchResult.data.products;
            }

            // 디버그: 첫 배치 응답 구조 기록
            if (bIdx === 0) {
              result.debug.api_response_keys = Object.keys(batchResult.data);
              if (simpleProducts.length > 0) {
                result.debug.first_product_keys = Object.keys(simpleProducts[0]);
                // purchaseCount 관련 필드 모두 찾기
                var firstP = simpleProducts[0];
                var purchaseFields = {};
                for (var fk in firstP) {
                  if (fk.toLowerCase().indexOf('purchase') > -1 || fk.toLowerCase().indexOf('sale') > -1 || fk.toLowerCase().indexOf('count') > -1 || fk.toLowerCase().indexOf('cumul') > -1) {
                    purchaseFields[fk] = firstP[fk];
                  }
                }
                result.debug.purchase_related_fields = purchaseFields;
              }
              result.debug.first_batch_sample = JSON.stringify(batchResult.data).slice(0, 1000);
            }

            for (var si = 0; si < simpleProducts.length; si++) {
              var sp = simpleProducts[si];
              var spId = String(sp.id || sp.channelProductNo || sp.productNo || sp.simpleProductNo || '');
              var pc = sp.purchaseCount || sp.purchase_count || sp.saleCount || sp.cumulationSaleCount || 0;
              if (spId) {
                purchaseMap[spId] = pc;
              }
            }
          } else {
            apiError = batchResult ? (batchResult.error || 'status=' + batchResult.status) : 'null result';
            console.log('[naver_store] simple-products API batch ' + bIdx + ' failed: ' + apiError);
          }

          // API 레이트 리밋 방지
          if (bIdx < batches.length - 1) {
            await page.waitForTimeout(500);
          }
        } catch(batchErr) {
          apiError = batchErr.message || String(batchErr);
          console.log('[naver_store] simple-products API batch ' + bIdx + ' error: ' + apiError);
        }
      }
    } else {
      apiError = channelUid ? 'No products to query' : 'channelUid not found';
    }

    result.debug.api_success = apiSuccess;
    result.debug.api_error = apiError;
    result.debug.purchase_map_size = Object.keys(purchaseMap).length;
    result.debug.purchase_map_sample = {};
    var mapKeys = Object.keys(purchaseMap).slice(0, 3);
    for (var mk = 0; mk < mapKeys.length; mk++) {
      result.debug.purchase_map_sample[mapKeys[mk]] = purchaseMap[mapKeys[mk]];
    }

    // STEP 4: DOM 데이터 + purchaseCount 병합
    for (var d = 0; d < domProducts.length; d++) {
      var dp = domProducts[d];
      var purchaseCount = purchaseMap[dp.product_id] || 0;
      result.data.push({
        product_id: dp.product_id,
        product_name: dp.product_name,
        sale_price: dp.sale_price || 0,
        discount_price: null,
        review_count: dp.review_count || 0,
        purchase_count: purchaseCount,
        product_image_url: dp.product_image_url || '',
        category_name: '',
        is_sold_out: false,
        product_url: baseUrl + '/products/' + dp.product_id
      });
    }

    console.log('[naver_store] ' + storeSlug + ': ' + result.data.length + ' products, purchaseMap entries: ' + Object.keys(purchaseMap).length);
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

// ============ 진입점 ============
async function execute(action, req, res) {
  console.log('[naver_store] action=' + action);
  if (action === 'scrape') return res.json(await scrape(req.body));
  if (action === 'spy') return res.json(await spy(req.body));
  return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
}

module.exports = { execute };
