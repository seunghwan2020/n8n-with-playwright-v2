const { chromium } = require('playwright');

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
};

// ============ SCRAPE v19: Stable Browser Lifecycle & Human-like Bypass 418 ============
async function scrape(params) {
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
  var storeName = params.store_name || storeSlug;
  var result = { status: 'OK', data: [], channel_uid: '', error: null, method_used: '', debug: {} };

  var proxy = null;
  if (params.proxy_host && params.proxy_port) {
    proxy = { server: 'http://' + params.proxy_host + ':' + params.proxy_port };
    if (params.proxy_user && params.proxy_pass) {
      proxy.username = params.proxy_user;
      proxy.password = params.proxy_pass;
    }
    result.debug.proxyEnabled = true;
  }

  var br1 = null;
  var ctx1 = null;
  var page1 = null;
  var productMap = {};

  try {
    // ===== PHASE 1+2: 브랜드스토어 (기본 상품 정보 수집) =====
    br1 = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-gpu']
    });
    ctx1 = await br1.newContext(ctxOpts());
    page1 = await ctx1.newPage();
    await page1.addInitScript(stealth);

    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v19] P1: ' + targetUrl);
    
    await page1.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page1.waitForTimeout(3000); // 리액트 렌더링 대기

    var prevHeight = 0;
    for (var si = 0; si < 5; si++) {
      await page1.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
      await page1.waitForTimeout(1000);
      var curHeight = await page1.evaluate(function() { return document.body.scrollHeight; });
      if (curHeight === prevHeight) break;
      prevHeight = curHeight;
    }

    var stateInfo = await page1.evaluate(function() {
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

    if (stateInfo.channelUid && stateInfo.allIds.length > 0) {
      var batchSize = 20;
      for (var bi = 0; bi < stateInfo.allIds.length; bi += batchSize) {
        var batch = stateInfo.allIds.slice(bi, bi + batchSize);
        try {
          var apiResult = await page1.evaluate(function(args) {
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
        if (bi + batchSize < stateInfo.allIds.length) await page1.waitForTimeout(200);
      }
    }
    result.debug.apiProducts = Object.keys(productMap).length;

  } catch (e) {
    result.status = 'ERROR';
    result.error = "Phase 1 Error: " + (e.message || String(e));
    return result; 
  } finally {
    if (page1) await page1.close().catch(()=>{});
    if (ctx1) await ctx1.close().catch(()=>{});
    if (br1) await br1.close().catch(()=>{});
  }


  // ===== PHASE 3: 인간 흉내내기 (검색 우회 우주방어 v2) =====
  var purchaseMap = {};
  var searchDebug = { totalItems: 0, matched: 0, errors: [], method: 'browser_page_human_flow' };
  
  var proxyBrowser = null;
  var searchCtx = null;
  var searchPage = null;

  if (proxy) {
    try {
      console.log('[v19] P3: using human-like flow to bypass 418');

      proxyBrowser = await chromium.launch({
        headless: true, 
        proxy: proxy,
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox', 
          '--disable-dev-shm-usage', 
          '--disable-blink-features=AutomationControlled', 
          '--disable-gpu',
          '--window-size=1920,1080' 
        ]
      });

      searchCtx = await proxyBrowser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36', 
        viewport: { width: 1920, height: 1080 },
        locale: 'ko-KR',
        timezoneId: 'Asia/Seoul'
      });
      
      searchPage = await searchCtx.newPage();
      
      await searchPage.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] }); 
      });

      console.log('[v19] P3: Navigating to Naver Shopping Main...');
      await searchPage.goto('https://shopping.naver.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await searchPage.waitForTimeout(2000 + Math.random() * 2000); 

      console.log('[v19] P3: Typing search query...');
      var searchInputSelector = 'input[title="검색어 입력"], input[type="text"]'; 
      var inputElement = await searchPage.$(searchInputSelector);
      
      if(inputElement) {
         await inputElement.type(storeName, { delay: 100 }); 
         await searchPage.keyboard.press('Enter');
         console.log('[v19] P3: Pressed Enter, waiting for search results...');
      } else {
         var searchUrl = 'https://search.shopping.naver.com/search/all?query=' + encodeURIComponent(storeName);
         await searchPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      }

      await searchPage.waitForTimeout(5000); 
      
      await searchPage.mouse.wheel(0, 500);
      await searchPage.waitForTimeout(1000);

      searchDebug.status = 200; 

      var nextDataStr = await searchPage.evaluate(function() {
        var el = document.querySelector('#__NEXT_DATA__');
        return el ? el.innerText : null;
      });

      if (nextDataStr) {
        var nextData = JSON.parse(nextDataStr);
        var items = [];
        
        try {
          items = nextData.props.pageProps.initialState.products.list || [];
        } catch(e) {
          searchDebug.errors.push('Could not parse products from Next.js state: ' + e.message);
        }

        searchDebug.totalItems = items.length;

        for (var ii = 0; ii < items.length; ii++) {
          var itemObj = items[ii].item || items[ii];
          if (!itemObj) continue;
          
          var pc = itemObj.purchaseCnt || itemObj.purchaseCount || 0;
          var cpn = String(itemObj.channelProductNo || '');
          var mpid = String(itemObj.mallProductId || '');
          var pno = String(itemObj.productNo || itemObj.id || '');
          
          if (pc > 0) {
            if (cpn) purchaseMap[cpn] = pc;
            if (mpid) purchaseMap[mpid] = pc;
            if (pno) purchaseMap[pno] = pc;
            searchDebug.matched++;
          }
        }
      } else {
         searchDebug.error = "No __NEXT_DATA__ found. Bot might still be detected or structure changed.";
         searchDebug.pageTitle = await searchPage.title(); 
      }

      console.log('[v19] P3: items=' + searchDebug.totalItems + ', matched=' + searchDebug.matched);

    } catch(searchErr) {
      searchDebug.errors.push(searchErr.message || String(searchErr));
      console.log('[v19] P3 error: ' + searchErr.message);
    } finally {
      if (searchPage) await searchPage.close().catch(()=>{});
      if (searchCtx) await searchCtx.close().catch(()=>{});
      if (proxyBrowser) await proxyBrowser.close().catch(()=>{});
    }
  } else {
    searchDebug.errors.push('no proxy');
  }

  result.debug.search = searchDebug;

  // ===== PHASE 4: 병합 =====
  result.method_used = proxy ? 'browser_page_human_flow+http_proxy' : 'api_only';
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
  return result;
}

// ============ SPY ============
async function spy(params) {
  var url = params.url || 'https://www.naver.com';
  var proxy = null;
  if (params.proxy_host && params.proxy_port) {
    proxy = { server: 'http://' + params.proxy_host + ':' + params.proxy_port };
    if (params.proxy_user && params.proxy_pass) {
      proxy.username = params.proxy_user;
      proxy.password = params.proxy_pass;
    }
  }
  
  var br = null;
  var ctx = null;
  var page = null;
  var captured = [];
  
  try {
    br = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--disable-gpu']
    });
    ctx = await br.newContext(ctxOpts());
    page = await ctx.newPage();
    await page.addInitScript(stealth);
    
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

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    return { status: 'OK', url: url, proxy: !!proxy, captured_count: captured.length, captured: captured };
  } catch(e) {
    return { status: 'ERROR', error: e.message, proxy: !!proxy, captured: captured };
  } finally {
    if (page) await page.close().catch(()=>{});
    if (ctx) await ctx.close().catch(()=>{});
    if (br) await br.close().catch(()=>{});
  }
}

async function execute(action, req, res) {
  console.log('[naver_store] action=' + action);
  if (action === 'scrape') return res.json(await scrape(req.body));
  if (action === 'spy') return res.json(await spy(req.body));
  return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
}

module.exports = { execute };
