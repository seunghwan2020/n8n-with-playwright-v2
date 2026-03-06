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

// ============ SPY: 상품 페이지 네트워크 전수 캡처 ============
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
        var parsed = null;
        try { parsed = JSON.parse(body); } catch(e) {}
        captured.push({
          url: reqUrl.length > 200 ? reqUrl.slice(0, 200) + '...' : reqUrl,
          status: response.status(),
          size: body.length,
          keys: parsed ? Object.keys(parsed).slice(0, 30) : [],
          has_purchase: body.indexOf('urchase') > -1 || body.indexOf('판매') > -1 || body.indexOf('구매') > -1 || body.indexOf('saleCount') > -1 || body.indexOf('cumulat') > -1,
          snippet: body.slice(0, 400)
        });
      }
    } catch(e) {}
  });

  try {
    await page.addInitScript(function() { Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } }); });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    return { status: 'OK', url: url, final_url: page.url(), captured_count: captured.length, captured: captured };
  } catch(e) {
    return { status: 'ERROR', error: e.message, captured_count: captured.length, captured: captured };
  } finally {
    await page.close();
    await ctx.close();
  }
}

// ============ SCRAPE ============
async function scrape(params) {
  var url = params.url;
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
  var result = { status: 'OK', data: [], channel_uid: '', error: null, method_used: 'dom_enhanced' };

  var br = await getBrowser();
  var ctx = await br.newContext(ctxOpts());
  var page = await ctx.newPage();

  try {
    await page.addInitScript(function() { Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } }); });
    console.log('[naver_store] ' + storeSlug + ' -> ' + url);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight / 2); });
    await page.waitForTimeout(1500);
    await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(1500);

    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    var domProducts = await page.evaluate(function() {
      var items = [];
      var seen = {};
      var allLinks = document.querySelectorAll('a[href*="/products/"]');
      for (var i = 0; i < allLinks.length; i++) {
        var link = allLinks[i];
        var href = link.getAttribute('href') || '';
        var m = href.match(/products\/(\d+)/);
        if (!m) continue;
        var pid = m[1];
        if (seen[pid]) continue;
        seen[pid] = true;
        var container = link.closest('li') || link.closest('[class*="product"]') || link.parentElement.parentElement;
        if (!container) container = link.parentElement;
        var allText = (container.innerText || '').trim();
        var imgEl = container.querySelector('img');
        var lines = allText.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 3; });
        var productName = '';
        for (var k = 0; k < lines.length; k++) {
          if (!/^\d/.test(lines[k]) && !/원$/.test(lines[k]) && lines[k] !== '상품 바로가기' && lines[k] !== '현재 페이지' && lines[k].length > 3) {
            productName = lines[k];
            break;
          }
        }
        var priceMatch = allText.match(/(\d{1,3}(?:,\d{3})+)원/);
        var salePrice = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0;
        var reviewMatch = allText.match(/리뷰\s*(\d[\d,]*)/);
        var reviewCount = reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, '')) : 0;
        if (productName) {
          items.push({
            product_id: pid,
            product_name: productName,
            sale_price: salePrice,
            product_image_url: imgEl ? (imgEl.getAttribute('src') || '').split('?')[0] : '',
            review_count: reviewCount
          });
        }
      }
      return items;
    });

    for (var d = 0; d < domProducts.length; d++) {
      var dp = domProducts[d];
      result.data.push({
        product_id: dp.product_id,
        product_name: dp.product_name,
        sale_price: dp.sale_price || 0,
        discount_price: null,
        review_count: dp.review_count || 0,
        purchase_count: 0,
        product_image_url: dp.product_image_url || '',
        category_name: '',
        is_sold_out: false,
        product_url: baseUrl + '/products/' + dp.product_id
      });
    }

    console.log('[naver_store] ' + storeSlug + ': ' + result.data.length + ' products');
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

// ============ 진입점 ============
async function execute(action, req, res) {
  console.log('[naver_store] action=' + action);
  if (action === 'scrape') return res.json(await scrape(req.body));
  if (action === 'spy') return res.json(await spy(req.body));
  return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
}

module.exports = { execute };
