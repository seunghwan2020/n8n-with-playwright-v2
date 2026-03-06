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

// "9명 이상 구매" -> 9, "1,234명 구매" -> 1234
function parsePurchaseCount(phrase) {
  if (!phrase) return 0;
  var m = phrase.match(/(\d[\d,]*)\s*\uBA85/);
  if (m) return parseInt(m[1].replace(/,/g, ''));
  return 0;
}

// ============ SCRAPE v18: brand store + marketing-message API ============
async function scrape(params) {
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
  var storeName = params.store_name || storeSlug;
  var result = { status: 'OK', data: [], channel_uid: '', error: null, method_used: 'api+marketing_message', debug: {} };

  var br = await getBrowser();
  var ctx = await br.newContext(ctxOpts());
  var page = await ctx.newPage();
  await page.addInitScript(stealth);

  try {
    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    // ===== PHASE 1: 상품 ID 수집 =====
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v18] P1: ' + targetUrl);
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    var prevHeight = 0;
    for (var si = 0; si < 5; si++) {
      await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
      await page.waitForTimeout(1500);
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
        var links = document.querySelectorAll('a[href*="/products/"]');
        for (var li = 0; li < links.length; li++) {
          var m = (links[li].getAttribute('href') || '').match(/products\/(\d+)/);
          if (m) idSet[m[1]] = true;
        }
        out.allIds = Object.keys(idSet);
      } catch(e) {}
      return out;
    });

    result.channel_uid = stateInfo.channelUid;
    result.debug.totalIds = stateInfo.allIds.length;

    // ===== PHASE 2: simple-products API + channelProductNo 추출 =====
    var productMap = {};
    var channelProductMap = {};
    if (stateInfo.channelUid && stateInfo.allIds.length > 0) {
      var batchSize = 20;
      for (var bi = 0; bi < stateInfo.allIds.length; bi += batchSize) {
        var batch = stateInfo.allIds.slice(bi, bi + batchSize);
        try {
          var apiResult = await page.evaluate(function(args) {
            var params = args.ids.map(function(id) { return 'ids[]=' + id; }).join('&');
            return fetch('https://brand.naver.com/n/v2/channels/' + args.uid + '/simple-products?' + params + '&useChannelProducts=false&excludeAuthBlind=false&excludeDisplayableFilter=false&forceOrder=true', { credentials: 'include' })
              .then(function(r) { return r.ok ? r.json() : null; })
              .catch(function() { return null; });
          }, { uid: stateInfo.channelUid, ids: batch });

          if (Array.isArray(apiResult)) {
            for (var ai = 0; ai < apiResult.length; ai++) {
              var p = apiResult[ai];
              var pid = String(p.id || '');
              if (!pid) continue;
              var rc = 0;
              if (p.reviewAmount && typeof p.reviewAmount === 'object') rc = p.reviewAmount.totalReviewCount || 0;
              var dp = null;
              if (p.benefitsView && p.benefitsView.discountedSalePrice) dp = p.benefitsView.discountedSalePrice;

              // channelProductNo 추출 (marketing-message API에서 사용)
              var cpn = String(p.channelProductNo || p.channelProductId || '');

              productMap[pid] = {
                product_id: pid,
                channel_product_no: cpn,
                product_name: p.name || p.dispName || '',
                sale_price: p.salePrice || 0,
                discount_price: dp,
                review_count: rc,
                purchase_count: 0,
                purchase_text: '',
                product_image_url: (p.representativeImageUrl || '').split('?')[0],
                category_name: p.category ? (p.category.wholeCategoryName || '') : '',
                is_sold_out: (p.productStatusType === 'OUTOFSTOCK') || (p.soldout === true) || false,
                product_url: baseUrl + '/products/' + pid
              };

              if (cpn) channelProductMap[pid] = cpn;

              // 첫 상품의 전체 키 덤프 (디버그)
              if (ai === 0 && bi === 0) {
                result.debug.firstProductKeys = Object.keys(p).slice(0, 50);
                // ID 관련 필드 모두
                var idFields = {};
                var pKeys = Object.keys(p);
                for (var pk = 0; pk < pKeys.length; pk++) {
                  var key = pKeys[pk];
                  var lower = key.toLowerCase();
                  if (lower.indexOf('id') > -1 || lower.indexOf('no') > -1 ||
                      lower.indexOf('channel') > -1 || lower.indexOf('product') > -1) {
                    var val = p[key];
                    idFields[key] = typeof val === 'object' ? JSON.stringify(val).slice(0, 100) : val;
                  }
                }
                result.debug.firstProductIdFields = idFields;
              }
            }
          }
        } catch(e) {}
        if (bi + batchSize < stateInfo.allIds.length) await page.waitForTimeout(200);
      }
    }
    result.debug.apiProducts = Object.keys(productMap).length;
    result.debug.channelProductMapped = Object.keys(channelProductMap).length;

    // ===== PHASE 3: marketing-message API로 구매건수 가져오기 =====
    var purchaseDebug = { total: 0, success: 0, withPurchase: 0, errors: [], sampleResponses: [] };

    var allPids = Object.keys(productMap);
    console.log('[v18] P3: fetching marketing-message for ' + allPids.length + ' products');

    for (var mi = 0; mi < allPids.length; mi++) {
      var prodId = allPids[mi];
      var prod = productMap[prodId];
      // marketing-message ID로 channelProductNo 사용, 없으면 원래 product_id
      var msgId = prod.channel_product_no || prodId;

      try {
        var msgResult = await page.evaluate(function(args) {
          var url = 'https://brand.naver.com/n/v1/marketing-message/' + args.id
            + '?currentPurchaseType=Paid&usePurchased=true&basisPurchased=1'
            + '&usePurchasedIn2Y=true&useRepurchased=true&basisRepurchased=1';
          return fetch(url, { credentials: 'include' })
            .then(function(r) {
              if (!r.ok) return { ok: false, status: r.status };
              return r.json().then(function(data) {
                return { ok: true, data: data };
              });
            })
            .catch(function(err) {
              return { ok: false, error: err.message || String(err) };
            });
        }, { id: msgId });

        purchaseDebug.total++;

        if (msgResult && msgResult.ok && msgResult.data) {
          purchaseDebug.success++;
          var phrase = msgResult.data.mainPhrase || '';
          prod.purchase_text = phrase;

          // "9명 이상 구매" -> 9
          var count = 0;
          var numMatch = phrase.match(/(\d[\d,]*)\s*\uBA85/);
          if (numMatch) count = parseInt(numMatch[1].replace(/,/g, ''));
          prod.purchase_count = count;

          if (count > 0) purchaseDebug.withPurchase++;

          // 처음 5개 샘플 저장
          if (purchaseDebug.sampleResponses.length < 5) {
            purchaseDebug.sampleResponses.push({
              productId: prodId,
              msgId: msgId,
              phrase: phrase,
              count: count
            });
          }
        } else {
          if (purchaseDebug.errors.length < 3) {
            purchaseDebug.errors.push({
              productId: prodId,
              msgId: msgId,
              status: msgResult ? msgResult.status : 'null',
              error: msgResult ? msgResult.error : 'null'
            });
          }
        }
      } catch(e) {
        if (purchaseDebug.errors.length < 3) {
          purchaseDebug.errors.push({ productId: prodId, error: e.message || String(e) });
        }
      }

      // Rate limit: 10개마다 200ms 대기
      if (mi > 0 && mi % 10 === 0) await page.waitForTimeout(200);
    }

    result.debug.purchase = purchaseDebug;
    console.log('[v18] P3: ' + purchaseDebug.success + '/' + purchaseDebug.total + ' success, ' + purchaseDebug.withPurchase + ' with purchase');

    // ===== PHASE 4: 결과 조립 =====
    var pids = Object.keys(productMap);
    for (var fi = 0; fi < pids.length; fi++) {
      var prod2 = productMap[pids[fi]];
      result.data.push({
        product_id: prod2.product_id,
        product_name: prod2.product_name,
        sale_price: prod2.sale_price,
        discount_price: prod2.discount_price,
        review_count: prod2.review_count,
        purchase_count: prod2.purchase_count,
        purchase_text: prod2.purchase_text,
        product_image_url: prod2.product_image_url,
        category_name: prod2.category_name,
        is_sold_out: prod2.is_sold_out,
        product_url: prod2.product_url
      });
    }

    result.debug.total = result.data.length;
    result.debug.withPurchase = purchaseDebug.withPurchase;

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
          has_purchase: body.indexOf('urchase') > -1 || body.indexOf('saleCount') > -1 || body.indexOf('\uAD6C\uB9E4') > -1,
          snippet: body.slice(0, 500)
        });
      }
    } catch(e) {}
  });
  try {
    await page.addInitScript(stealth);
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
