const { chromium } = require('playwright');

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled'
      ]
    });
  }
  return browser;
}

function ctxOpts() {
  return {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    extraHTTPHeaders: {
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  };
}

var stealth = function () {
  Object.defineProperty(navigator, 'webdriver', { get: function () { return false; } });
  Object.defineProperty(navigator, 'plugins', { get: function () { return [1, 2, 3, 4, 5]; } });
  Object.defineProperty(navigator, 'languages', { get: function () { return ['ko-KR', 'ko', 'en-US', 'en']; } });
  window.chrome = { runtime: {} };
};

async function scrape(params) {
  var storeSlug = params.store_slug || 'dcurvin';
  var storeType = params.store_type || 'brand';

  var result = {
    status: 'OK',
    data: [],
    channel_uid: '',
    brand_name: '',
    error: null,
    method_used: 'v28_smartstore_fixed',
    debug: {
      build: 'V28_SMARTSTORE_FIXED',
      storeSlug: storeSlug,
      storeType: storeType
    }
  };

  var br = null;
  var ctx = null;
  var page = null;

  try {
    br = await getBrowser();
    ctx = await br.newContext(ctxOpts());
    page = await ctx.newPage();
    await page.addInitScript(stealth);

    var baseUrl, apiBase;
    if (storeType === 'smartstore') {
      baseUrl = 'https://smartstore.naver.com/' + storeSlug;
      apiBase = 'https://smartstore.naver.com';
    } else {
      baseUrl = 'https://brand.naver.com/' + storeSlug;
      apiBase = 'https://brand.naver.com';
    }

    var targetUrl = baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=1&size=80';
    console.log('[v28] P1 targetUrl = ' + targetUrl);

    await page.goto(targetUrl, {
      waitUntil: storeType === 'smartstore' ? 'domcontentloaded' : 'networkidle',
      timeout: 45000
    });

    await page.waitForTimeout(3500);

    if (storeType === 'smartstore') {
      try {
        await page.waitForFunction(function () {
          return !!window.__PRELOADED_STATE__ || !!window.__NEXT_DATA__;
        }, { timeout: 10000 });
      } catch (e) {
        console.log('[v28] smartstore state wait timeout');
      }
      await page.waitForTimeout(2000);
    }

    for (var si = 0; si < 5; si++) {
      try {
        await page.evaluate(function () {
          if (document.body) window.scrollTo(0, document.body.scrollHeight);
        });
      } catch (e) {
        break;
      }
      await page.waitForTimeout(1200);
    }

    async function extractStateInfo(pageRef, baseUrlRef) {
      return await pageRef.evaluate(function (baseUrlInner) {
        function asString(v) {
          return v === null || v === undefined ? '' : String(v);
        }

        function pushId(idSet, v) {
          var s = asString(v);
          if (s && /^\d+$/.test(s)) idSet[s] = true;
        }

        function walk(obj, visitor, depth) {
          if (!obj || depth > 8) return;
          if (Array.isArray(obj)) {
            for (var i = 0; i < obj.length; i++) walk(obj[i], visitor, depth + 1);
            return;
          }
          if (typeof obj !== 'object') return;
          visitor(obj);
          var keys = Object.keys(obj);
          for (var k = 0; k < keys.length; k++) {
            walk(obj[keys[k]], visitor, depth + 1);
          }
        }

        function parseNextData() {
          try {
            if (window.__NEXT_DATA__) return window.__NEXT_DATA__;
            var el = document.getElementById('__NEXT_DATA__');
            if (el && el.textContent) return JSON.parse(el.textContent);
          } catch (e) {}
          return null;
        }

        var out = {
          channelUid: '',
          channelName: '',
          allIds: [],
          method: 'none'
        };

        var idSet = {};

        try {
          var pre = window.__PRELOADED_STATE__;
          if (pre) {
            out.method = 'preloaded_state';

            if (pre.channel) {
              out.channelUid = pre.channel.channelUid || pre.channel.id || '';
              out.channelName = pre.channel.channelName || pre.channel.displayName || pre.channel.name || '';
            }

            if (pre.categoryProducts && Array.isArray(pre.categoryProducts.simpleProducts)) {
              for (var i = 0; i < pre.categoryProducts.simpleProducts.length; i++) {
                var p = pre.categoryProducts.simpleProducts[i];
                if (typeof p === 'object' && p) {
                  pushId(idSet, p.id);
                  pushId(idSet, p.productId);
                  pushId(idSet, p.productNo);
                } else {
                  pushId(idSet, p);
                }
              }
            }

            if (pre.homeSetting && pre.homeSetting.widgets) {
              var wKeys = Object.keys(pre.homeSetting.widgets);
              for (var wi = 0; wi < wKeys.length; wi++) {
                var w = pre.homeSetting.widgets[wKeys[wi]];
                if (w && Array.isArray(w.productNos)) {
                  for (var pi = 0; pi < w.productNos.length; pi++) {
                    pushId(idSet, w.productNos[pi]);
                  }
                }
              }
            }
          }

          var nextData = parseNextData();
          if (nextData) {
            if (out.method === 'none') out.method = 'next_data';

            walk(nextData, function (node) {
              if (!out.channelUid) {
                out.channelUid =
                  node.channelUid ||
                  node.channelId ||
                  node.channel_id ||
                  '';
              }
              if (!out.channelName) {
                out.channelName =
                  node.channelName ||
                  node.displayName ||
                  node.channelDisplayName ||
                  node.name ||
                  '';
              }

              if (
                node.id !== undefined ||
                node.productId !== undefined ||
                node.productNo !== undefined
              ) {
                pushId(idSet, node.id);
                pushId(idSet, node.productId);
                pushId(idSet, node.productNo);
              }

              if (Array.isArray(node.productNos)) {
                for (var j = 0; j < node.productNos.length; j++) {
                  pushId(idSet, node.productNos[j]);
                }
              }

              if (Array.isArray(node.products)) {
                for (var jj = 0; jj < node.products.length; jj++) {
                  var pp = node.products[jj];
                  if (pp && typeof pp === 'object') {
                    pushId(idSet, pp.id);
                    pushId(idSet, pp.productId);
                    pushId(idSet, pp.productNo);
                  }
                }
              }
            }, 0);
          }

          var links = document.querySelectorAll('a[href*="/products/"]');
          for (var li = 0; li < links.length; li++) {
            var href = links[li].getAttribute('href') || '';
            var m = href.match(/products\/(\d+)/);
            if (m) idSet[m[1]] = true;
          }

          var cards = document.querySelectorAll('[data-product-no], [data-nclick*="product"], [data-shp-contents-id]');
          for (var ci = 0; ci < cards.length; ci++) {
            var pno1 = cards[ci].getAttribute('data-product-no');
            var pno2 = cards[ci].getAttribute('data-shp-contents-id');
            if (pno1) pushId(idSet, pno1);
            if (pno2) pushId(idSet, pno2);
          }

          if (!out.channelName) {
            var title = document.title || '';
            if (title) {
              out.channelName = title.split(':')[0].trim();
            }
          }

          if (!out.channelUid) {
            var scripts = document.querySelectorAll('script');
            for (var si2 = 0; si2 < scripts.length; si2++) {
              var txt = scripts[si2].textContent || '';
              var uidMatch = txt.match(/"channelUid"\s*:\s*"([^"]+)"/);
              if (uidMatch) {
                out.channelUid = uidMatch[1];
                break;
              }
            }
          }

          out.allIds = Object.keys(idSet);
        } catch (e) {
          out.method = 'error:' + e.message;
        }

        return out;
      }, baseUrlRef);
    }

    var stateInfo = await extractStateInfo(page, baseUrl);

    var page2Ids = [];
    try {
      var p2 = await ctx.newPage();
      await p2.addInitScript(stealth);
      await p2.goto(baseUrl + '/category/ALL?st=POPULAR&dt=LIST&page=2&size=80', {
        waitUntil: storeType === 'smartstore' ? 'domcontentloaded' : 'networkidle',
        timeout: 30000
      });
      await p2.waitForTimeout(2500);
      var page2State = await extractStateInfo(p2, baseUrl);
      page2Ids = page2State.allIds || [];
      await p2.close();
    } catch (e) {}

    for (var p2i = 0; p2i < page2Ids.length; p2i++) {
      if (stateInfo.allIds.indexOf(page2Ids[p2i]) === -1) {
        stateInfo.allIds.push(page2Ids[p2i]);
      }
    }

    result.channel_uid = stateInfo.channelUid || '';
    result.brand_name = stateInfo.channelName || '';
    result.debug.stateMethod = stateInfo.method;
    result.debug.totalIds = stateInfo.allIds.length;
    result.debug.page2Ids = page2Ids.length;

    // ===== PHASE 2: 상품 데이터 추출 =====
    var productMap = {};
    var productNoMap = {};

    async function extractProductsFromState(pageRef, baseUrlRef) {
      return await pageRef.evaluate(function (baseUrlInner) {
        function s(v) {
          return v === null || v === undefined ? '' : String(v);
        }

        function parseNextData() {
          try {
            if (window.__NEXT_DATA__) return window.__NEXT_DATA__;
            var el = document.getElementById('__NEXT_DATA__');
            if (el && el.textContent) return JSON.parse(el.textContent);
          } catch (e) {}
          return null;
        }

        function addProduct(out, raw) {
          if (!raw || typeof raw !== 'object') return;

          var pid = s(raw.id || raw.productId || '');
          var pno = s(raw.productNo || '');
          if (!pid && !pno) return;

          var finalId = pid || pno;
          var reviewCount = 0;
          if (raw.reviewAmount && typeof raw.reviewAmount === 'object') {
            reviewCount = raw.reviewAmount.totalReviewCount || 0;
          } else if (raw.reviewCount) {
            reviewCount = raw.reviewCount;
          }

          var discountPrice = null;
          if (raw.benefitsView && raw.benefitsView.discountedSalePrice) {
            discountPrice = raw.benefitsView.discountedSalePrice;
          } else if (raw.discountedSalePrice) {
            discountPrice = raw.discountedSalePrice;
          }

          out.products[finalId] = {
            product_id: finalId,
            product_name: raw.name || raw.dispName || raw.productName || '',
            sale_price: raw.salePrice || raw.salePriceValue || 0,
            discount_price: discountPrice,
            review_count: reviewCount,
            product_image_url: s(raw.representativeImageUrl || raw.imageUrl || raw.productImageUrl || '').split('?')[0],
            category_name: raw.category ? (raw.category.wholeCategoryName || raw.category.name || '') : '',
            is_sold_out: !!(
              raw.productStatusType === 'OUTOFSTOCK' ||
              raw.soldout === true ||
              raw.isSoldOut === true
            ),
            product_url: baseUrlInner + '/products/' + finalId,
            productNo: pno
          };

          if (pno) out.productNoMap[finalId] = pno;
        }

        function walk(obj, visitor, depth) {
          if (!obj || depth > 8) return;
          if (Array.isArray(obj)) {
            for (var i = 0; i < obj.length; i++) walk(obj[i], visitor, depth + 1);
            return;
          }
          if (typeof obj !== 'object') return;
          visitor(obj);
          var keys = Object.keys(obj);
          for (var k = 0; k < keys.length; k++) {
            walk(obj[keys[k]], visitor, depth + 1);
          }
        }

        var out = { products: {}, productNoMap: {}, source: 'none' };

        try {
          var pre = window.__PRELOADED_STATE__;
          if (pre) {
            out.source = 'preloaded_state';

            var sp = (pre.categoryProducts && pre.categoryProducts.simpleProducts) || [];
            for (var i = 0; i < sp.length; i++) {
              if (typeof sp[i] === 'object' && sp[i]) addProduct(out, sp[i]);
            }

            if (pre.products && typeof pre.products === 'object') {
              var pKeys = Object.keys(pre.products);
              for (var pi = 0; pi < pKeys.length; pi++) {
                addProduct(out, pre.products[pKeys[pi]]);
              }
            }
          }

          var nextData = parseNextData();
          if (nextData) {
            if (out.source === 'none') out.source = 'next_data';

            walk(nextData, function (node) {
              var hasProductShape =
                (node && typeof node === 'object') &&
                (
                  node.id !== undefined ||
                  node.productId !== undefined ||
                  node.productNo !== undefined
                ) &&
                (
                  node.name !== undefined ||
                  node.dispName !== undefined ||
                  node.productName !== undefined ||
                  node.salePrice !== undefined
                );

              if (hasProductShape) addProduct(out, node);

              if (Array.isArray(node.products)) {
                for (var j = 0; j < node.products.length; j++) {
                  if (node.products[j] && typeof node.products[j] === 'object') {
                    addProduct(out, node.products[j]);
                  }
                }
              }

              if (Array.isArray(node.simpleProducts)) {
                for (var jj = 0; jj < node.simpleProducts.length; jj++) {
                  if (node.simpleProducts[jj] && typeof node.simpleProducts[jj] === 'object') {
                    addProduct(out, node.simpleProducts[jj]);
                  }
                }
              }
            }, 0);
          }
        } catch (e) {}

        return out;
      }, baseUrlRef);
    }

    var stateProducts = await extractProductsFromState(page, baseUrl);
    result.debug.stateProductSource = stateProducts.source;

    var stateProductKeys = Object.keys(stateProducts.products || {});
    for (var spi = 0; spi < stateProductKeys.length; spi++) {
      var key = stateProductKeys[spi];
      var sp = stateProducts.products[key];
      productMap[key] = {
        product_id: sp.product_id,
        product_name: sp.product_name,
        sale_price: sp.sale_price,
        discount_price: sp.discount_price,
        review_count: sp.review_count,
        purchase_count_today: 0,
        purchase_text_today: '',
        purchase_prefix_today: '',
        purchase_count_weekly: 0,
        purchase_text_weekly: '',
        purchase_prefix_weekly: '',
        product_image_url: sp.product_image_url,
        category_name: sp.category_name,
        is_sold_out: sp.is_sold_out,
        product_url: sp.product_url
      };
      if (sp.productNo) productNoMap[key] = sp.productNo;
    }

    var pnoKeys = Object.keys(stateProducts.productNoMap || {});
    for (var pk = 0; pk < pnoKeys.length; pk++) {
      productNoMap[pnoKeys[pk]] = stateProducts.productNoMap[pnoKeys[pk]];
    }

    // state에서 못 가져온 경우 API fallback
    if (Object.keys(productMap).length === 0 && stateInfo.channelUid && stateInfo.allIds.length > 0) {
      var apiPaths = (storeType === 'smartstore')
        ? ['/i/v2/channels/', '/i/v1/channels/', '/n/v2/channels/', '/n/v1/channels/']
        : ['/n/v2/channels/', '/n/v1/channels/'];

      var batchSize = 20;

      for (var pathIdx = 0; pathIdx < apiPaths.length; pathIdx++) {
        var currentPath = apiPaths[pathIdx];
        var pathWorked = false;
        var localCount = 0;

        for (var bi = 0; bi < stateInfo.allIds.length; bi += batchSize) {
          var batch = stateInfo.allIds.slice(bi, bi + batchSize);

          try {
            var apiResult = await page.evaluate(function (args) {
              var qs = args.ids.map(function (id) {
                return 'ids[]=' + encodeURIComponent(id);
              }).join('&');

              var url =
                args.apiBase +
                args.path +
                args.uid +
                '/simple-products?' +
                qs +
                '&useChannelProducts=false&excludeAuthBlind=false&excludeDisplayableFilter=false&forceOrder=true';

              return fetch(url, { credentials: 'include' })
                .then(function (r) {
                  if (!r.ok) return { _failed: true, _status: r.status, _url: url };
                  return r.json();
                })
                .catch(function (e) {
                  return { _failed: true, _error: String(e), _url: url };
                });
            }, {
              uid: stateInfo.channelUid,
              ids: batch,
              apiBase: apiBase,
              path: currentPath
            });

            if (apiResult && apiResult._failed) {
              if (bi === 0) {
                console.log('[v28] API path failed: ' + currentPath + ' / ' + (apiResult._status || apiResult._error));
              }
              break;
            }

            if (Array.isArray(apiResult)) {
              pathWorked = true;

              for (var ai = 0; ai < apiResult.length; ai++) {
                var p = apiResult[ai];
                var pid = String(p.id || p.productId || p.productNo || '');
                if (!pid) continue;

                var rc = 0;
                if (p.reviewAmount && typeof p.reviewAmount === 'object') {
                  rc = p.reviewAmount.totalReviewCount || 0;
                } else if (p.reviewCount) {
                  rc = p.reviewCount;
                }

                var dp = null;
                if (p.benefitsView && p.benefitsView.discountedSalePrice) {
                  dp = p.benefitsView.discountedSalePrice;
                } else if (p.discountedSalePrice) {
                  dp = p.discountedSalePrice;
                }

                var pno = String(p.productNo || '');

                productMap[pid] = {
                  product_id: pid,
                  product_name: p.name || p.dispName || p.productName || '',
                  sale_price: p.salePrice || 0,
                  discount_price: dp,
                  review_count: rc,
                  purchase_count_today: 0,
                  purchase_text_today: '',
                  purchase_prefix_today: '',
                  purchase_count_weekly: 0,
                  purchase_text_weekly: '',
                  purchase_prefix_weekly: '',
                  product_image_url: (String(p.representativeImageUrl || p.imageUrl || '')).split('?')[0],
                  category_name: p.category ? (p.category.wholeCategoryName || p.category.name || '') : '',
                  is_sold_out: !!(p.productStatusType === 'OUTOFSTOCK' || p.soldout === true || p.isSoldOut === true),
                  product_url: baseUrl + '/products/' + pid
                };

                if (pno) productNoMap[pid] = pno;
                localCount++;
              }
            }
          } catch (e) {}

          if (bi + batchSize < stateInfo.allIds.length) {
            await page.waitForTimeout(200);
          }
        }

        if (pathWorked && localCount > 0) {
          result.debug.apiPathUsed = currentPath;
          console.log('[v28] API path worked: ' + currentPath + ', products=' + localCount);
          break;
        }
      }
    }

    result.debug.apiProducts = Object.keys(productMap).length;
    result.debug.productNoMapped = Object.keys(productNoMap).length;

    // ===== PHASE 3: marketing-message =====
    var purchaseDebug = {
      total: 0,
      todayCount: 0,
      weeklyCount: 0,
      ignored: 0,
      skippedNoProductNo: 0,
      errors: [],
      samples: []
    };

    var allPids = Object.keys(productMap);
    console.log('[v28] P3 marketing-message total=' + allPids.length);

    var msgApiPath = (storeType === 'smartstore') ? '/i/v1/marketing-message/' : '/n/v1/marketing-message/';
    var msgApiFallback = '/n/v1/marketing-message/';

    async function callMsg(pageRef, id, basis, apiPath) {
      return await pageRef.evaluate(function (args) {
        var url =
          args.apiBase +
          args.path +
          args.id +
          '?currentPurchaseType=Paid' +
          '&usePurchased=true' +
          '&basisPurchased=1' +
          '&usePurchasedIn2Y=true' +
          '&useRepurchased=true' +
          '&basisRepurchased=' + args.basis;

        return fetch(url, { credentials: 'include' })
          .then(function (r) {
            if (!r.ok) return { ok: false, status: r.status, url: url };
            return r.json().then(function (data) {
              return { ok: true, data: data, url: url };
            });
          })
          .catch(function (e) {
            return { ok: false, error: String(e), url: url };
          });
      }, {
        id: id,
        basis: basis,
        apiBase: apiBase,
        path: apiPath
      });
    }

    async function callMsgWithFallback(pageRef, id, basis) {
      var r = await callMsg(pageRef, id, basis, msgApiPath);
      if (storeType === 'smartstore' && (!r || !r.ok)) {
        r = await callMsg(pageRef, id, basis, msgApiFallback);
      }
      return r;
    }

    function normalizeText(s) {
      return String(s || '').replace(/\s+/g, ' ').trim();
    }

    function extractCount(text) {
      var t = normalizeText(text);
      var m = t.match(/(\d[\d,]*)\s*명/);
      if (m) return parseInt(m[1].replace(/,/g, ''), 10);

      m = t.match(/(\d[\d,]*)\s*건/);
      if (m) return parseInt(m[1].replace(/,/g, ''), 10);

      return 0;
    }

    function parseMsg(resultObj) {
      if (!resultObj || !resultObj.ok || !resultObj.data) return null;

      var prefix = normalizeText(resultObj.data.prefix || '');
      var phrase = normalizeText(resultObj.data.mainPhrase || '');
      var fullText = normalizeText(prefix + ' ' + phrase);

      var count = extractCount(phrase);
      if (!count) count = extractCount(fullText);

      return {
        prefix: prefix,
        phrase: phrase,
        fullText: fullText,
        count: count,
        isToday: /오늘/.test(prefix) || /오늘/.test(fullText),
        isWeekly: /최근\s*1주/.test(prefix) || /최근\s*1주/.test(fullText)
      };
    }

    for (var mi = 0; mi < allPids.length; mi++) {
      var prodId = allPids[mi];
      var msgId = productNoMap[prodId];

      purchaseDebug.total++;

      // 스마트스토어는 productNo 없으면 억지로 product_id 쓰지 않음
      if (storeType === 'smartstore' && !msgId) {
        purchaseDebug.skippedNoProductNo++;
        if (purchaseDebug.errors.length < 20) {
          purchaseDebug.errors.push({
            pid: prodId,
            reason: 'productNo missing for smartstore marketing-message'
          });
        }
        continue;
      }

      // 브랜드스토어는 productNo 없으면 id fallback 허용
      if (!msgId) msgId = prodId;

      var r1 = await callMsgWithFallback(page, msgId, 1);
      var p1 = parseMsg(r1);

      if (!p1 || !p1.count) {
        purchaseDebug.ignored++;
        if (purchaseDebug.samples.length < 10) {
          purchaseDebug.samples.push({
            pid: prodId,
            msgId: msgId,
            step1: r1
          });
        }
        if (mi > 0 && mi % 10 === 0) await page.waitForTimeout(250);
        continue;
      }

      // basis=1 에서 바로 최근 1주
      if (p1.isWeekly) {
        productMap[prodId].purchase_count_weekly = p1.count;
        productMap[prodId].purchase_text_weekly = p1.phrase;
        productMap[prodId].purchase_prefix_weekly = p1.prefix;
        purchaseDebug.weeklyCount++;

        if (purchaseDebug.samples.length < 10) {
          purchaseDebug.samples.push({
            pid: prodId,
            msgId: msgId,
            step1: p1,
            today: 0,
            weekly: p1.count
          });
        }
        continue;
      }

      // basis=1 이 오늘
      if (p1.isToday) {
        productMap[prodId].purchase_count_today = p1.count;
        productMap[prodId].purchase_text_today = p1.phrase;
        productMap[prodId].purchase_prefix_today = p1.prefix;
        purchaseDebug.todayCount++;

        var weeklyBasisCandidates = [p1.count + 1, p1.count + 2, p1.count];
        var weeklySaved = false;

        for (var bi2 = 0; bi2 < weeklyBasisCandidates.length; bi2++) {
          var wb = weeklyBasisCandidates[bi2];
          if (wb < 1) continue;

          var r2 = await callMsgWithFallback(page, msgId, wb);
          var p2 = parseMsg(r2);

          if (p2 && p2.count > 0 && p2.isWeekly) {
            productMap[prodId].purchase_count_weekly = p2.count;
            productMap[prodId].purchase_text_weekly = p2.phrase;
            productMap[prodId].purchase_prefix_weekly = p2.prefix || ('basis:' + wb);
            purchaseDebug.weeklyCount++;
            weeklySaved = true;
            break;
          }
        }

        if (purchaseDebug.samples.length < 10) {
          purchaseDebug.samples.push({
            pid: prodId,
            msgId: msgId,
            step1: p1,
            today: productMap[prodId].purchase_count_today,
            weekly: productMap[prodId].purchase_count_weekly,
            weeklySaved: weeklySaved
          });
        }
      } else {
        purchaseDebug.ignored++;
        if (purchaseDebug.samples.length < 10) {
          purchaseDebug.samples.push({
            pid: prodId,
            msgId: msgId,
            step1: p1,
            reason: 'unknown prefix'
          });
        }
      }

      if (mi > 0 && mi % 10 === 0) {
        await page.waitForTimeout(250);
      }
    }

    result.debug.purchase = purchaseDebug;

    // ===== PHASE 4: 결과 정리 =====
    var pids = Object.keys(productMap);
    for (var fi = 0; fi < pids.length; fi++) {
      var prod = productMap[pids[fi]];
      result.data.push({
        product_id: prod.product_id,
        product_name: prod.product_name,
        sale_price: prod.sale_price,
        discount_price: prod.discount_price,
        review_count: prod.review_count,
        purchase_count_today: prod.purchase_count_today,
        purchase_text_today: prod.purchase_text_today,
        purchase_prefix_today: prod.purchase_prefix_today,
        purchase_count_weekly: prod.purchase_count_weekly,
        purchase_text_weekly: prod.purchase_text_weekly,
        purchase_prefix_weekly: prod.purchase_prefix_weekly,
        product_image_url: prod.product_image_url,
        category_name: prod.category_name,
        is_sold_out: prod.is_sold_out,
        product_url: prod.product_url
      });
    }

    result.debug.total = result.data.length;

    if (result.data.length === 0) {
      result.status = 'EMPTY';
      result.error = 'No products found';
    }
  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message || String(e);
  } finally {
    try { if (page) await page.close(); } catch (x) {}
    try { if (ctx) await ctx.close(); } catch (x) {}
  }

  return result;
}

async function spy(params) {
  var url = params.url || 'https://brand.naver.com/dcurvin/products/12569074482';
  var br = null;
  var ctx = null;
  var page = null;
  var captured = [];

  try {
    br = await getBrowser();
    ctx = await br.newContext(ctxOpts());
    page = await ctx.newPage();

    page.on('response', async function (response) {
      try {
        var reqUrl = response.url();
        var ct = response.headers()['content-type'] || '';
        if (ct.indexOf('json') > -1 && response.status() === 200) {
          var body = await response.text();
          captured.push({
            url: reqUrl.length > 240 ? reqUrl.slice(0, 240) + '...' : reqUrl,
            status: response.status(),
            size: body.length,
            snippet: body.slice(0, 500)
          });
        }
      } catch (e) {}
    });

    await page.addInitScript(stealth);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);

    return {
      status: 'OK',
      url: url,
      captured_count: captured.length,
      captured: captured
    };
  } catch (e) {
    return {
      status: 'ERROR',
      error: e.message,
      captured: captured
    };
  } finally {
    try { if (page) await page.close(); } catch (x) {}
    try { if (ctx) await ctx.close(); } catch (x) {}
  }
}

async function execute(action, req, res) {
  console.log('[naver_store v28] action=' + action);

  try {
    if (action === 'scrape') {
      return res.json(await scrape(req.body));
    }

    if (action === 'spy') {
      return res.json(await spy(req.body));
    }

    return res.status(400).json({
      status: 'ERROR',
      message: 'Unknown action: ' + action
    });
  } catch (e) {
    if (!res.headersSent) {
      return res.status(500).json({
        status: 'ERROR',
        error: e.message || String(e)
      });
    }
  }
}

module.exports = { execute };
