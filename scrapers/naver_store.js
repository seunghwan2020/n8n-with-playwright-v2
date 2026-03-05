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

// ============ DEBUG: 페이지 실제 상태 확인 ============
async function debug(params) {
  var url = params.url || 'https://brand.naver.com/dcurvin';
  var storeSlug = params.store_slug || 'dcurvin';
  var br = await getBrowser();
  var ctx = await br.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul'
  });
  var page = await ctx.newPage();
  var result = { status: 'OK', store_slug: storeSlug, url: url };

  try {
    await page.addInitScript(function() {
      Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
    });

    console.log('[naver_store:debug] ' + storeSlug + ' -> ' + url);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // 1) 현재 URL (리다이렉트 여부)
    result.final_url = page.url();

    // 2) 페이지 타이틀
    result.page_title = await page.title();

    // 3) __NEXT_DATA__ 존재 여부 + 일부 내용
    var nextInfo = await page.evaluate(function() {
      var el = document.getElementById('__NEXT_DATA__');
      if (!el) return { exists: false, text_length: 0, snippet: '' };
      var txt = el.textContent || '';
      var parsed = null;
      try { parsed = JSON.parse(txt); } catch(e) {}
      var info = { exists: true, text_length: txt.length, snippet: txt.slice(0, 500) };
      if (parsed && parsed.props && parsed.props.pageProps) {
        var pp = parsed.props.pageProps;
        info.pageProps_keys = Object.keys(pp);
        if (pp.channel) info.channel = { channelUid: pp.channel.channelUid, channelName: pp.channel.channelName };
        if (pp.products) info.products_count = pp.products.length;
        if (pp.productList) info.productList_count = pp.productList.length;
        if (pp.initialState) info.initialState_keys = Object.keys(pp.initialState);
        if (pp.pageData) info.pageData_keys = Object.keys(pp.pageData);
      }
      return info;
    });
    result.next_data = nextInfo;

    // 4) 주요 DOM 요소 탐색
    var domInfo = await page.evaluate(function() {
      var info = {};
      // 상품 관련 셀렉터 후보들
      var selectors = [
        'ul.productList_list__T_5ke li',
        '[class*="productList"] li',
        '[class*="ProductList"] li',
        '.product_item',
        '[class*="product_item"]',
        '[class*="Product_item"]',
        'a[href*="/products/"]',
        '[data-shp-contents-type="product"]',
        '[class*="thumbnail"]',
        'li[class*="item"]'
      ];
      for (var i = 0; i < selectors.length; i++) {
        var count = document.querySelectorAll(selectors[i]).length;
        if (count > 0) info[selectors[i]] = count;
      }

      // 페이지 전체 링크 중 /products/ 포함하는 것
      var productLinks = [];
      var allLinks = document.querySelectorAll('a[href*="/products/"]');
      for (var j = 0; j < Math.min(allLinks.length, 5); j++) {
        productLinks.push(allLinks[j].getAttribute('href'));
      }
      info.product_links_sample = productLinks;
      info.product_links_total = document.querySelectorAll('a[href*="/products/"]').length;

      // body 텍스트 길이 (빈 페이지 체크)
      info.body_text_length = (document.body.innerText || '').length;

      // 에러 페이지 체크
      info.has_error_page = !!(document.querySelector('.error_page') || document.querySelector('[class*="error"]'));

      return info;
    });
    result.dom_info = domInfo;

    // 5) HTML 첫 2000자 (구조 파악용)
    var bodyHtml = await page.evaluate(function() {
      return document.body.innerHTML.slice(0, 2000);
    });
    result.body_html_snippet = bodyHtml;

  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message || String(e);
  } finally {
    await page.close();
    await ctx.close();
  }
  return result;
}

// ============ SCRAPE: 상품 목록 크롤링 ============
async function scrape(params) {
  var url = params.url;
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
  var result = { status: 'OK', data: [], channel_uid: '', error: null };

  var br = await getBrowser();
  var ctx = await br.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul'
  });
  var page = await ctx.newPage();

  try {
    await page.addInitScript(function() {
      Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
    });

    console.log('[naver_store] ' + storeSlug + ' -> ' + url);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // ========== 방법 1: __NEXT_DATA__ ==========
    var nextDataStr = await page.evaluate(function() {
      var el = document.getElementById('__NEXT_DATA__');
      return el ? el.textContent : null;
    });

    if (nextDataStr) {
      try {
        var nd = JSON.parse(nextDataStr);
        var pp = nd.props && nd.props.pageProps;
        if (pp) {
          if (pp.channel) result.channel_uid = pp.channel.channelUid || pp.channel.id || '';
          if (!result.channel_uid && pp.channelUid) result.channel_uid = pp.channelUid;

          var list = pp.products || pp.productList || [];
          if (!list.length && pp.initialState && pp.initialState.products) {
            var ps = pp.initialState.products;
            list = ps.list || ps.items || [];
          }
          if (!list.length && pp.pageData && pp.pageData.products) {
            list = pp.pageData.products;
          }

          var baseUrl = storeType === 'brand'
            ? 'https://brand.naver.com/' + storeSlug
            : 'https://smartstore.naver.com/' + storeSlug;

          for (var i = 0; i < list.length; i++) {
            var p = list[i];
            var pid = String(p.id || p.productNo || p.channelProductNo || '');
            if (!pid) continue;
            result.data.push({
              product_id: pid,
              product_name: p.name || p.productName || '',
              sale_price: p.salePrice || p.price || p.discountedSalePrice || 0,
              discount_price: p.discountedSalePrice || null,
              review_count: p.reviewCount || p.totalReviewCount || 0,
              purchase_count: p.purchaseCount || p.totalPurchaseCount || 0,
              product_image_url: (p.representativeImageUrl || p.imageUrl || p.productImageUrl || '').split('?')[0],
              category_name: p.categoryName || '',
              is_sold_out: p.saleStatus === 'OUTOFSTOCK' || p.isSoldOut || false,
              product_url: baseUrl + '/products/' + pid
            });
          }
          console.log('[naver_store] ' + storeSlug + ': __NEXT_DATA__ -> ' + result.data.length + ' products');
        }
      } catch (e) {
        console.log('[naver_store] __NEXT_DATA__ parse error: ' + e.message);
      }
    }

    // ========== 방법 2: DOM 셀렉터 (fallback) ==========
    if (result.data.length === 0) {
      var domProducts = await page.evaluate(function() {
        var items = [];
        // 여러 셀렉터 시도
        var productEls = document.querySelectorAll('a[href*="/products/"]');
        var seen = {};
        for (var i = 0; i < productEls.length; i++) {
          var el = productEls[i];
          var href = el.getAttribute('href') || '';
          var m = href.match(/products\/(\d+)/);
          if (!m) continue;
          var pid = m[1];
          if (seen[pid]) continue;
          seen[pid] = true;

          // 상위 요소에서 상품명, 가격 찾기
          var container = el.closest('li') || el.closest('[class*="product"]') || el.parentElement;
          var nameEl = container ? (container.querySelector('[class*="name"]') || container.querySelector('[class*="title"]')) : null;
          var priceEl = container ? (container.querySelector('[class*="price"]') || container.querySelector('[class*="sale"]')) : null;
          var imgEl = container ? container.querySelector('img') : el.querySelector('img');

          items.push({
            product_id: pid,
            product_name: nameEl ? nameEl.textContent.trim() : '',
            sale_price: priceEl ? parseInt((priceEl.textContent || '0').replace(/[^0-9]/g, '')) || 0 : 0,
            product_image_url: imgEl ? (imgEl.getAttribute('src') || '') : ''
          });
        }
        return items;
      });

      var baseUrl2 = storeType === 'brand'
        ? 'https://brand.naver.com/' + storeSlug
        : 'https://smartstore.naver.com/' + storeSlug;

      for (var j = 0; j < domProducts.length; j++) {
        var dp = domProducts[j];
        if (dp.product_id) {
          dp.discount_price = null;
          dp.review_count = 0;
          dp.purchase_count = 0;
          dp.category_name = '';
          dp.is_sold_out = false;
          dp.option_count = 0;
          dp.product_url = baseUrl2 + '/products/' + dp.product_id;
          result.data.push(dp);
        }
      }
      console.log('[naver_store] ' + storeSlug + ': DOM fallback -> ' + result.data.length + ' products');
    }

    if (result.data.length === 0) {
      result.status = 'EMPTY';
      result.error = 'No products found';
    }
  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message || String(e);
    console.error('[naver_store] ERROR: ' + result.error);
  } finally {
    await page.close();
    await ctx.close();
  }
  return result;
}

// ============ 진입점 ============
async function execute(action, req, res) {
  console.log('[naver_store] action=' + action + ' store=' + (req.body.store_slug || ''));
  if (action === 'scrape') {
    var result = await scrape(req.body);
    return res.json(result);
  }
  if (action === 'debug') {
    var debugResult = await debug(req.body);
    return res.json(debugResult);
  }
  return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action + '. (supported: scrape, debug)' });
}

module.exports = { execute };
