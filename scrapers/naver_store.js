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

async function scrape(params) {
  const { url, store_slug, store_type = 'brand' } = params;
  const result = { status: 'OK', data: [], channel_uid: '', error: null };
  const br = await getBrowser();
  const ctx = await br.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul'
  });
  const page = await ctx.newPage();

  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    console.log('[naver_store] ' + store_slug + ' -> ' + url);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2000);

    var nextDataStr = await page.evaluate(() => {
      var el = document.getElementById('__NEXT_DATA__');
      return el ? el.textContent : null;
    });

    if (nextDataStr) {
      try {
        var nextData = JSON.parse(nextDataStr);
        var pp = nextData.props && nextData.props.pageProps;
        if (pp) {
          if (pp.channel) result.channel_uid = pp.channel.channelUid || pp.channel.id || '';
          if (!result.channel_uid && pp.channelUid) result.channel_uid = pp.channelUid;

          var list = [];
          if (pp.products && pp.products.length) list = pp.products;
          else if (pp.productList && pp.productList.length) list = pp.productList;
          else if (pp.initialState && pp.initialState.products) {
            var ps = pp.initialState.products;
            list = ps.list || ps.items || [];
          }
          else if (pp.pageData && pp.pageData.products) list = pp.pageData.products;

          var baseUrl = store_type === 'brand'
            ? 'https://brand.naver.com/' + store_slug
            : 'https://smartstore.naver.com/' + store_slug;

          for (var i = 0; i < list.length; i++) {
            var p = list[i];
            var pid = String(p.id || p.productNo || p.channelProductNo || '');
            if (!pid) continue;
            result.data.push({
              product_id: pid,
              product_name: p.name || p.productName || '',
              sale_price: p.salePrice || p.price || 0,
              discount_price: p.discountedSalePrice || null,
              review_count: p.reviewCount || p.totalReviewCount || 0,
              purchase_count: p.purchaseCount || p.totalPurchaseCount || 0,
              product_image_url: (p.representImage && p.representImage.url) || p.imageUrl || '',
              category_name: p.categoryName || '',
              is_sold_out: p.isSoldOut || p.soldOut || false,
              option_count: (p.options && p.options.length) || 0,
              product_url: baseUrl + '/products/' + pid
            });
          }
          console.log('[naver_store] ' + store_slug + ': ' + result.data.length + ' products from __NEXT_DATA__');
        }
      } catch (e) {
        console.log('[naver_store] __NEXT_DATA__ parse failed, trying DOM');
      }
    }

    if (result.data.length === 0) {
      var domProducts = await page.evaluate(() => {
        var items = [];
        document.querySelectorAll('li[class*="product"], a[class*="product"]').forEach(function(card) {
          var nameEl = card.querySelector('[class*="name"], [class*="title"]');
          var priceEl = card.querySelector('[class*="price"], [class*="num"]');
          var linkEl = card.querySelector('a[href*="/products/"]') || card.closest('a[href*="/products/"]');
          var imgEl = card.querySelector('img');
          if (nameEl && priceEl) {
            var href = linkEl ? linkEl.getAttribute('href') : '';
            var m = href.match(/products\/(\d+)/);
            items.push({
              product_id: m ? m[1] : '',
              product_name: nameEl.textContent.trim(),
              sale_price: parseInt((priceEl.textContent || '0').replace(/[^0-9]/g, '')) || 0,
              product_image_url: imgEl ? (imgEl.getAttribute('src') || '') : ''
            });
          }
        });
        return items;
      });

      var baseUrl2 = store_type === 'brand'
        ? 'https://brand.naver.com/' + store_slug
        : 'https://smartstore.naver.com/' + store_slug;

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
      console.log('[naver_store] ' + store_slug + ': ' + result.data.length + ' products from DOM');
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

async function execute(action, req, res) {
  console.log('[naver_store] action=' + action + ' store=' + req.body.store_slug);
  if (action === 'scrape') {
    var result = await scrape(req.body);
    return res.json(result);
  }
  return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
}

module.exports = { execute };
