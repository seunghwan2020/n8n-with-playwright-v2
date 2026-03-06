const { chromium } = require('playwright');

let browser = null;
let browserProxy = null;

async function getBrowser(proxy) {
  var proxyKey = proxy ? (proxy.server + proxy.username) : 'none';
  if (browser && browser.isConnected() && browserProxy === proxyKey) return browser;
  if (browser && browser.isConnected()) await browser.close();

  var opts = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  };
  if (proxy) opts.proxy = proxy;

  browser = await chromium.launch(opts);
  browserProxy = proxyKey;
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

// ============ SCRAPE v14: proxy + brand store + naver shopping ============
async function scrape(params) {
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
  var storeName = params.store_name || storeSlug;
  var result = { status: 'OK', data: [], channel_uid: '', error: null, method_used: '', debug: {} };

  // 프록시 설정 파싱
  var proxy = null;
  if (params.proxy_host && params.proxy_port) {
    proxy = {
      server: 'http://' + params.proxy_host + ':' + params.proxy_port
    };
    if (params.proxy_user && params.proxy_pass) {
      proxy.username = params.proxy_user;
      proxy.password = params.proxy_pass;
    }
    result.debug.proxyEnabled = true;
  } else {
    result.debug.proxyEnabled = false;
  }

  // Phase 1+2: 브랜드스토어 (프록시 없이 — 잘 작동함)
  var brNormal = await getBrowser(null);
  var ctx = await brNormal.newContext(ctxOpts());
  var page = await ctx.newPage();
  await page.addInitScript(stealth);

  try {
    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    // ===== PHASE 1: 브랜드스토어 상품 ID 수집 =====
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v14] P1: ' + targetUrl);
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

    // ===== PHASE 2: simple-products API =====
    var productMap = {};
    if (stateInfo.channelUid && stateInfo.allIds.length > 0) {
      var batchSize = 20;
      for (var bi = 0; bi < stateInfo.allIds.length; bi += batchSize) {
        var batch = stateInfo.allIds.slice(bi, bi + batchSize);
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
              var rc = 0;
              if (p.reviewAmount && typeof p.reviewAmount === 'object') rc = p.reviewAmount.totalReviewCount || 0;
              var dp = null;
              if (p.benefitsView && p.benefitsView.discountedSalePrice) dp = p.benefitsView.discountedSalePrice;
              productMap[pid] = {
                product_id: pid,
                product_name: p.name || p.dispName || '',
                sale_price: p.salePrice || 0,
                discount_price: dp,
                review_count: rc,
                purchase_count: 0,
                product_image_url: (p.representativeImageUrl || '').split('?')[0],
                category_name: p.category ? (p.category.wholeCategoryName || '') : '',
                is_sold_out: (p.productStatusType === 'OUTOFSTOCK') || (p.soldout === true) || false,
                product_url: baseUrl + '/products/' + pid
              };
            }
          }
        } catch(e) {}
        if (bi + batchSize < stateInfo.allIds.length) await page.waitForTimeout(200);
      }
    }
    result.debug.apiProducts = Object.keys(productMap).length;
    console.log('[v14] P2: ' + Object.keys(productMap).length + ' products');

    // 브랜드스토어 페이지 닫기
    await page.close();
    await ctx.close();

    // ===== PHASE 3: 네이버 쇼핑 검색 (프록시 사용) =====
    var purchaseMap = {};
    var searchDebug = { totalItems: 0, matched: 0, errors: [], method: '' };

    if (proxy) {
      try {
        var brProxy = await getBrowser(proxy);
        var proxyCtx = await brProxy.newContext(ctxOpts());
        var searchPage = await proxyCtx.newPage();
        await searchPage.addInitScript(stealth);

        var searchUrl = 'https://search.shopping.naver.com/search/all?query=' + encodeURIComponent(storeName)
          + '&origQuery=' + encodeURIComponent(storeName)
          + '&pagingSize=80&viewType=list&sort=rel';

        console.log('[v14] P3 (proxy): ' + searchUrl);
        await searchPage.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
        await searchPage.waitForTimeout(3000);

        // 스크롤
        for (var ss = 0; ss < 3; ss++) {
          await searchPage.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
          await searchPage.waitForTimeout(1500);
        }

        // __NEXT_DATA__ 딥서치 + DOM 추출
        var searchResult = await searchPage.evaluate(function() {
          var out = { items: [], method: '', purchaseTextCount: 0 };

          // 방법 A: __NEXT_DATA__
          try {
            var nextEl = document.getElementById('__NEXT_DATA__');
            if (nextEl) {
              var raw = nextEl.textContent || '';
              var allMatches = raw.match(/"purchaseCnt"\s*:\s*(\d+)/g);
              if (allMatches && allMatches.length > 0) {
                out.method = 'nextdata';
                var nd = JSON.parse(raw);
                var findItems = function(obj, depth) {
                  if (depth > 6 || !obj) return;
                  if (Array.isArray(obj)) {
                    for (var i = 0; i < obj.length; i++) findItems(obj[i], depth + 1);
                  } else if (typeof obj === 'object') {
                    if (obj.purchaseCnt !== undefined && (obj.channelProductNo || obj.mallProductId || obj.productNo)) {
                      out.items.push({
                        pid: String(obj.channelProductNo || obj.mallProductId || obj.productNo || ''),
                        purchaseCount: obj.purchaseCnt || 0,
                        name: (obj.productName || obj.productTitle || '').slice(0, 40)
                      });
                    }
                    var keys = Object.keys(obj);
                    for (var k = 0; k < keys.length; k++) findItems(obj[keys[k]], depth + 1);
                  }
                };
                findItems(nd, 0);
              }
            }
          } catch(e) {}

          // 방법 B: DOM
          if (out.items.length === 0) {
            out.method = 'dom';
            var bodyText = document.body.innerText || '';
            var purchaseMatches = bodyText.match(/\d[\d,]*\uAD6C\uB9E4/g);
            out.purchaseTextCount = purchaseMatches ? purchaseMatches.length : 0;

            var allLinks = document.querySelectorAll('a');
            var seen = {};
            for (var i = 0; i < allLinks.length; i++) {
              var href = allLinks[i].getAttribute('href') || '';
              var pidMatch = href.match(/(?:smartstore|brand)\.naver\.com\/[^/]+\/products\/(\d+)/);
              if (!pidMatch) continue;
              var id = pidMatch[1];
              if (seen[id]) continue;
              seen[id] = true;
              var container = allLinks[i].closest('li') || allLinks[i].closest('[class*="item"]') || allLinks[i].parentElement;
              if (!container) continue;
              var text = container.innerText || '';
              var pm = text.match(/(\d[\d,]*)\s*\uAD6C\uB9E4/);
              out.items.push({
                pid: id,
                purchaseCount: pm ? parseInt(pm[1].replace(/,/g, '')) : 0,
                name: ''
              });
            }
          }
          return out;
        });

        searchDebug.method = searchResult.method;
        searchDebug.totalItems = searchResult.items.length;
        searchDebug.purchaseTextCount = searchResult.purchaseTextCount;
        searchDebug.sampleItems = searchResult.items.slice(0, 5);

        for (var ri = 0; ri < searchResult.items.length; ri++) {
          var item = searchResult.items[ri];
          if (item.pid && item.purchaseCount > 0) {
            purchaseMap[item.pid] = item.purchaseCount;
            searchDebug.matched++;
          }
        }

        console.log('[v14] P3: ' + searchResult.items.length + ' items, ' + searchDebug.matched + ' with purchase');
        await searchPage.close();
        await proxyCtx.close();
      } catch(searchErr) {
        searchDebug.errors.push(searchErr.message || String(searchErr));
        console.log('[v14] P3 error: ' + searchErr.message);
      }
    } else {
      searchDebug.errors.push('no proxy configured');
    }

    result.debug.search = searchDebug;

    // ===== PHASE 4: 병합 =====
    result.method_used = proxy ? 'api+proxy_shopping' : 'api_only';
    var pids = Object.keys(productMap);
    for (var fi = 0; fi < pids.length; fi++) {
      var prod = productMap[pids[fi]];
      if (purchaseMap[prod.product_id]) prod.purchase_count = purchaseMap[prod.product_id];
      result.data.push(prod);
    }

    result.debug.total = result.data.length;
    result.debug.withPurchase = 0;
    for (var ci = 0; ci < result.data.length; ci++) {
      if (result.data[ci].purchase_count > 0) result.debug.withPurchase++;
    }

    if (result.data.length === 0) { result.status = 'EMPTY'; result.error = 'No products found'; }
  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message || String(e);
    try { await page.close(); await ctx.close(); } catch(x) {}
  }
  return result;
}

// ============ SPY ============
async function spy(params) {
  var url = params.url || 'https://brand.naver.com/dcurvin/products/12569074482';
  var proxy = null;
  if (params.proxy_host && params.proxy_port) {
    proxy = { server: 'http://' + params.proxy_host + ':' + params.proxy_port };
    if (params.proxy_user && params.proxy_pass) {
      proxy.username = params.proxy_user;
      proxy.password = params.proxy_pass;
    }
  }
  var br = await getBrowser(proxy);
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
    await page.addInitScript(stealth);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
    return { status: 'OK', url: url, proxy: !!proxy, captured_count: captured.length, captured: captured };
  } catch(e) {
    return { status: 'ERROR', error: e.message, proxy: !!proxy, captured: captured };
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
