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

// ============ SCRAPE v27: Iframe Injection (Bypass WAF & Timeout 503) ============
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
    console.log('[v27] Starting Browser...');
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

    // 🚀 속도 극대화를 위해 불필요한 리소스(이미지/CSS 등) 로딩 원천 차단
    await page1.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    // ===== PHASE 1: 스토어 메인 접속 및 상품 리스트 파싱 =====
    var domainRoot = storeType === 'brand' ? 'https://brand.naver.com' : 'https://smartstore.naver.com';
    var baseUrl = domainRoot + '/' + storeSlug;
    var apiRoot = storeType === 'brand' ? 'https://brand.naver.com/n/v2/channels/' : 'https://smartstore.naver.com/i/v1/channels/';

    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v27] P1: Navigating to Store: ' + targetUrl);
    
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

    // ===== PHASE 2: 🚀 확장 프로그램 로직 구현 (Iframe 병렬 삽입 기법) =====
    // 새 탭을 열거나 fetch를 쓰지 않고, 현재 창에 Iframe을 투명하게 띄워 데이터를 훔쳐옵니다. (타임아웃 완벽 해결)
    console.log('[v27] P2: Deep scanning via parallel Iframe injections...');
    var pids = Object.keys(productMap);
    var fetchBatchSize = 10; // 10개씩 초고속으로 처리
    
    result.debug.fetch = { total: pids.length, success: 0 };

    for (var i = 0; i < pids.length; i += fetchBatchSize) {
      var fetchBatch = pids.slice(i, i + fetchBatchSize);
      
      var countsResult = await page1.evaluate(async function(args) {
        var results = {};
        
        var promises = args.ids.map(function(id) {
            return new Promise(function(resolve) {
                // 투명한 아이프레임 생성
                var iframe = document.createElement('iframe');
                iframe.src = args.baseUrl + '/products/' + id;
                iframe.style.width = '1px';
                iframe.style.height = '1px';
                iframe.style.opacity = '0';
                iframe.style.position = 'absolute';
                iframe.style.pointerEvents = 'none';
                
                // 혹시 모를 로딩 지연 방지용 타임아웃 (6초)
                var timeout = setTimeout(function() {
                    try { document.body.removeChild(iframe); } catch(e){}
                    resolve({ id: id, recent: 0, cumul: 0 });
                }, 6000); 
                
                // 아이프레임 로딩 완료 시 데이터 추출
                iframe.onload = function() {
                    clearTimeout(timeout);
                    var recent = 0, cumul = 0;
                    try {
                        var win = iframe.contentWindow;
                        var doc = iframe.contentDocument;
                        
                        // 1. 상태 객체에서 직접 추출 (정확도 100%)
                        if (win && win.__PRELOADED_STATE__ && win.__PRELOADED_STATE__.product && win.__PRELOADED_STATE__.product.A) {
                            var s = win.__PRELOADED_STATE__.product.A.saleAmount;
                            if (s) {
                                recent = parseInt(s.recentSaleCount || 0, 10);
                                cumul = parseInt(s.cumulationSaleCount || s.totalSaleCount || 0, 10);
                            }
                        }
                        
                        // 2. 만약 객체가 비어있다면 정규식 딥스캔 (백업)
                        if (recent === 0 && cumul === 0 && doc) {
                            var text = doc.documentElement.innerHTML;
                            var rMatch = text.match(/recentSaleCount["']?\s*:\s*(\d+)/i);
                            if (rMatch) recent = parseInt(rMatch[1], 10);
                            
                            var cMatch = text.match(/(?:cumulationSaleCount|totalSaleCount)["']?\s*:\s*(\d+)/i);
                            if (cMatch) cumul = parseInt(cMatch[1], 10);
                        }
                    } catch(e) {}
                    
                    // 추출 완료 후 아이프레임 폐기
                    setTimeout(function() {
                        try { document.body.removeChild(iframe); } catch(e){}
                    }, 50);
                    
                    resolve({ id: id, recent: recent, cumul: cumul });
                };
                
                document.body.appendChild(iframe);
            });
        });
        
        // 10개의 아이프레임을 동시에 처리 후 취합
        var arr = await Promise.all(promises);
        for(var k=0; k<arr.length; k++) {
            results[arr[k].id] = arr[k];
        }
        return results;

      }, { ids: fetchBatch, baseUrl: baseUrl });

      // 취합된 결과 매핑
      for (var id in countsResult) {
        var c = countsResult[id];
        productMap[id].purchase_count = c.recent > 0 ? c.recent : c.cumul;
        productMap[id].total_purchase_count = c.cumul;
        
        if (c.recent > 0 || c.cumul > 0) {
          result.debug.fetch.success++;
        }
      }
      
      // 서버 과부하 방지 아주 짧은 딜레이
      if (i + fetchBatchSize < pids.length) {
        await page1.waitForTimeout(300); 
      }
    }

    // ===== PHASE 3: 최종 데이터 포맷팅 =====
    result.method_used = 'iframe_injection_fast_v27';
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
