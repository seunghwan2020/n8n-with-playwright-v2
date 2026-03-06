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

// ============ SCRAPE v28: Lightning Fast HTTP Fetch (Bypass 503 Timeout) ============
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
    console.log('[v28] Starting Browser for Session Auth...');
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

    // ===== PHASE 1: 스토어 메인 접속 및 방어벽(WAF) 통과, 상품 리스트 확보 =====
    var domainRoot = storeType === 'brand' ? 'https://brand.naver.com' : 'https://smartstore.naver.com';
    var baseUrl = domainRoot + '/' + storeSlug;
    var apiRoot = storeType === 'brand' ? 'https://brand.naver.com/n/v2/channels/' : 'https://smartstore.naver.com/i/v1/channels/';

    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v28] P1: Navigating to Store: ' + targetUrl);
    
    await page1.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page1.waitForTimeout(1500); 

    var prevHeight = 0;
    for (var si = 0; si < 3; si++) {
      await page1.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
      await page1.waitForTimeout(500);
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
            return fetch(args.apiRoot + args.uid + '/simple-products?' + params, { credentials: 'include' })
              .then(function(r) { return r.ok ? r.json() : null; })
              .catch(function() { return null; });
          }, { uid: stateInfo.channelUid, ids: batch, apiRoot: apiRoot });

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
                total_purchase_count: 0, 
                product_image_url: (p.representativeImageUrl || '').split('?')[0],
                category_name: p.category ? (p.category.wholeCategoryName || '') : '',
                is_sold_out: (p.productStatusType === 'OUTOFSTOCK') || (p.soldout === true) || false,
                product_url: baseUrl + '/products/' + pid
              };
            }
          }
        } catch(e) {}
      }
    }

    // ===== PHASE 2: 🚀 503 에러 회피용 초고속 HTTP 직접 통신 (무거운 탭 렌더링 0%) =====
    console.log('[v28] P2: Deep scanning via fast HTTP Context Requests...');
    var pids = Object.keys(productMap);
    var fetchBatchSize = 6; 
    result.debug.fetch = { total: pids.length, success: 0, errors: [] };

    for (var i = 0; i < pids.length; i += fetchBatchSize) {
      var fetchBatch = pids.slice(i, i + fetchBatchSize);
      
      var promises = fetchBatch.map(async function(pid) {
        try {
          var prodUrl = productMap[pid].product_url;
          // Playwright의 자체 request 객체를 사용하여 브라우저 탭을 열지 않고 NNB 쿠키를 동기화하여 HTTP 요청 발송
          var resp = await ctx1.request.get(prodUrl, { timeout: 15000 });
          
          if (resp.ok()) {
            var html = await resp.text();
            var recent = 0;
            var cumul = 0;

            // 1. Next.js 데이터 객체 파싱 (최신 네이버 스토어 대응)
            var nextMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
            if (nextMatch) {
              try {
                var nextData = JSON.parse(nextMatch[1]);
                // 재귀 탐색 함수
                function findSales(obj, depth = 0) {
                  if (depth > 20 || !obj || typeof obj !== 'object') return null;
                  if (obj.recentSaleCount !== undefined || obj.cumulationSaleCount !== undefined || obj.totalSaleCount !== undefined || obj.purchaseCnt !== undefined) {
                    return {
                      recent: parseInt(obj.recentSaleCount || obj.purchaseCnt || 0, 10),
                      cumul: parseInt(obj.cumulationSaleCount || obj.totalSaleCount || 0, 10)
                    };
                  }
                  if (Array.isArray(obj)) {
                    for (var item of obj) {
                      var res = findSales(item, depth + 1);
                      if (res) return res;
                    }
                  } else {
                    for (var key in obj) {
                      var res = findSales(obj[key], depth + 1);
                      if (res) return res;
                    }
                  }
                  return null;
                }
                var sales = findSales(nextData);
                if (sales) {
                  recent = sales.recent;
                  cumul = sales.cumul;
                }
              } catch (e) {}
            }

            // 2. Preloaded State 파싱 (구형 네이버 스토어 대응)
            if (recent === 0 && cumul === 0) {
              var stateMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\})(?=<\/script>|;window)/);
              if (stateMatch) {
                // Preloaded state는 정규식으로 직접 긁는 것이 빠르고 안전함
                var rMatch = stateMatch[1].match(/["']?recentSaleCount["']?\s*:\s*(\d+)/i) || stateMatch[1].match(/["']?purchaseCnt["']?\s*:\s*(\d+)/i);
                if (rMatch) recent = parseInt(rMatch[1], 10);
                var cMatch = stateMatch[1].match(/["']?(?:cumulationSaleCount|totalSaleCount)["']?\s*:\s*(\d+)/i);
                if (cMatch) cumul = parseInt(cMatch[1], 10);
              }
            }

            // 3. 최후의 보루: 전체 HTML 정규식 딥스캔 (따옴표 유무 완벽 대응)
            if (recent === 0 && cumul === 0) {
              var fallbackRMatch = html.match(/["']?recentSaleCount["']?\s*:\s*(\d+)/i) || html.match(/["']?purchaseCnt["']?\s*:\s*(\d+)/i) || html.match(/["']?purchaseCount["']?\s*:\s*(\d+)/i);
              if (fallbackRMatch) recent = parseInt(fallbackRMatch[1], 10);
              
              var fallbackCMatch = html.match(/["']?(?:cumulationSaleCount|totalSaleCount)["']?\s*:\s*(\d+)/i);
              if (fallbackCMatch) cumul = parseInt(fallbackCMatch[1], 10);
            }

            // 최종 데이터 매핑
            productMap[pid].purchase_count = recent > 0 ? recent : cumul;
            productMap[pid].total_purchase_count = cumul;

            if (recent > 0 || cumul > 0) {
              result.debug.fetch.success++;
            } else {
              if (html.includes('DataDome') || html.includes('접근방어')) {
                result.debug.fetch.errors.push(`DataDome Blocked on ${pid}`);
              }
            }
          } else {
            result.debug.fetch.errors.push(`HTTP ${resp.status()} for ${pid}`);
          }
        } catch (e) {
          result.debug.fetch.errors.push(`Error ${pid}: ${e.message}`);
        }
      });

      await Promise.all(promises);
      await new Promise(r => setTimeout(r, 300)); // 서버 부하를 막기 위한 0.3초 대기
    }

    // ===== PHASE 3: 최종 데이터 포맷팅 =====
    result.method_used = 'fast_http_context_extraction_v28';
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
