const { chromium } = require('playwright');

function ctxOpts() {
  return {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' }
  };
}

var stealth = function() {
  Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
  Object.defineProperty(navigator, 'languages', { get: function() { return ['ko-KR', 'ko', 'en-US', 'en']; } });
  Object.defineProperty(navigator, 'plugins', { get: function() { return [1, 2, 3]; } });
};

// ============ SCRAPE v20: Chrome Extension Interception Logic ============
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
  var capturedPurchaseMap = {}; // 크롬 확장 프로그램처럼 가로챈 구매건수를 저장할 맵
  
  result.debug.search = { matched_xhr: 0, matched_dom: 0, status: 'started' };

  try {
    // 1. 단일 브라우저 인스턴스 실행 (프록시 통합 적용)
    console.log('[v20] Starting Browser with Extension-like Interception...');
    br1 = await chromium.launch({
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
    ctx1 = await br1.newContext(ctxOpts());
    page1 = await ctx1.newPage();
    await page1.addInitScript(stealth);

    // 🌟 핵심 로직: 네트워크 통신(XHR/JSON) 실시간 감청 함수 🌟
    // 네이버 페이지가 렌더링되는 동안 오가는 모든 JSON 데이터에서 구매건수(purchaseCnt)를 추출합니다.
    var extractor = function extract(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) {
        for (var i = 0; i < obj.length; i++) extract(obj[i]);
      } else {
        // 네이버가 사용하는 다양한 구매건수 필드명 탐색
        var pc = obj.purchaseCnt || obj.purchaseCount || obj.cumulationSaleCount || obj.recentSaleCount || obj.saleCount || obj.saleAmount || 0;
        if (typeof pc === 'object' && pc !== null) {
            pc = pc.cumulationSaleCount || pc.recentSaleCount || pc.saleCount || 0;
        }
        pc = parseInt(pc, 10) || 0;
        
        if (pc > 0) {
          var id1 = obj.channelProductNo;
          var id2 = obj.mallProductId;
          var id3 = obj.id || obj.productNo || obj.nvMid;
          if (id1) { capturedPurchaseMap[String(id1)] = pc; result.debug.search.matched_xhr++; }
          if (id2) { capturedPurchaseMap[String(id2)] = pc; result.debug.search.matched_xhr++; }
          if (id3) { capturedPurchaseMap[String(id3)] = pc; result.debug.search.matched_xhr++; }
        }
        // 하위 노드로 재귀 탐색
        for (var key in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) extract(obj[key]);
        }
      }
    };

    // 브라우저 백그라운드 리스너 부착
    page1.on('response', async function(response) {
      if (response.status() === 200) {
        var url = response.url();
        if (url.indexOf('naver.com') > -1 && (url.indexOf('api') > -1 || url.indexOf('graphql') > -1 || url.indexOf('products') > -1 || url.indexOf('search') > -1)) {
          var ct = response.headers()['content-type'] || '';
          if (ct.indexOf('application/json') > -1) {
            try {
              var body = await response.json();
              extractor(body); // 감청한 데이터에서 구매건수 파싱
            } catch(e) {}
          }
        }
      }
    });

    // 2. [PHASE 1] 스토어 페이지 방문 (쿠키 신뢰도 구축 및 기본 상품 목록 추출)
    var baseUrl = storeType === 'brand' ? 'https://brand.naver.com/' + storeSlug : 'https://smartstore.naver.com/' + storeSlug;
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v20] P1: Navigating to Brand Store: ' + targetUrl);
    
    await page1.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page1.waitForTimeout(3000); 

    // 무한스크롤 시뮬레이션
    var prevHeight = 0;
    for (var si = 0; si < 3; si++) {
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
        out.allIds = Object.keys(idSet);
      } catch(e) {}
      return out;
    });

    result.channel_uid = stateInfo.channelUid;

    // 스토어 자체 API를 호출하여 상품 기본 데이터 추출
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

    // 3. [PHASE 2] 검색 결과 페이지 방문 (스토어 방문으로 쌓인 쿠키를 그대로 이용)
    // 이 페이지로 이동하면 아까 걸어둔 네트워크 리스너가 검색결과 API JSON을 전부 스니핑합니다.
    var searchUrl = 'https://search.shopping.naver.com/search/all?query=' + encodeURIComponent(storeName);
    console.log('[v20] P2: Navigating to Search Page: ' + searchUrl);
    
    var searchResponse = await page1.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    result.debug.search.status = searchResponse ? searchResponse.status() : 'unknown';
    
    await page1.waitForTimeout(4000); // 검색 API 통신 대기
    await page1.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
    await page1.waitForTimeout(2000);

    // 🌟 최후의 보루: 화면에 렌더링된 "구매 1,234" 텍스트 직접 추출 (DOM Scraping)
    var domPurchases = await page1.evaluate(function() {
      var map = {};
      var links = document.querySelectorAll('a');
      for (var i = 0; i < links.length; i++) {
        var link = links[i];
        var container = link.closest('li') || link.closest('div[class^="product_item"]');
        if (container) {
          var text = container.innerText || '';
          var match = text.match(/구매(?:건수)?\s*([0-9,]+)/);
          if (match) {
            var pc = parseInt(match[1].replace(/,/g, ''), 10);
            var idMatch = link.href.match(/(?:products|catalog)\/([0-9]+)/);
            if (idMatch && pc > 0) {
              map[idMatch[1]] = pc;
            }
          }
        }
      }
      return map;
    });

    // 스니핑한 데이터와 DOM 스크래핑 데이터 병합
    for(var key in domPurchases) {
      if(!capturedPurchaseMap[key]) {
        capturedPurchaseMap[key] = domPurchases[key];
        result.debug.search.matched_dom++;
      }
    }

    // 4. 최종 데이터 병합
    result.method_used = 'extension_logic(xhr_sniffing+dom_scraping)';
    var pids = Object.keys(productMap);
    for (var fi = 0; fi < pids.length; fi++) {
      var prod = productMap[pids[fi]];
      if (capturedPurchaseMap[prod.product_id]) {
        prod.purchase_count = capturedPurchaseMap[prod.product_id];
      }
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
  } finally {
    // 모든 작업이 끝난 후 브라우저 안전 종료
    if (page1) await page1.close().catch(()=>{});
    if (ctx1) await ctx1.close().catch(()=>{});
    if (br1) await br1.close().catch(()=>{});
  }

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
