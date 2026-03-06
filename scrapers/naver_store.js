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

// ============ SCRAPE v6: network intercept + simple-products API ============
async function scrape(params) {
  var url = params.url;
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
  var result = { status: 'OK', data: [], channel_uid: '', error: null, method_used: '' };

  var br = await getBrowser();
  var ctx = await br.newContext(ctxOpts());
  var page = await ctx.newPage();

  // 네트워크에서 channelUid와 simple-products 데이터 캡처
  var capturedChannelUid = '';
  var capturedSimpleProducts = [];

  page.on('response', async function(response) {
    try {
      var reqUrl = response.url();
      var ct = response.headers()['content-type'] || '';
      if (ct.indexOf('json') === -1 || response.status() !== 200) return;

      // channelUid 추출 (channels/XXXX/ 패턴에서)
      if (!capturedChannelUid) {
        var uidMatch = reqUrl.match(/channels\/([a-zA-Z0-9]+)\//);
        if (uidMatch) capturedChannelUid = uidMatch[1];
      }

      // simple-products 응답 캡처
      if (reqUrl.indexOf('simple-products') > -1) {
        var body = await response.json();
        if (Array.isArray(body)) {
          for (var i = 0; i < body.length; i++) capturedSimpleProducts.push(body[i]);
          console.log('[naver_store] captured simple-products: ' + body.length);
        }
      }
    } catch(e) {}
  });

  try {
    await page.addInitScript(function() {
      Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
    });

    console.log('[naver_store] ' + storeSlug + ' -> ' + url);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // 스크롤로 추가 상품 로드 유도
    await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight / 2); });
    await page.waitForTimeout(1500);
    await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(2000);

    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    // ========== 방법 1: 캡처된 simple-products 사용 (가장 완전한 데이터) ==========
    if (capturedSimpleProducts.length > 0) {
      result.method_used = 'network_simple_products';
      result.channel_uid = capturedChannelUid;
      var seen = {};
      for (var i = 0; i < capturedSimpleProducts.length; i++) {
        var p = capturedSimpleProducts[i];
        var pid = String(p.id || '');
        if (!pid || seen[pid]) continue;
        seen[pid] = true;
        result.data.push({
          product_id: pid,
          product_name: p.name || '',
          sale_price: p.salePrice || p.price || 0,
          discount_price: p.benefitsView ? (p.benefitsView.discountedSalePrice || null) : null,
          review_count: p.reviewAmount || p.reviewCount || 0,
          purchase_count: p.purchaseAmount || p.purchaseCount || p.totalPurchaseCount || 0,
          product_image_url: (p.representativeImageUrl || '').split('?')[0],
          category_name: p.category ? (p.category.wholeCategoryName || p.category.categoryName || '') : '',
          is_sold_out: p.saleStatus === 'OUTOFSTOCK' || false,
          product_url: baseUrl + '/products/' + pid
        });
      }
      console.log('[naver_store] ' + storeSlug + ': network captured ' + result.data.length + ' products');
    }

    // ========== 방법 2: DOM에서 상품 ID 추출 → in-page simple-products API 호출 ==========
    if (result.data.length === 0 && capturedChannelUid) {
      result.method_used = 'inpage_simple_products';
      result.channel_uid = capturedChannelUid;

      // DOM에서 상품 ID 수집
      var productIds = await page.evaluate(function() {
        var ids = [];
        var seen = {};
        var links = document.querySelectorAll('a[href*="/products/"]');
        for (var i = 0; i < links.length; i++) {
          var m = (links[i].getAttribute('href') || '').match(/products\/(\d+)/);
          if (m && !seen[m[1]]) {
            seen[m[1]] = true;
            ids.push(m[1]);
          }
        }
        return ids;
      });

      if (productIds.length > 0) {
        // 브라우저 내에서 simple-products API 직접 호출
        var apiData = await page.evaluate(async function(args) {
          var uid = args.uid;
          var ids = args.ids;
          try {
            var apiUrl = 'https://brand.naver.com/n/v2/channels/' + uid + '/simple-products?ids[]=' + ids.join(',');
            var res = await fetch(apiUrl, { credentials: 'include' });
            if (res.ok) {
              return await res.json();
            }
            return { error: 'status ' + res.status };
          } catch(e) {
            return { error: e.message };
          }
        }, { uid: capturedChannelUid, ids: productIds });

        if (Array.isArray(apiData)) {
          var seen2 = {};
          for (var j = 0; j < apiData.length; j++) {
            var p2 = apiData[j];
            var pid2 = String(p2.id || '');
            if (!pid2 || seen2[pid2]) continue;
            seen2[pid2] = true;
            result.data.push({
              product_id: pid2,
              product_name: p2.name || '',
              sale_price: p2.salePrice || p2.price || 0,
              discount_price: p2.benefitsView ? (p2.benefitsView.discountedSalePrice || null) : null,
              review_count: p2.reviewAmount || p2.reviewCount || 0,
              purchase_count: p2.purchaseAmount || p2.purchaseCount || p2.totalPurchaseCount || 0,
              product_image_url: (p2.representativeImageUrl || '').split('?')[0],
              category_name: p2.category ? (p2.category.wholeCategoryName || p2.category.categoryName || '') : '',
              is_sold_out: p2.saleStatus === 'OUTOFSTOCK' || false,
              product_url: baseUrl + '/products/' + pid2
            });
          }
          console.log('[naver_store] ' + storeSlug + ': in-page API -> ' + result.data.length + ' products');
        }
      }
    }

    // ========== 방법 3: DOM fallback (API 모두 실패 시) ==========
    if (result.data.length === 0) {
      result.method_used = 'dom_fallback';
      if (capturedChannelUid) result.channel_uid = capturedChannelUid;
      var domProducts = await page.evaluate(function() {
        var items = [];
        var seen = {};
        var links = document.querySelectorAll('a[href*="/products/"]');
        for (var i = 0; i < links.length; i++) {
          var href = links[i].getAttribute('href') || '';
          var m = href.match(/products\/(\d+)/);
          if (!m || seen[m[1]]) continue;
          seen[m[1]] = true;
          var container = links[i].closest('li') || links[i].parentElement.parentElement || links[i].parentElement;
          var text = (container.innerText || '').trim();
          var img = container.querySelector('img');
          var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 3; });
          var name = '';
          for (var k = 0; k < lines.length; k++) {
            if (!/^\d/.test(lines[k]) && !/원$/.test(lines[k]) && lines[k] !== '상품 바로가기' && lines[k] !== '현재 페이지') {
              name = lines[k]; break;
            }
          }
          var priceMatch = text.match(/(\d{1,3}(?:,\d{3})+)원/);
          if (name) {
            items.push({
              product_id: m[1], product_name: name,
              sale_price: priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0,
              product_image_url: img ? (img.getAttribute('src') || '').split('?')[0] : ''
            });
          }
        }
        return items;
      });
      for (var d = 0; d < domProducts.length; d++) {
        var dp = domProducts[d];
        result.data.push({
          product_id: dp.product_id, product_name: dp.product_name, sale_price: dp.sale_price,
          discount_price: null, review_count: 0, purchase_count: 0,
          product_image_url: dp.product_image_url, category_name: '', is_sold_out: false,
          product_url: baseUrl + '/products/' + dp.product_id
        });
      }
    }

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

// ============ SPY (디버그용) ============
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
          has_purchase: body.indexOf('urchase') > -1 || body.indexOf('saleCount') > -1,
          snippet: body.slice(0, 400)
        });
      }
    } catch(e) {}
  });
  try {
    await page.addInitScript(function() { Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } }); });
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

// ============ 진입점 ============
async function execute(action, req, res) {
  console.log('[naver_store] action=' + action);
  if (action === 'scrape') return res.json(await scrape(req.body));
  if (action === 'spy') return res.json(await spy(req.body));
  return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
}

module.exports = { execute };
