const { chromium } = require('playwright');

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
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

// ============ SCRAPE v27.0: purchased / repurchased 분리 조회 ============
async function scrape(params) {
  var storeSlug = params.store_slug || 'dcurvin';
  var storeType = params.store_type || 'brand';
  var result = {
    status: 'OK',
    data: [],
    channel_uid: '',
    error: null,
    method_used: 'v27.0_split_purchase_repurchased',
    debug: { build: 'V27.0_SPLIT_PURCHASE_REPURCHASED', storeSlug: storeSlug, storeType: storeType }
  };

  var br = null;
  var ctx = null;
  var page = null;
  var apiPage = null;

  try {
    br = await getBrowser();
    ctx = await br.newContext(ctxOpts());
    page = await ctx.newPage();
    await page.addInitScript(stealth);

    var baseUrl, apiBase;
    if (storeType === 'smartstore') {
      baseUrl = 'https://smartstore.naver.com/' + storeSlug;
      apiBase = 'https://brand.naver.com';
    } else {
      baseUrl = 'https://brand.naver.com/' + storeSlug;
      apiBase = 'https://brand.naver.com';
    }

    // ===== PHASE 1: 상품 ID 수집 =====
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v27.0] P1: ' + targetUrl);

    var waitStrategy = (storeType === 'smartstore') ? 'domcontentloaded' : 'networkidle';
    await page.goto(targetUrl, { waitUntil: waitStrategy, timeout: 45000 });
    await page.waitForTimeout(3000);

    if (storeType === 'smartstore') {
      try {
        await page.waitForFunction(function() {
          return window.__PRELOADED_STATE__ || window.__NEXT_DATA__;
        }, { timeout: 10000 });
      } catch (e) {
        console.log('[v27.0] smartstore state wait timeout, continuing...');
      }
      await page.waitForTimeout(2000);
    }

    for (var si = 0; si < 5; si++) {
      try {
        await page.evaluate(function() {
          if (document.body) window.scrollTo(0, document.body.scrollHeight);
        });
      } catch (e) {
        break;
      }
      await page.waitForTimeout(1500);
    }

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
        } catch (e) {}
        return ids;
      });
      await p2.close();
    } catch (e) {}

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
              for (var pi = 0; pi < w.productNos.length; pi++) {
                idSet[String(w.productNos[pi])] = true;
              }
            }
          }
        }

        var links = document.querySelectorAll('a[href*="/products/"]');
        for (var li = 0; li < links.length; li++) {
          var m = (links[li].getAttribute('href') || '').match(/products\/(\d+)/);
          if (m) idSet[m[1]] = true;
        }

        out.allIds = Object.keys(idSet);
      } catch (e) {
        out.method = 'error: ' + e.message;
      }
      return out;
    });

    if (stateInfo.allIds.length === 0 && storeType === 'smartstore') {
      console.log('[v27.0] smartstore fallback: DOM scraping');
      var domInfo = await page.evaluate(function(baseUrl) {
        var out = { channelUid: '', channelName: '', allIds: [], method: 'dom_fallback' };
        try {
          var scripts = document.querySelectorAll('script');
          for (var si = 0; si < scripts.length; si++) {
            var txt = scripts[si].textContent || '';
            var uidMatch = txt.match(/"channelUid"\s*:\s*"([^"]+)"/);
            if (uidMatch && !out.channelUid) out.channelUid = uidMatch[1];
            var nameMatch = txt.match(/"channelName"\s*:\s*"([^"]+)"/);
            if (nameMatch && !out.channelName) out.channelName = nameMatch[1];
            if (out.channelUid && out.channelName) break;
          }

          if (!out.channelName) {
            var title = document.title || '';
            var colonIdx = title.indexOf(':');
            if (colonIdx > 0) out.channelName = title.substring(0, colonIdx).trim();
          }

          var idSet = {};
          var links = document.querySelectorAll('a[href*="/products/"]');
          for (var li = 0; li < links.length; li++) {
            var m = (links[li].getAttribute('href') || '').match(/products\/(\d+)/);
            if (m) idSet[m[1]] = true;
          }

          var cards = document.querySelectorAll('[data-product-no], [data-nclick*="product"]');
          for (var ci = 0; ci < cards.length; ci++) {
            var pno = cards[ci].getAttribute('data-product-no');
            if (pno) idSet[pno] = true;
          }

          out.allIds = Object.keys(idSet);
        } catch (e) {
          out.method = 'dom_error: ' + e.message;
        }
        return out;
      }, baseUrl);

      if (domInfo.allIds.length > 0) {
        stateInfo = domInfo;
        if (domInfo.channelName) result.brand_name = domInfo.channelName;
        console.log('[v27.0] DOM fallback found ' + domInfo.allIds.length + ' products');
      }
    }

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

    apiPage = page;
    if (storeType === 'smartstore' && stateInfo.channelUid) {
      try {
        apiPage = await ctx.newPage();
        await apiPage.addInitScript(stealth);
        await apiPage.goto('https://brand.naver.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await apiPage.waitForTimeout(1000);
        console.log('[v27.0] smartstore: opened brand.naver.com API page');
      } catch (e) {
        console.log('[v27.0] smartstore: brand page open failed, using original page');
        apiPage = page;
      }
    }

    // ===== PHASE 2: simple-products API =====
    var productMap = {};
    var productNoMap = {};

    if (storeType === 'smartstore') {
      console.log('[v27.0] smartstore: extracting products from __PRELOADED_STATE__');
      var stateProducts = await page.evaluate(function(baseUrl) {
        var out = { products: [], productNoMap: {} };
        try {
          var state = window.__PRELOADED_STATE__;
          if (!state) return out;

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
        } catch (e) {}
        return out;
      }, baseUrl);

      console.log('[v27.0] smartstore state products: ' + stateProducts.products.length);

      if (stateProducts.products.length > 0) {
        for (var spi = 0; spi < stateProducts.products.length; spi++) {
          var sp = stateProducts.products[spi];
          productMap[sp.product_id] = {
            product_id: sp.product_id,
            product_name: sp.product_name,
            sale_price: sp.sale_price,
            discount_price: sp.discount_price,
            review_count: sp.review_count,
            purchase_count_today: 0,
            purchase_text_today: '',
            purchase_prefix_today: '',
            purchase_count_weekly: 0,
            purchase_text_weekly: '',
            purchase_prefix_weekly: '',
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

    if (Object.keys(productMap).length === 0 && stateInfo.channelUid && stateInfo.allIds.length > 0) {
      var apiPaths = ['/n/v2/channels/'];
      var batchSize = 20;

      for (var pathIdx = 0; pathIdx < apiPaths.length; pathIdx++) {
        var currentPath = apiPaths[pathIdx];
        var pathWorked = false;

        for (var bi = 0; bi < stateInfo.allIds.length; bi += batchSize) {
          var batch = stateInfo.allIds.slice(bi, bi + batchSize);
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
              console.log('[v27.0] API path ' + currentPath + ' failed: ' + (apiResult._status || apiResult._error));
              break;
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
                  purchase_count_today: 0,
                  purchase_text_today: '',
                  purchase_prefix_today: '',
                  purchase_count_weekly: 0,
                  purchase_text_weekly: '',
                  purchase_prefix_weekly: '',
                  product_image_url: (p.representativeImageUrl || '').split('?')[0],
                  category_name: p.category ? (p.category.wholeCategoryName || '') : '',
                  is_sold_out: (p.productStatusType === 'OUTOFSTOCK') || (p.soldout === true) || false,
                  product_url: baseUrl + '/products/' + pid
                };
              }
            }
          } catch (e) {}

          if (bi + batchSize < stateInfo.allIds.length) {
            await apiPage.waitForTimeout(200);
          }
        }

        if (pathWorked) {
          console.log('[v27.0] API path worked: ' + currentPath + ', products: ' + Object.keys(productMap).length);
          result.debug.apiPathUsed = currentPath;
          break;
        }
      }
    }

    result.debug.apiProducts = Object.keys(productMap).length;
    result.debug.productNoMapped = Object.keys(productNoMap).length;

    // ===== PHASE 3: marketing-message API =====
    var purchaseDebug = {
      total: 0,
      todayCount: 0,
      weeklyCount: 0,
      ignoredCumul: 0,
      errors: [],
      samples: []
    };

    var allPids = Object.keys(productMap);
    console.log('[v27.0] P3: marketing-message for ' + allPids.length + ' products');

    var msgApiPath = '/n/v1/marketing-message/';

    function parseMsgData(data) {
      if (!data || !data.mainPhrase) return null;

      var phrase = data.mainPhrase || '';
      var prefix = (data.prefix || '').trim();
      var count = 0;

      var nm = phrase.match(/(\d[\d,]*)\s*명/);
      if (nm) count = parseInt(nm[1].replace(/,/g, ''), 10);

      var isToday = prefix.indexOf('오늘') > -1;
      var isWeekly = prefix.indexOf('최근') > -1;

      return {
        count: count,
        phrase: phrase,
        prefix: prefix,
        isToday: isToday,
        isWeekly: isWeekly
      };
    }

    async function fetchMarketingMessage(apiPage, args) {
      return await apiPage.evaluate(async function(innerArgs) {
        function buildUrl() {
          var qs = [
            'currentPurchaseType=Paid',
            'usePurchased=' + (innerArgs.usePurchased ? 'true' : 'false'),
            'usePurchasedIn2Y=true',
            'useRepurchased=' + (innerArgs.useRepurchased ? 'true' : 'false')
          ];

          if (innerArgs.usePurchased) qs.push('basisPurchased=' + innerArgs.basisPurchased);
          if (innerArgs.useRepurchased) qs.push('basisRepurchased=' + innerArgs.basisRepurchased);

          return innerArgs.apiBase + innerArgs.path + innerArgs.id + '?' + qs.join('&');
        }

        async function doFetch(retry) {
          retry = retry || 0;
          try {
            var url = buildUrl();
            var r = await fetch(url, { credentials: 'include' });
            if (!r.ok) {
              throw new Error('HTTP ' + r.status);
            }
            var data = await r.json();
            return { ok: true, url: url, data: data };
          } catch (e) {
            if (retry < 2) {
              await new Promise(function(res) { setTimeout(res, 300); });
              return doFetch(retry + 1);
            }
            return { ok: false, url: buildUrl(), error: String(e) };
          }
        }

        return doFetch(0);
      }, args);
    }

    for (var mi = 0; mi < allPids.length; mi++) {
      var prodId = allPids[mi];
      var msgId = productNoMap[prodId] || prodId;
      purchaseDebug.total++;

      try {
        // 1) 오늘 구매 조회
        var todayResp = await fetchMarketingMessage(apiPage, {
          apiBase: apiBase,
          path: msgApiPath,
          id: msgId,
          usePurchased: true,
          basisPurchased: 1,
          useRepurchased: false,
          basisRepurchased: 0
        });

        var todayParsed = todayResp.ok ? parseMsgData(todayResp.data) : null;
        var todayCount = 0;

        if (todayParsed && todayParsed.isToday && todayParsed.count > 0) {
          productMap[prodId].purchase_count_today = todayParsed.count;
          productMap[prodId].purchase_text_today = todayParsed.phrase;
          productMap[prodId].purchase_prefix_today = todayParsed.prefix;
          purchaseDebug.todayCount++;
          todayCount = todayParsed.count;
        } else if (todayParsed && todayParsed.isWeekly) {
          // 오늘 조회에서 주간값이 와버린 경우 today=0으로 간주
          todayCount = 0;
        }

        // 2) 최근 1주 구매 조회
        var weeklyBasis = Math.max(todayCount + 1, 1);

        var weeklyResp = await fetchMarketingMessage(apiPage, {
          apiBase: apiBase,
          path: msgApiPath,
          id: msgId,
          usePurchased: false,
          basisPurchased: 1,
          useRepurchased: true,
          basisRepurchased: weeklyBasis
        });

        var weeklyParsed = weeklyResp.ok ? parseMsgData(weeklyResp.data) : null;

        // weekly 조회인데 오늘이 오면 무시
        if (weeklyParsed && weeklyParsed.isToday) {
          weeklyParsed = null;
        }

        if (weeklyParsed && weeklyParsed.isWeekly && weeklyParsed.count > 0) {
          productMap[prodId].purchase_count_weekly = weeklyParsed.count;
          productMap[prodId].purchase_text_weekly = weeklyParsed.phrase;
          productMap[prodId].purchase_prefix_weekly = weeklyParsed.prefix;
          purchaseDebug.weeklyCount++;
        }

        if (
          (!todayParsed || !todayParsed.isToday || todayParsed.count <= 0) &&
          (!weeklyParsed || !weeklyParsed.isWeekly || weeklyParsed.count <= 0)
        ) {
          purchaseDebug.ignoredCumul++;
        }

        if (purchaseDebug.samples.length < 12) {
          purchaseDebug.samples.push({
            pid: prodId,
            msgId: msgId,
            todayRequest: {
              url: todayResp.url || '',
              ok: !!todayResp.ok
            },
            todayResponse: todayParsed ? {
              prefix: todayParsed.prefix,
              phrase: todayParsed.phrase,
              count: todayParsed.count,
              isToday: todayParsed.isToday,
              isWeekly: todayParsed.isWeekly
            } : null,
            weeklyRequest: {
              basisRepurchased: weeklyBasis,
              url: weeklyResp.url || '',
              ok: !!weeklyResp.ok
            },
            weeklyResponse: weeklyParsed ? {
              prefix: weeklyParsed.prefix,
              phrase: weeklyParsed.phrase,
              count: weeklyParsed.count,
              isToday: weeklyParsed.isToday,
              isWeekly: weeklyParsed.isWeekly
            } : null,
            finalToday: productMap[prodId].purchase_count_today,
            finalWeekly: productMap[prodId].purchase_count_weekly
          });
        }

        if (
          (!todayResp.ok || !weeklyResp.ok) &&
          purchaseDebug.errors.length < 10
        ) {
          purchaseDebug.errors.push({
            pid: prodId,
            msgId: msgId,
            todayError: todayResp.ok ? null : todayResp.error,
            weeklyError: weeklyResp.ok ? null : weeklyResp.error
          });
        }

      } catch (productErr) {
        if (purchaseDebug.errors.length < 10) {
          purchaseDebug.errors.push({
            pid: prodId,
            msgId: msgId,
            error: String(productErr).substring(0, 300)
          });
        }
      }

      if (mi > 0 && mi % 10 === 0) {
        await apiPage.waitForTimeout(200);
      }
    }

    result.debug.purchase = purchaseDebug;
    console.log(
      '[v27.0] P3: today=' + purchaseDebug.todayCount +
      ', weekly=' + purchaseDebug.weeklyCount +
      ', ignored=' + purchaseDebug.ignoredCumul
    );

    // ===== PHASE 4: 결과 =====
    var pids = Object.keys(productMap);
    for (var fi = 0; fi < pids.length; fi++) {
      var prod = productMap[pids[fi]];
      result.data.push({
        product_id: prod.product_id,
        product_name: prod.product_name,
        sale_price: prod.sale_price,
        discount_price: prod.discount_price,
        review_count: prod.review_count,
        purchase_count_today: prod.purchase_count_today,
        purchase_text_today: prod.purchase_text_today,
        purchase_prefix_today: prod.purchase_prefix_today,
        purchase_count_weekly: prod.purchase_count_weekly,
        purchase_text_weekly: prod.purchase_text_weekly,
        purchase_prefix_weekly: prod.purchase_prefix_weekly,
        product_image_url: prod.product_image_url,
        category_name: prod.category_name,
        is_sold_out: prod.is_sold_out,
        product_url: prod.product_url
      });
    }

    result.debug.total = result.data.length;
    if (result.data.length === 0) {
      result.status = 'EMPTY';
      result.error = 'No products found';
    }
  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message || String(e);
  } finally {
    try { if (apiPage && apiPage !== page) await apiPage.close(); } catch (x) {}
    try { if (page) await page.close(); } catch (x) {}
    try { if (ctx) await ctx.close(); } catch (x) {}
  }

  return result;
}

// ============ SPY ============
async function spy(params) {
  var url = params.url || 'https://brand.naver.com/dcurvin/products/12569074482';
  var br = null;
  var ctx = null;
  var page = null;
  var captured = [];

  try {
    br = await getBrowser();
    ctx = await br.newContext(ctxOpts());
    page = await ctx.newPage();

    page.on('response', async function(response) {
      try {
        var reqUrl = response.url();
        var ct = response.headers()['content-type'] || '';
        if (ct.indexOf('json') > -1 && response.status() === 200) {
          var body = await response.text();
          captured.push({
            url: reqUrl.length > 200 ? reqUrl.slice(0, 200) + '...' : reqUrl,
            status: response.status(),
            size: body.length,
            snippet: body.slice(0, 500)
          });
        }
      } catch (e) {}
    });

    await page.addInitScript(stealth);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    return { status: 'OK', url: url, captured_count: captured.length, captured: captured };
  } catch (e) {
    return { status: 'ERROR', error: e.message, captured: captured };
  } finally {
    try { if (page) await page.close(); } catch (x) {}
    try { if (ctx) await ctx.close(); } catch (x) {}
  }
}

async function execute(action, req, res) {
  console.log('[naver_store v27.0] action=' + action);
  try {
    if (action === 'scrape') return res.json(await scrape(req.body));
    if (action === 'spy') return res.json(await spy(req.body));
    return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
  } catch (e) {
    if (!res.headersSent) {
      return res.status(500).json({ status: 'ERROR', error: e.message || String(e) });
    }
  }
}

module.exports = { execute };
