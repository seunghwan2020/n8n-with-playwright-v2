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

// ============ SCRAPE ============
async function scrape(params) {
  var url = params.url;
  var storeSlug = params.store_slug;
  var storeType = params.store_type || 'brand';
  var result = { status: 'OK', data: [], channel_uid: '', error: null, method_used: '' };

  var br = await getBrowser();
  var ctx = await br.newContext(ctxOpts());
  var page = await ctx.newPage();

  try {
    await page.addInitScript(function() {
      Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } });
    });

    console.log('[naver_store] ' + storeSlug + ' -> ' + url);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    var baseUrl = storeType === 'brand'
      ? 'https://brand.naver.com/' + storeSlug
      : 'https://smartstore.naver.com/' + storeSlug;

    // ========== Step 1: DOM에서 상품 ID + 기본 정보 수집 ==========
    await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight / 2); });
    await page.waitForTimeout(1500);
    await page.evaluate(function() { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(1500);

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

    console.log('[naver_store] ' + storeSlug + ': DOM extracted ' + domProducts.length + ' products');

    // ========== Step 2: 브라우저 내에서 상품 상세 API 호출 (purchase_count) ==========
    if (domProducts.length > 0) {
      result.method_used = 'dom+api_detail';

      var productIds = domProducts.map(function(p) { return p.product_id; });

      var apiResults = await page.evaluate(async function(args) {
        var pids = args.pids;
        var slug = args.slug;
        var sType = args.sType;
        var results = {};

        for (var i = 0; i < pids.length; i++) {
          var pid = pids[i];
          try {
            // 네이버 내부 상품 상세 API 호출
            var apiUrl;
            if (sType === 'brand') {
              apiUrl = 'https://brand.naver.com/n/v2/shoppingstores/' + slug + '/products/' + pid;
            } else {
              apiUrl = 'https://smartstore.naver.com/i/v1/stores/' + slug + '/products/' + pid;
            }

            var res = await fetch(apiUrl, { credentials: 'include' });
            if (res.ok) {
              var data = await res.json();
              results[pid] = {
                purchase_count: data.purchaseCount || data.totalPurchaseCount || data.cumulationSaleCount || 0,
                discount_price: data.discountedSalePrice || data.benefitsView && data.benefitsView.discountedSalePrice || null,
                category_name: data.wholeCategoryName || data.categoryName || '',
                channel_uid: data.channelUid || ''
              };
            } else {
              // 다른 API 경로 시도
              var altUrl;
              if (sType === 'brand') {
                altUrl = 'https://brand.naver.com/n/v2/channels/' + slug + '/products/' + pid + '/detail';
              } else {
                altUrl = 'https://smartstore.naver.com/i/v1/contents/products/' + pid;
              }
              var res2 = await fetch(altUrl, { credentials: 'include' });
              if (res2.ok) {
                var data2 = await res2.json();
                results[pid] = {
                  purchase_count: data2.purchaseCount || data2.totalPurchaseCount || data2.cumulationSaleCount || 0,
                  discount_price: data2.discountedSalePrice || null,
                  category_name: data2.wholeCategoryName || data2.categoryName || '',
                  channel_uid: data2.channelUid || ''
                };
              } else {
                results[pid] = { purchase_count: 0, discount_price: null, category_name: '', api_status: res.status + '/' + res2.status };
              }
            }
          } catch (e) {
            results[pid] = { purchase_count: 0, discount_price: null, category_name: '', error: e.message };
          }

          // Rate limit 방지: 200ms 딜레이
          if (i < pids.length - 1) {
            await new Promise(function(r) { setTimeout(r, 200); });
          }
        }
        return results;
      }, { pids: productIds, slug: storeSlug, sType: storeType });

      // channel_uid 추출
      for (var pid in apiResults) {
        if (apiResults[pid].channel_uid) {
          result.channel_uid = apiResults[pid].channel_uid;
          break;
        }
      }

      // DOM 데이터 + API 데이터 병합
      for (var d = 0; d < domProducts.length; d++) {
        var dp = domProducts[d];
        var api = apiResults[dp.product_id] || {};
        result.data.push({
          product_id: dp.product_id,
          product_name: dp.product_name,
          sale_price: dp.sale_price || 0,
          discount_price: api.discount_price || null,
          review_count: dp.review_count || 0,
          purchase_count: api.purchase_count || 0,
          product_image_url: dp.product_image_url || '',
          category_name: api.category_name || '',
          is_sold_out: false,
          product_url: baseUrl + '/products/' + dp.product_id
        });
      }

      console.log('[naver_store] ' + storeSlug + ': API detail enriched ' + result.data.length + ' products');
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

// ============ DEBUG ============
async function debug(params) {
  var url = params.url || 'https://brand.naver.com/dcurvin';
  var br = await getBrowser();
  var ctx = await br.newContext(ctxOpts());
  var page = await ctx.newPage();
  var result = { status: 'OK', url: url };
  try {
    await page.addInitScript(function() { Object.defineProperty(navigator, 'webdriver', { get: function() { return false; } }); });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
    result.final_url = page.url();
    result.page_title = await page.title();
    result.product_links = await page.evaluate(function() { return document.querySelectorAll('a[href*="/products/"]').length; });

    // 첫 상품으로 API 테스트
    var testResult = await page.evaluate(async function(args) {
      var slug = args.slug;
      var sType = args.sType;
      var testPid = args.testPid;
      var out = { apis_tried: [] };
      var urls = [];
      if (sType === 'brand') {
        urls.push('https://brand.naver.com/n/v2/shoppingstores/' + slug + '/products/' + testPid);
        urls.push('https://brand.naver.com/n/v2/channels/' + slug + '/products/' + testPid + '/detail');
      } else {
        urls.push('https://smartstore.naver.com/i/v1/stores/' + slug + '/products/' + testPid);
        urls.push('https://smartstore.naver.com/i/v1/contents/products/' + testPid);
      }
      for (var i = 0; i < urls.length; i++) {
        try {
          var res = await fetch(urls[i], { credentials: 'include' });
          var text = await res.text();
          var parsed = null;
          try { parsed = JSON.parse(text); } catch(e) {}
          out.apis_tried.push({
            url: urls[i],
            status: res.status,
            has_json: !!parsed,
            keys: parsed ? Object.keys(parsed).slice(0, 20) : [],
            purchase_fields: parsed ? {
              purchaseCount: parsed.purchaseCount,
              totalPurchaseCount: parsed.totalPurchaseCount,
              cumulationSaleCount: parsed.cumulationSaleCount
            } : null,
            snippet: text.slice(0, 300)
          });
        } catch(e) {
          out.apis_tried.push({ url: urls[i], error: e.message });
        }
      }
      return out;
    }, { slug: params.store_slug || 'dcurvin', sType: params.store_type || 'brand', testPid: params.test_pid || '12569074482' });

    result.api_test = testResult;
  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message;
  } finally {
    await page.close();
    await ctx.close();
  }
  return result;
}

// ============ 진입점 ============
async function execute(action, req, res) {
  console.log('[naver_store] action=' + action + ' store=' + (req.body.store_slug || ''));
  if (action === 'scrape') return res.json(await scrape(req.body));
  if (action === 'debug') return res.json(await debug(req.body));
  return res.status(400).json({ status: 'ERROR', message: 'Unknown action: ' + action });
}

module.exports = { execute };
