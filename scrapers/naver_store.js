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

// ============ SCRAPE v21: Product Detail Page Direct Fetch ============
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
    console.log('[v21] Starting Browser...');
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

    // ===== PHASE 1: 브랜드 스토어 접속 및 기본 데이터 파싱 =====
    var baseUrl = storeType === 'brand' ? 'https://brand.naver.com/' + storeSlug : 'https://smartstore.naver.com/' + storeSlug;
    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v21] P1: Navigating to Brand Store: ' + targetUrl);
    
    await page1.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page1.waitForTimeout(3000); 

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

    if (stateInfo.channelUid && stateInfo.allIds.length > 0) {
      var batchSize = 20;
      for (var bi = 0; bi < stateInfo.allIds.length; bi += batchSize) {
        var batch = stateInfo.allIds.slice(bi, bi + batchSize);
        try {
          var apiResult = await page1.evaluate(function(args) {
            var params = args.ids.map(function(id) { return 'ids[]=' + id; }).join('&');
            return fetch(args.baseUrl + '/n/v2/channels/' + args.uid + '/simple-products?' + params, { credentials: 'include' })
              .then(function(r) { return r.ok ? r.json() : null; })
              .catch(function() { return null; });
          }, { uid: stateInfo.channelUid, ids: batch, baseUrl: baseUrl });

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
                total_purchase_count: 0, // 누적 구매건수를 추가로 담을 공간
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

    // ===== PHASE 2: 상품 개별 페이지 직접 파싱 (WAF 우회 및 정확도 100%) =====
    console.log('[v21] P2: Fetching individual product pages to extract purchase counts...');
    var pids = Object.keys(productMap);
    var fetchBatchSize = 5; // 한 번에 5개씩만 통신하여 봇 탐지 회피
    
    result.debug.fetch = { total: pids.length, success: 0 };

    for (var i = 0; i < pids.length; i += fetchBatchSize) {
      var fetchBatch = pids.slice(i, i + fetchBatchSize);
      
      var countsResult = await page1.evaluate(async function(args) {
        var results = {};
        for (var j = 0; j < args.ids.length; j++) {
          var id = args.ids[j];
          try {
            // 브라우저 내부에서 해당 스토어의 상품 상세페이지 HTML을 직접 호출
            var r = await fetch(args.baseUrl + '/products/' + id);
            if (r.ok) {
              var text = await r.text();
              var recent = 0;
              var cumul = 0;
              
              // 정규식으로 최근 구매건수(recentSaleCount) 추출
              var rm = text.match(/"recentSaleCount"\s*:\s*(\d+)/);
              if (rm) recent = parseInt(rm[1], 10);
              
              // 정규식으로 누적 구매건수(cumulationSaleCount) 추출
              var cm = text.match(/"cumulationSaleCount"\s*:\s*(\d+)/);
              if (cm) cumul = parseInt(cm[1], 10);
              
              results[id] = { recent: recent, cumul: cumul };
            }
          } catch(e) {}
        }
        return results;
      }, { ids: fetchBatch, baseUrl: baseUrl });

      // 결과 병합
      for (var id in countsResult) {
        var c = countsResult[id];
        // purchase_count에는 '최근 구매건수'를 우선 배정하고 없으면 '누적'을 배정
        productMap[id].purchase_count = c.recent > 0 ? c.recent : c.cumul;
        // total_purchase_count에는 '전체 누적 구매건수'를 별도로 저장
        productMap[id].total_purchase_count = c.cumul;
        
        if (c.recent > 0 || c.cumul > 0) {
          result.debug.fetch.success++;
        }
      }
      
      // 서버에 무리를 주지 않기 위해 1초 대기
      if (i + fetchBatchSize < pids.length) {
        await page1.waitForTimeout(1000);
      }
    }

    // ===== PHASE 3: 최종 데이터 포맷팅 =====
    result.method_used = 'product_page_direct_fetch';
    for (var fi = 0; fi < pids.length; fi++) {
      result.data.push(productMap[pids[fi]]);
    }

    result.debug.total = result.data.length;
    result.debug.withPurchase = 0;
    for (var ci = 0; ci < result.data.length; ci++) {
      if (result.data[ci].purchase_count > 0 || result.data[ci].total_purchase_count > 0) result.debug.withPurchase++;
    }

    if (result.data.length === 0) { result.status = 'EMPTY'; result.error = 'No products found'; }

  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message || String(e);
  } finally {
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
