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

// ============ SCRAPE v24: Extension Logic (Sequential Single Tab + Deep Extract) ============
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
    console.log('[v24] Starting Browser...');
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

    // ===== PHASE 1: 스토어 접속하여 안전한 세션(쿠키) 획득 및 기본 상품 리스트 파싱 =====
    var domainRoot = storeType === 'brand' ? 'https://brand.naver.com' : 'https://smartstore.naver.com';
    var baseUrl = domainRoot + '/' + storeSlug;
    var apiRoot = storeType === 'brand' ? 'https://brand.naver.com/n/v2/channels/' : 'https://smartstore.naver.com/i/v1/channels/';

    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v24] P1: Navigating to Store: ' + targetUrl);
    
    await page1.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page1.waitForTimeout(3000); 

    // 스크롤하여 봇 아님을 증명
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

    // 상품 목록의 가격/썸네일 등 기본 정보 가져오기
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
        if (bi + batchSize < stateInfo.allIds.length) await page1.waitForTimeout(200);
      }
    }

    // ===== PHASE 2: 확장 프로그램 방식 (동일 탭으로 상품페이지 순차 방문) =====
    console.log('[v24] P2: Sequentially visiting product pages to prevent WAF block...');
    var pids = Object.keys(productMap);
    result.debug.fetch = { total: pids.length, success: 0, blocked: 0 };

    for (var i = 0; i < pids.length; i++) {
      var pid = pids[i];
      var prodUrl = productMap[pid].product_url;
      
      try {
        // 이미 1단계에서 네이버 방어벽을 뚫은 page1을 그대로 활용하여 상품 페이지로 이동
        await page1.goto(prodUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        
        // 페이지가 정상적으로 로드될 때까지 약간 대기 (사람 흉내)
        await page1.waitForTimeout(1000 + Math.random() * 1000);

        // 방어벽(CAPTCHA 등)에 막혔는지 타이틀로 검사
        var pageTitle = await page1.title();
        if (pageTitle.includes('접근방어') || pageTitle.includes('DataDome') || pageTitle.includes('로봇')) {
            console.log('[v24] WAF Blocked on product: ' + pid);
            result.debug.fetch.blocked++;
            await page1.waitForTimeout(5000); // 막히면 잠시 멈춤
            continue;
        }

        // 1. 네이버 스토어 전역 객체(window.__PRELOADED_STATE__)에서 확장프로그램처럼 직접 데이터 추출 시도
        var salesData = await page1.evaluate(function() {
            try {
                if (window.__PRELOADED_STATE__ && window.__PRELOADED_STATE__.product && window.__PRELOADED_STATE__.product.A) {
                    var s = window.__PRELOADED_STATE__.product.A.saleAmount;
                    if (s) {
                        return { 
                            recent: parseInt(s.recentSaleCount || 0, 10), 
                            cumul: parseInt(s.cumulationSaleCount || s.totalSaleCount || 0, 10) 
                        };
                    }
                }
            } catch(e) {}
            return null;
        });

        // 2. 만약 객체에서 못 찾았다면, HTML 소스코드 정규식으로 이중 검색 (백업 플랜)
        if (!salesData || (salesData.recent === 0 && salesData.cumul === 0)) {
            var htmlContent = await page1.content();
            var recentMatch = htmlContent.match(/"recentSaleCount"\s*:\s*(\d+)/) || htmlContent.match(/"purchaseCount"\s*:\s*(\d+)/);
            var cumulMatch = htmlContent.match(/"cumulationSaleCount"\s*:\s*(\d+)/) || htmlContent.match(/"totalSaleCount"\s*:\s*(\d+)/);
            
            salesData = {
                recent: recentMatch ? parseInt(recentMatch[1], 10) : 0,
                cumul: cumulMatch ? parseInt(cumulMatch[1], 10) : 0
            };
        }

        // 데이터 매핑
        if (salesData) {
            productMap[pid].purchase_count = salesData.recent > 0 ? salesData.recent : salesData.cumul;
            productMap[pid].total_purchase_count = salesData.cumul;

            if (salesData.recent > 0 || salesData.cumul > 0) {
                result.debug.fetch.success++;
                console.log(`[v24] Success ID: ${pid} / Recent: ${salesData.recent} / Cumul: ${salesData.cumul}`);
            }
        }

      } catch(err) {
        console.log('[v24] Error on product ' + pid + ': ' + err.message);
      }
    }

    // ===== PHASE 3: 최종 데이터 포맷팅 =====
    result.method_used = 'sequential_single_tab_extraction_v24';
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
