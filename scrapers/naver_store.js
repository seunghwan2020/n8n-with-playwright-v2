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

function newContextOpts() {
  return {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul'
  };
}

// ============ DEBUG ============
async function debug(params) {
  var url = params.url || 'https://brand.naver.com/dcurvin';
  var br = await getBrowser();
  var ctx = await br.newContext(newContextOpts());
  var page = await ctx.newPage();
  var result = { status: 'OK', url: url };
  try {
    await page.addInitScript(function() {
      Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
    });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
    result.final_url = page.url();
    result.page_title = await page.title();
    result.next_data_exists = await page.evaluate(function() { return !!document.getElementById('__NEXT_DATA__'); });
    result.product_links = await page.evaluate(function() { return document.querySelectorAll('a[href*="/products/"]').length; });
  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message;
  } finally {
    await page.close();
    await ctx.close();
  }
  return result;
}

// ============ 상품 상세에서 purchase_count 추출 ============
async function getProductDetail(page, productUrl) {
  var detail = { purchase_count: 0, discount_price: null, category_name: '' };
  try {
    await page.goto(productUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    detail = await page.evaluate(function() {
      var out = { purchase_count: 0, discount_price: null, category_name: '' };
      var text = document.body.innerText || '';

      // 구매건수: "구매 N" 또는 "N건 구매" 패턴
      var purchasePatterns = [
        /(\d[\d,]*)\s*건\s*구매/,
        /구매\s*(\d[\d,]*)/,
        /(\d[\d,]*)\s*개\s*구매/,
        /총\s*(\d[\d,]*)\s*개/
      ];
      for (var i = 0; i < purchasePatterns.length; i++) {
        var m = text.match(purchasePatterns[i]);
        if (m) {
          out.purchase_count = parseInt(m[1].replace(/,/g, ''));
          break;
        }
      }

      // 할인가
      var discountEl = document.querySelector('[class*="discount"] [class*="price"], [class*="sale"] [class*="price"]');
      if (discountEl) {
        var dp = parseInt((discountEl.innerText || '').replace(/[^0-9]/g, ''));
        if (dp > 0) out.discount_price = dp;
      }

      // 카테고리
      var breadcrumbs = document.querySelectorAll('[class*="breadcrumb"] a, [class*="category"] a');
      if (breadcrumbs.length > 0) {
        out.category_name = breadcrumbs[breadcrumbs.length - 1].innerText.trim();
      }

      return out;
    });
  } catch (e) {
    console.log('[naver_store] detail error for ' + productUrl + ': ' + e.message);
  }
  return detail;
}

// ============ SCRAPE: 리스트 + 상세 크롤링 ============
async function scrape(params) {
  var url = params.url;
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
  var skipDetail = params.skip_detail || false;
  var result = { status: 'OK', data: [], channel_uid: '', error: null, method_used: '' };

  var br = await getBrowser();
  var ctx = await br.newContext(newContextOpts());
  var page = await ctx.newPage();

  try {
    await page.addInitScript(function() {
      Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
    });

    console.log('[naver_store] ' + storeSlug + ' -> ' + url);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // 스크롤해서 추가 상품 로드
    await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight / 2); });
    await page.waitForTimeout(2000);
    await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(2000);

    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    // ========== DOM 강화 추출 ==========
    result.method_used = 'dom_enhanced';
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

        // 상품명: 가격이 아닌 유의미한 텍스트 라인
        var lines = allText.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 3; });
        var productName = '';
        for (var k = 0; k < lines.length; k++) {
          if (!/^\d/.test(lines[k]) && !/원$/.test(lines[k]) && lines[k] !== '상품 바로가기' && lines[k].length > 3) {
            productName = lines[k];
            break;
          }
        }

        // 가격: N,NNN원 패턴
        var priceMatch = allText.match(/(\d{1,3}(?:,\d{3})+)원/);
        var salePrice = 0;
        if (priceMatch) {
          salePrice = parseInt(priceMatch[1].replace(/,/g, ''));
        }

        // 리뷰 수
        var reviewMatch = allText.match(/리뷰\s*(\d[\d,]*)/);
        var reviewCount = reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, '')) : 0;

        items.push({
          product_id: pid,
          product_name: productName,
          sale_price: salePrice,
          product_image_url: imgEl ? (imgEl.getAttribute('src') || '') : '',
          review_count: reviewCount
        });
      }
      return items;
    });

    // 배너/더미 링크 필터링: 상품명 없거나 "상품 바로가기"인 항목 제거
    var filtered = [];
    for (var f = 0; f < domProducts.length; f++) {
      var dp = domProducts[f];
      if (dp.product_name && dp.product_name !== '상품 바로가기' && dp.product_name.length > 3) {
        filtered.push(dp);
      }
    }
    console.log('[naver_store] ' + storeSlug + ': ' + domProducts.length + ' raw -> ' + filtered.length + ' filtered');

    // ========== 상세 페이지 크롤링 (purchase_count 수집) ==========
    if (!skipDetail && filtered.length > 0) {
      result.method_used = 'dom_enhanced+detail';
      console.log('[naver_store] ' + storeSlug + ': starting detail crawl for ' + filtered.length + ' products');

      for (var d = 0; d < filtered.length; d++) {
        var productUrl = baseUrl + '/products/' + filtered[d].product_id;
        console.log('[naver_store] detail ' + (d + 1) + '/' + filtered.length + ': ' + filtered[d].product_id);

        var detail = await getProductDetail(page, productUrl);
        filtered[d].purchase_count = detail.purchase_count;
        if (detail.discount_price) filtered[d].discount_price = detail.discount_price;
        if (detail.category_name) filtered[d].category_name = detail.category_name;

        // 상품 간 딜레이 (봇 감지 방지)
        if (d < filtered.length - 1) {
          await page.waitForTimeout(1500 + Math.floor(Math.random() * 1000));
        }
      }
    }

    // 최종 결과 구성
    for (var r = 0; r < filtered.length; r++) {
      var p = filtered[r];
      result.data.push({
        product_id: p.product_id,
        product_name: p.product_name,
        sale_price: p.sale_price || 0,
        discount_price: p.discount_price || null,
        review_count: p.review_count || 0,
        purchase_count: p.purchase_count || 0,
        product_image_url: (p.product_image_url || '').split('?')[0],
        category_name: p.category_name || '',
        is_sold_out: false,
        product_url: baseUrl + '/products/' + p.product_id
      });
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
  return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
}

module.exports = { execute };
