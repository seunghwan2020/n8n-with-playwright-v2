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
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1600, height: 1200 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    extraHTTPHeaders: {
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  };
}

function stealthScript() {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', {
    get: () => ['ko-KR', 'ko', 'en-US', 'en']
  });
  window.chrome = { runtime: {} };
}

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function extractCount(text) {
  const t = normalizeText(text);

  let m = t.match(/(\d[\d,]*)\s*명/);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);

  m = t.match(/(\d[\d,]*)\s*건/);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);

  m = t.match(/(\d[\d,]*)/);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);

  return 0;
}

function parseMsg(resultObj) {
  if (!resultObj || !resultObj.ok || !resultObj.data) return null;

  const prefix = normalizeText(resultObj.data.prefix || '');
  const phrase = normalizeText(resultObj.data.mainPhrase || '');
  const fullText = normalizeText(prefix + ' ' + phrase);

  let count = extractCount(phrase);
  if (!count) count = extractCount(fullText);

  return {
    prefix,
    phrase,
    fullText,
    count,
    isToday: /오늘/.test(prefix) || /오늘/.test(fullText),
    isWeekly: /최근\s*1주/.test(prefix) || /최근\s*1주/.test(fullText)
  };
}

async function scrape(params) {
  const storeSlug = params.store_slug || 'dcurvin';
  const storeType = params.store_type || 'brand';

  const result = {
    status: 'OK',
    data: [],
    channel_uid: '',
    brand_name: '',
    error: null,
    method_used: 'v29_weekly_debug_hardened',
    debug: {
      build: 'V29_WEEKLY_DEBUG_HARDENED',
      storeSlug,
      storeType
    }
  };

  let br = null;
  let ctx = null;
  let page = null;

  try {
    br = await getBrowser();
    ctx = await br.newContext(ctxOpts());
    page = await ctx.newPage();
    await page.addInitScript(stealthScript);

    const isSmart = storeType === 'smartstore';
    const baseUrl = isSmart
      ? `https://smartstore.naver.com/${storeSlug}`
      : `https://brand.naver.com/${storeSlug}`;
    const apiBase = isSmart
      ? 'https://smartstore.naver.com'
      : 'https://brand.naver.com';

    const targetUrl = `${baseUrl}/category/ALL?st=POPULAR&dt=LIST&page=1&size=80`;
    console.log('[v29] targetUrl =', targetUrl);

    await page.goto(targetUrl, {
      waitUntil: isSmart ? 'domcontentloaded' : 'networkidle',
      timeout: 45000
    });

    await page.waitForTimeout(3500);

    if (isSmart) {
      try {
        await page.waitForFunction(() => {
          return !!window.__PRELOADED_STATE__ || !!window.__NEXT_DATA__;
        }, { timeout: 12000 });
      } catch (e) {
        console.log('[v29] smartstore state wait timeout');
      }
      await page.waitForTimeout(1500);
    }

    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        if (document.body) {
          window.scrollTo(0, document.body.scrollHeight);
        }
      });
      await page.waitForTimeout(1000);
    }

    async function extractStateInfo(pageRef, baseUrlRef) {
      return await pageRef.evaluate((baseUrlInner) => {
        function asString(v) {
          return v === null || v === undefined ? '' : String(v);
        }

        function pushId(idSet, v) {
          const s = asString(v);
          if (s && /^\d+$/.test(s)) idSet[s] = true;
        }

        function walk(obj, visitor, depth) {
          if (!obj || depth > 10) return;
          if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) walk(obj[i], visitor, depth + 1);
            return;
          }
          if (typeof obj !== 'object') return;
          visitor(obj);
          const keys = Object.keys(obj);
          for (let i = 0; i < keys.length; i++) {
            walk(obj[keys[i]], visitor, depth + 1);
          }
        }

        function parseNextData() {
          try {
            if (window.__NEXT_DATA__) return window.__NEXT_DATA__;
            const el = document.getElementById('__NEXT_DATA__');
            if (el && el.textContent) return JSON.parse(el.textContent);
          } catch (e) {}
          return null;
        }

        const out = {
          channelUid: '',
          channelName: '',
          allIds: [],
          method: 'none'
        };

        const idSet = {};

        try {
          const pre = window.__PRELOADED_STATE__;
          if (pre) {
            out.method = 'preloaded_state';

            if (pre.channel) {
              out.channelUid = pre.channel.channelUid || pre.channel.id || '';
              out.channelName =
                pre.channel.channelName ||
                pre.channel.displayName ||
                pre.channel.name ||
                '';
            }

            if (pre.categoryProducts && Array.isArray(pre.categoryProducts.simpleProducts)) {
              for (let i = 0; i < pre.categoryProducts.simpleProducts.length; i++) {
                const p = pre.categoryProducts.simpleProducts[i];
                if (typeof p === 'object' && p) {
                  pushId(idSet, p.id);
                  pushId(idSet, p.productId);
                  pushId(idSet, p.productNo);
                } else {
                  pushId(idSet, p);
                }
              }
            }

            if (pre.products && typeof pre.products === 'object') {
              const keys = Object.keys(pre.products);
              for (let i = 0; i < keys.length; i++) {
                const p = pre.products[keys[i]];
                if (p && typeof p === 'object') {
                  pushId(idSet, p.id);
                  pushId(idSet, p.productId);
                  pushId(idSet, p.productNo);
                }
              }
            }
          }

          const nextData = parseNextData();
          if (nextData) {
            if (out.method === 'none') out.method = 'next_data';

            walk(nextData, (node) => {
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
                for (let i = 0; i < node.productNos.length; i++) {
                  pushId(idSet, node.productNos[i]);
                }
              }

              if (Array.isArray(node.products)) {
                for (let i = 0; i < node.products.length; i++) {
                  const p = node.products[i];
                  if (p && typeof p === 'object') {
                    pushId(idSet, p.id);
                    pushId(idSet, p.productId);
                    pushId(idSet, p.productNo);
                  }
                }
              }

              if (Array.isArray(node.simpleProducts)) {
                for (let i = 0; i < node.simpleProducts.length; i++) {
                  const p = node.simpleProducts[i];
                  if (p && typeof p === 'object') {
                    pushId(idSet, p.id);
                    pushId(idSet, p.productId);
                    pushId(idSet, p.productNo);
                  }
                }
              }
            }, 0);
          }

          const links = document.querySelectorAll('a[href*="/products/"]');
          for (let i = 0; i < links.length; i++) {
            const href = links[i].getAttribute('href') || '';
            const m = href.match(/products\/(\d+)/);
            if (m) idSet[m[1]] = true;
          }

          if (!out.channelName && document.title) {
            out.channelName = document.title.split(':')[0].trim();
          }

          out.allIds = Object.keys(idSet);
        } catch (e) {
          out.method = 'error:' + String(e.message || e);
        }

        return out;
      }, baseUrlRef);
    }

    async function extractProductsFromState(pageRef, baseUrlRef) {
      return await pageRef.evaluate((baseUrlInner) => {
        function s(v) {
          return v === null || v === undefined ? '' : String(v);
        }

        function parseNextData() {
          try {
            if (window.__NEXT_DATA__) return window.__NEXT_DATA__;
            const el = document.getElementById('__NEXT_DATA__');
            if (el && el.textContent) return JSON.parse(el.textContent);
          } catch (e) {}
          return null;
        }

        function walk(obj, visitor, depth) {
          if (!obj || depth > 10) return;
          if (Array.isArray(obj)) {
            for (let i = 0; i < obj.length; i++) walk(obj[i], visitor, depth + 1);
            return;
          }
          if (typeof obj !== 'object') return;
          visitor(obj);
          const keys = Object.keys(obj);
          for (let i = 0; i < keys.length; i++) {
            walk(obj[keys[i]], visitor, depth + 1);
          }
        }

        function addProduct(out, raw) {
          if (!raw || typeof raw !== 'object') return;

          const pid = s(raw.id || raw.productId || '');
          const pno = s(raw.productNo || '');
          if (!pid && !pno) return;

          const finalId = pid || pno;

          let reviewCount = 0;
          if (raw.reviewAmount && typeof raw.reviewAmount === 'object') {
            reviewCount = raw.reviewAmount.totalReviewCount || 0;
          } else if (raw.reviewCount) {
            reviewCount = raw.reviewCount;
          }

          let discountPrice = null;
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
            product_image_url: s(
              raw.representativeImageUrl || raw.imageUrl || raw.productImageUrl || ''
            ).split('?')[0],
            category_name: raw.category
              ? (raw.category.wholeCategoryName || raw.category.name || '')
              : '',
            is_sold_out: !!(
              raw.productStatusType === 'OUTOFSTOCK' ||
              raw.soldout === true ||
              raw.isSoldOut === true
            ),
            product_url: baseUrlInner + '/products/' + finalId,
            productNo: pno
          };

          if (pno) {
            out.productNoMap[finalId] = pno;
          }
        }

        const out = { products: {}, productNoMap: {}, source: 'none' };

        try {
          const pre = window.__PRELOADED_STATE__;
          if (pre) {
            out.source = 'preloaded_state';

            const sp = (pre.categoryProducts && pre.categoryProducts.simpleProducts) || [];
            for (let i = 0; i < sp.length; i++) {
              if (sp[i] && typeof sp[i] === 'object') addProduct(out, sp[i]);
            }

            if (pre.products && typeof pre.products === 'object') {
              const keys = Object.keys(pre.products);
              for (let i = 0; i < keys.length; i++) {
                addProduct(out, pre.products[keys[i]]);
              }
            }
          }

          const nextData = parseNextData();
          if (nextData) {
            if (out.source === 'none') out.source = 'next_data';

            walk(nextData, (node) => {
              const hasProductShape =
                node &&
                typeof node === 'object' &&
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
                for (let i = 0; i < node.products.length; i++) {
                  if (node.products[i] && typeof node.products[i] === 'object') {
                    addProduct(out, node.products[i]);
                  }
                }
              }

              if (Array.isArray(node.simpleProducts)) {
                for (let i = 0; i < node.simpleProducts.length; i++) {
                  if (node.simpleProducts[i] && typeof node.simpleProducts[i] === 'object') {
                    addProduct(out, node.simpleProducts[i]);
                  }
                }
              }
            }, 0);
          }
        } catch (e) {}

        return out;
      }, baseUrlRef);
    }

    const stateInfo = await extractStateInfo(page, baseUrl);
    result.channel_uid = stateInfo.channelUid || '';
    result.brand_name = stateInfo.channelName || '';
    result.debug.stateMethod = stateInfo.method;
    result.debug.totalIds = stateInfo.allIds.length;

    const productMap = {};
    const productNoMap = {};

    const stateProducts = await extractProductsFromState(page, baseUrl);
    result.debug.stateProductSource = stateProducts.source;

    for (const key of Object.keys(stateProducts.products || {})) {
      const p = stateProducts.products[key];
      productMap[key] = {
        product_id: p.product_id,
        product_name: p.product_name,
        sale_price: p.sale_price,
        discount_price: p.discount_price,
        review_count: p.review_count,
        purchase_count_today: 0,
        purchase_text_today: '',
        purchase_prefix_today: '',
        purchase_count_weekly: 0,
        purchase_text_weekly: '',
        purchase_prefix_weekly: '',
        product_image_url: p.product_image_url,
        category_name: p.category_name,
        is_sold_out: p.is_sold_out,
        product_url: p.product_url
      };
      if (p.productNo) {
        productNoMap[key] = p.productNo;
      }
    }

    for (const key of Object.keys(stateProducts.productNoMap || {})) {
      productNoMap[key] = stateProducts.productNoMap[key];
    }

    if (Object.keys(productMap).length === 0 && stateInfo.channelUid && stateInfo.allIds.length > 0) {
      const apiPaths = isSmart
        ? ['/i/v2/channels/', '/i/v1/channels/', '/n/v2/channels/', '/n/v1/channels/']
        : ['/n/v2/channels/', '/n/v1/channels/'];

      for (const path of apiPaths) {
        let localCount = 0;
        const batchSize = 20;

        for (let i = 0; i < stateInfo.allIds.length; i += batchSize) {
          const batch = stateInfo.allIds.slice(i, i + batchSize);

          const apiResult = await page.evaluate(async (args) => {
            const qs = args.ids.map(id => 'ids[]=' + encodeURIComponent(id)).join('&');
            const url =
              args.apiBase +
              args.path +
              args.uid +
              '/simple-products?' +
              qs +
              '&useChannelProducts=false&excludeAuthBlind=false&excludeDisplayableFilter=false&forceOrder=true';

            try {
              const r = await fetch(url, { credentials: 'include' });
              if (!r.ok) return { _failed: true, _status: r.status, _url: url };
              return await r.json();
            } catch (e) {
              return { _failed: true, _error: String(e), _url: url };
            }
          }, {
            uid: stateInfo.channelUid,
            ids: batch,
            apiBase,
            path
          });

          if (apiResult && apiResult._failed) {
            if (i === 0) {
              console.log('[v29] simple-products failed:', path, apiResult._status || apiResult._error);
            }
            break;
          }

          if (Array.isArray(apiResult)) {
            for (const p of apiResult) {
              const pid = String(p.id || p.productId || p.productNo || '');
              if (!pid) continue;

              let rc = 0;
              if (p.reviewAmount && typeof p.reviewAmount === 'object') {
                rc = p.reviewAmount.totalReviewCount || 0;
              } else if (p.reviewCount) {
                rc = p.reviewCount;
              }

              let dp = null;
              if (p.benefitsView && p.benefitsView.discountedSalePrice) {
                dp = p.benefitsView.discountedSalePrice;
              } else if (p.discountedSalePrice) {
                dp = p.discountedSalePrice;
              }

              const pno = String(p.productNo || '');

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
                product_image_url: String(p.representativeImageUrl || p.imageUrl || '').split('?')[0],
                category_name: p.category ? (p.category.wholeCategoryName || p.category.name || '') : '',
                is_sold_out: !!(
                  p.productStatusType === 'OUTOFSTOCK' ||
                  p.soldout === true ||
                  p.isSoldOut === true
                ),
                product_url: `${baseUrl}/products/${pid}`
              };

              if (pno) productNoMap[pid] = pno;
              localCount++;
            }
          }

          if (i + batchSize < stateInfo.allIds.length) {
            await page.waitForTimeout(200);
          }
        }

        if (localCount > 0) {
          result.debug.apiPathUsed = path;
          result.debug.apiProducts = localCount;
          break;
        }
      }
    }

    result.debug.productCount = Object.keys(productMap).length;
    result.debug.productNoMapped = Object.keys(productNoMap).length;

    const purchaseDebug = {
      total: 0,
      todayCount: 0,
      weeklyCount: 0,
      ignored: 0,
      skippedNoProductNo: 0,
      errors: [],
      samples: []
    };

    const allPids = Object.keys(productMap);
    console.log('[v29] marketing-message total=', allPids.length);

    const msgApiPath = isSmart ? '/i/v1/marketing-message/' : '/n/v1/marketing-message/';
    const msgApiFallback = '/n/v1/marketing-message/';

    async function callMsg(pageRef, id, basis, apiPath) {
      return await pageRef.evaluate(async (args) => {
        const url =
          args.apiBase +
          args.path +
          args.id +
          '?currentPurchaseType=Paid' +
          '&usePurchased=true' +
          '&basisPurchased=1' +
          '&usePurchasedIn2Y=true' +
          '&useRepurchased=true' +
          '&basisRepurchased=' + args.basis;

        try {
          const r = await fetch(url, { credentials: 'include' });
          if (!r.ok) {
            return { ok: false, status: r.status, url };
          }
          const data = await r.json();
          return { ok: true, data, url };
        } catch (e) {
          return { ok: false, error: String(e), url };
        }
      }, {
        id,
        basis,
        apiBase,
        path: apiPath
      });
    }

    async function callMsgWithFallback(pageRef, id, basis) {
      let r = await callMsg(pageRef, id, basis, msgApiPath);
      if (isSmart && (!r || !r.ok)) {
        r = await callMsg(pageRef, id, basis, msgApiFallback);
      }
      return r;
    }

    for (let i = 0; i < allPids.length; i++) {
      const prodId = allPids[i];
      let msgId = productNoMap[prodId];

      purchaseDebug.total++;

      if (isSmart && !msgId) {
        purchaseDebug.skippedNoProductNo++;
        if (purchaseDebug.errors.length < 30) {
          purchaseDebug.errors.push({
            pid: prodId,
            reason: 'productNo missing for smartstore'
          });
        }
        continue;
      }

      if (!msgId) msgId = prodId;

      const r1 = await callMsgWithFallback(page, msgId, 1);
      const p1 = parseMsg(r1);

      if (purchaseDebug.samples.length < 20) {
        purchaseDebug.samples.push({
          pid: prodId,
          msgId,
          basis: 1,
          raw: r1,
          parsed: p1
        });
      }

      if (!p1 || !p1.count) {
        purchaseDebug.ignored++;
        continue;
      }

      if (p1.isWeekly) {
        productMap[prodId].purchase_count_weekly = p1.count;
        productMap[prodId].purchase_text_weekly = p1.phrase;
        productMap[prodId].purchase_prefix_weekly = p1.prefix;
        purchaseDebug.weeklyCount++;
        continue;
      }

      if (p1.isToday) {
        productMap[prodId].purchase_count_today = p1.count;
        productMap[prodId].purchase_text_today = p1.phrase;
        productMap[prodId].purchase_prefix_today = p1.prefix;
        purchaseDebug.todayCount++;

        const candidateSet = new Set();

        candidateSet.add(p1.count + 1);
        candidateSet.add(p1.count + 2);
        candidateSet.add(p1.count);
        for (let b = 1; b <= 10; b++) candidateSet.add(b);

        const weeklyBasisCandidates = Array.from(candidateSet)
          .filter(v => Number.isFinite(v) && v >= 1)
          .sort((a, b) => a - b);

        let weeklySaved = false;
        const weeklyTried = [];

        for (const wb of weeklyBasisCandidates) {
          const r2 = await callMsgWithFallback(page, msgId, wb);
          const p2 = parseMsg(r2);

          weeklyTried.push({
            basis: wb,
            raw: r2,
            parsed: p2
          });

          console.log('[weekly-check]', JSON.stringify({
            pid: prodId,
            msgId,
            basis: wb,
            raw: r2,
            parsed: p2
          }));

          if (p2 && p2.count > 0 && p2.isWeekly) {
            productMap[prodId].purchase_count_weekly = p2.count;
            productMap[prodId].purchase_text_weekly = p2.phrase;
            productMap[prodId].purchase_prefix_weekly = p2.prefix || `basis:${wb}`;
            purchaseDebug.weeklyCount++;
            weeklySaved = true;

            if (purchaseDebug.samples.length < 30) {
              purchaseDebug.samples.push({
                pid: prodId,
                msgId,
                today: p1.count,
                weeklySaved: true,
                weeklyBasis: wb,
                weeklyParsed: p2,
                weeklyRaw: r2,
                weeklyTried
              });
            }
            break;
          }
        }

        if (!weeklySaved && purchaseDebug.samples.length < 30) {
          purchaseDebug.samples.push({
            pid: prodId,
            msgId,
            today: p1.count,
            weeklySaved: false,
            weeklyTried
          });
        }
      } else {
        purchaseDebug.ignored++;
      }

      if (i > 0 && i % 10 === 0) {
        await page.waitForTimeout(250);
      }
    }

    result.debug.purchase = purchaseDebug;

    for (const pid of Object.keys(productMap)) {
      const p = productMap[pid];
      result.data.push({
        product_id: p.product_id,
        product_name: p.product_name,
        sale_price: p.sale_price,
        discount_price: p.discount_price,
        review_count: p.review_count,
        purchase_count_today: p.purchase_count_today,
        purchase_text_today: p.purchase_text_today,
        purchase_prefix_today: p.purchase_prefix_today,
        purchase_count_weekly: p.purchase_count_weekly,
        purchase_text_weekly: p.purchase_text_weekly,
        purchase_prefix_weekly: p.purchase_prefix_weekly,
        product_image_url: p.product_image_url,
        category_name: p.category_name,
        is_sold_out: p.is_sold_out,
        product_url: p.product_url
      });
    }

    result.debug.total = result.data.length;

    if (result.data.length === 0) {
      result.status = 'EMPTY';
      result.error = 'No products found';
    }

    return result;
  } catch (e) {
    result.status = 'ERROR';
    result.error = e.message || String(e);
    return result;
  } finally {
    try {
      if (page) await page.close();
    } catch (e) {}
    try {
      if (ctx) await ctx.close();
    } catch (e) {}
  }
}

async function execute(action, req, res) {
  console.log('[naver_store v29] action=', action);

  try {
    if (action === 'scrape') {
      const out = await scrape(req.body || {});
      return res.json(out);
    }

    return res.status(400).json({
      status: 'ERROR',
      message: `Unknown action: ${action}`
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
