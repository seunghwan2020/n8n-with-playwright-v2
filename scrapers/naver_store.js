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

// ============ DEBUG ============
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
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    result.final_url = page.url();
    result.page_title = await page.title();

    var nextInfo = await page.evaluate(function() {
      var el = document.getElementById('__NEXT_DATA__');
      if (!el) return { exists: false };
      var txt = el.textContent || '';
      var info = { exists: true, text_length: txt.length, snippet: txt.slice(0, 500) };
      try {
        var parsed = JSON.parse(txt);
        if (parsed.props && parsed.props.pageProps) {
          info.pageProps_keys = Object.keys(parsed.props.pageProps);
        }
      } catch(e) {}
      return info;
    });
    result.next_data = nextInfo;

    var domInfo = await page.evaluate(function() {
      return {
        product_links_total: document.querySelectorAll('a[href*="/products/"]').length,
        li_items: document.querySelectorAll('li[class*="item"]').length,
        body_text_length: (document.body.innerText || '').length
      };
    });
    result.dom_info = domInfo;
  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message;
  } finally {
    await page.close();
    await ctx.close();
  }
  return result;
}

// ============ SCRAPE v2: 네트워크 인터셉트 + DOM 강화 ============
async function scrape(params) {
  var url = params.url;
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
  var result = { status: 'OK', data: [], channel_uid: '', error: null, method_used: '' };

  var br = await getBrowser();
  var ctx = await br.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul'
  });
  var page = await ctx.newPage();

  // 네트워크 응답에서 상품 데이터 캡처
  var capturedProducts = [];
  var capturedChannelUid = '';

  page.on('response', async function(response) {
    try {
      var reqUrl = response.url();
      // 네이버 내부 상품 API 응답 캡처
      if (reqUrl.indexOf('/products') > -1 && response.status() === 200) {
        var ct = response.headers()['content-type'] || '';
        if (ct.indexOf('json') > -1) {
          var body = await response.json();
          // 다양한 응답 구조 처리
          var items = [];
          if (body.simpleProducts) items = body.simpleProducts;
          else if (body.products) items = body.products;
          else if (body.contents) items = body.contents;
          else if (body.data && body.data.products) items = body.data.products;
          else if (Array.isArray(body)) items = body;

          for (var i = 0; i < items.length; i++) {
            capturedProducts.push(items[i]);
          }

          // channelUid 추출
          if (body.channel && body.channel.channelUid) {
            capturedChannelUid = body.channel.channelUid;
          }
          if (body.channelUid) capturedChannelUid = body.channelUid;

          console.log('[naver_store] API captured: ' + items.length + ' products from ' + reqUrl.slice(0, 120));
        }
      }
      // 채널 정보 API
      if ((reqUrl.indexOf('/channel') > -1 || reqUrl.indexOf('/home') > -1) && response.status() === 200) {
        var ct2 = response.headers()['content-type'] || '';
        if (ct2.indexOf('json') > -1) {
          var body2 = await response.json();
          if (body2.channelUid) capturedChannelUid = body2.channelUid;
          if (body2.channel && body2.channel.channelUid) capturedChannelUid = body2.channel.channelUid;
        }
      }
    } catch (e) {
      // 조용히 무시 (바이너리 응답 등)
    }
  });

  try {
    await page.addInitScript(function() {
      Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
    });

    console.log('[naver_store] ' + storeSlug + ' -> ' + url);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    // 스크롤해서 추가 상품 로드 유도
    await page.evaluate(function() {
      window.scrollTo(0, document.body.scrollHeight / 2);
    });
    await page.waitForTimeout(2000);
    await page.evaluate(function() {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(2000);

    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    // ========== 방법 1: 캡처된 API 데이터 사용 ==========
    if (capturedProducts.length > 0) {
      result.method_used = 'network_intercept';
      var seen = {};
      for (var i = 0; i < capturedProducts.length; i++) {
        var p = capturedProducts[i];
        var pid = String(p.id || p.productNo || p.channelProductNo || p.productId || '');
        if (!pid || seen[pid]) continue;
        seen[pid] = true;
        result.data.push({
          product_id: pid,
          product_name: p.name || p.productName || p.productTitle || '',
          sale_price: p.salePrice || p.price || p.channelProductPrice || 0,
          discount_price: p.discountedSalePrice || p.benefitsView && p.benefitsView.discountedSalePrice || null,
          review_count: p.reviewCount || p.totalReviewCount || p.reviewAmount || 0,
          purchase_count: p.purchaseCount || p.totalPurchaseCount || p.purchaseAmount || 0,
          product_image_url: (p.representativeImageUrl || p.imageUrl || p.productImageUrl || p.imageOriginUrl || '').split('?')[0],
          category_name: p.categoryName || p.wholeCategoryName || '',
          is_sold_out: p.saleStatus === 'OUTOFSTOCK' || p.isSoldOut || false,
          product_url: baseUrl + '/products/' + pid
        });
      }
      if (capturedChannelUid) result.channel_uid = capturedChannelUid;
      console.log('[naver_store] ' + storeSlug + ': network intercept -> ' + result.data.length + ' products');
    }

    // ========== 방법 2: 페이지 내에서 fetch API 호출 ==========
    if (result.data.length === 0) {
      var fetchResult = await page.evaluate(async function(slug, sType) {
        var apiBase = sType === 'brand'
          ? 'https://brand.naver.com/n/v2/shoppingstores/' + slug
          : 'https://smartstore.naver.com/i/v1/stores/' + slug;
        var out = { products: [], channel_uid: '', error: null };

        try {
          // 먼저 채널 정보 가져오기
          var channelRes = await fetch(apiBase, { credentials: 'include' });
          if (channelRes.ok) {
            var channelData = await channelRes.json();
            out.channel_uid = channelData.channelUid || (channelData.channel && channelData.channel.channelUid) || '';
          }
        } catch(e) {}

        try {
          // 상품 목록 API 호출
          var prodUrl = apiBase + '/products?page=1&pageSize=80&sortType=RECENT';
          var res = await fetch(prodUrl, { credentials: 'include' });
          if (res.ok) {
            var data = await res.json();
            var items = data.simpleProducts || data.products || data.contents || [];
            out.products = items;
          }
        } catch (e) {
          out.error = e.message;
        }
        return out;
      }, storeSlug, storeType);

      if (fetchResult.products && fetchResult.products.length > 0) {
        result.method_used = 'in_page_fetch';
        if (fetchResult.channel_uid) result.channel_uid = fetchResult.channel_uid;
        var seen2 = {};
        for (var j = 0; j < fetchResult.products.length; j++) {
          var p2 = fetchResult.products[j];
          var pid2 = String(p2.id || p2.productNo || p2.channelProductNo || '');
          if (!pid2 || seen2[pid2]) continue;
          seen2[pid2] = true;
          result.data.push({
            product_id: pid2,
            product_name: p2.name || p2.productName || '',
            sale_price: p2.salePrice || p2.price || 0,
            discount_price: p2.discountedSalePrice || null,
            review_count: p2.reviewCount || p2.totalReviewCount || 0,
            purchase_count: p2.purchaseCount || p2.totalPurchaseCount || 0,
            product_image_url: (p2.representativeImageUrl || p2.imageUrl || '').split('?')[0],
            category_name: p2.categoryName || '',
            is_sold_out: p2.saleStatus === 'OUTOFSTOCK' || p2.isSoldOut || false,
            product_url: baseUrl + '/products/' + pid2
          });
        }
        console.log('[naver_store] ' + storeSlug + ': in-page fetch -> ' + result.data.length + ' products');
      }
    }

    // ========== 방법 3: DOM 강화 (텍스트 패턴 매칭) ==========
    if (result.data.length === 0) {
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

          // 가장 가까운 li 또는 상위 컨테이너
          var container = link.closest('li') || link.closest('[class*="product"]') || link.parentElement.parentElement;
          if (!container) container = link.parentElement;

          var allText = (container.innerText || '').trim();
          var imgEl = container.querySelector('img');

          // 상품명: 첫 번째 유의미한 텍스트 라인
          var lines = allText.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 2; });
          var productName = '';
          for (var k = 0; k < lines.length; k++) {
            // 가격이 아닌 라인을 상품명으로 사용
            if (!/^\d/.test(lines[k]) && !/원$/.test(lines[k]) && lines[k].length > 3) {
              productName = lines[k];
              break;
            }
          }

          // 가격: 숫자+원 패턴 또는 순수 숫자(콤마 포함)
          var priceMatch = allText.match(/(\d{1,3}(?:,\d{3})+)원/);
          var salePrice = 0;
          if (priceMatch) {
            salePrice = parseInt(priceMatch[1].replace(/,/g, ''));
          } else {
            var numMatch = allText.match(/(\d{1,3}(?:,\d{3})+)/);
            if (numMatch) {
              var num = parseInt(numMatch[1].replace(/,/g, ''));
              if (num >= 1000) salePrice = num;
            }
          }

          // 리뷰 수: "리뷰 N" 또는 "(N)" 패턴
          var reviewMatch = allText.match(/리뷰\s*(\d[\d,]*)/);
          var reviewCount = reviewMatch ? parseInt(reviewMatch[1].replace(/,/g, '')) : 0;

          // 구매 수: "구매 N" 패턴
          var purchaseMatch = allText.match(/구매\s*(\d[\d,]*)/);
          var purchaseCount = purchaseMatch ? parseInt(purchaseMatch[1].replace(/,/g, '')) : 0;

          items.push({
            product_id: pid,
            product_name: productName,
            sale_price: salePrice,
            product_image_url: imgEl ? (imgEl.getAttribute('src') || '') : '',
            review_count: reviewCount,
            purchase_count: purchaseCount
          });
        }
        return items;
      });

      for (var d = 0; d < domProducts.length; d++) {
        var dp = domProducts[d];
        if (dp.product_id) {
          dp.discount_price = null;
          dp.category_name = '';
          dp.is_sold_out = false;
          dp.product_url = baseUrl + '/products/' + dp.product_id;
          result.data.push(dp);
        }
      }
      console.log('[naver_store] ' + storeSlug + ': DOM enhanced -> ' + result.data.length + ' products');
    }

    if (result.data.length === 0) {
      result.status = 'EMPTY';
      result.error = 'No products found by any method';
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
