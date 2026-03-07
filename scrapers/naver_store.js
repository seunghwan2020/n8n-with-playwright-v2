{
  "name": "[IN] NaverStore 경쟁사+자사 상품 수집 (Batch)",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [
            {
              "field": "hours",
              "hoursInterval": 6
            }
          ]
        }
      },
      "id": "5eb28857-f791-4400-a8f8-e66c7e39e5df",
      "name": "⏰ 6시간마다",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [
        36928,
        13728
      ]
    },
    {
      "parameters": {},
      "id": "b717d39e-1199-4785-91d8-4e5a510b5a0c",
      "name": "🔧 수동실행",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [
        36928,
        13888
      ]
    },
    {
      "parameters": {
        "jsCode": "// ========================================\n// 🏪 수집 대상 스토어 URL 목록\n// ✅ URL만 넣으면 slug, type 자동 추출!\n// ✅ 추가: URL 넣기 / 제거: 줄 삭제 또는 주석처리\n// ========================================\nconst urls = [\n  // === 자사 ===\n  'https://brand.naver.com/dcurvin',              // 디커빈\n\n  // === 경쟁사 ===\n  'https://brand.naver.com/leadvault',             // 리드볼트\n  'https://brand.naver.com/cordix',                // 코딕스\n  'https://brand.naver.com/rawrow',                // 로우로우\n  'https://brand.naver.com/ipraves',               // 아이프라브스\n  'https://brand.naver.com/btmall',                // 비트몰\n  'https://brand.naver.com/timeless',              // 타임리스\n  'https://brand.naver.com/starksein',             // 스탁사인\n  'https://brand.naver.com/president_official',     // 프레지던트\n  'https://smartstore.naver.com/pluginearth',      // 플러그인어스\n  'https://smartstore.naver.com/w-travelshop',     // W트래블샵\n  'https://smartstore.naver.com/_campamento',      // 캄파멘토\n  'https://brand.naver.com/tramon',                // 트라몬\n];\n\n// URL에서 자동으로 slug, type 추출\nvar stores = [];\nfor (var i = 0; i < urls.length; i++) {\n  var url = urls[i].trim();\n  if (!url || url.indexOf('//') === -1) continue;\n\n  var isBrand = url.indexOf('brand.naver.com') > -1;\n  var isSmartstore = url.indexOf('smartstore.naver.com') > -1;\n  if (!isBrand && !isSmartstore) continue;\n\n  var parts = url.replace(/\\/+$/, '').split('/');\n  var slug = parts[parts.length - 1];\n  var type = isBrand ? 'brand' : 'smartstore';\n  var isOwn = slug === 'dcurvin';\n\n  stores.push({ slug: slug, type: type, is_own: isOwn, url: url });\n}\n\nreturn stores.map(function(s) { return { json: s }; });"
      },
      "id": "255ccb62-3292-452a-bf88-08acbb118f78",
      "name": "📋 스토어 URL 목록",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        37216,
        13808
      ]
    },
    {
      "parameters": {
        "options": {}
      },
      "id": "280ddf55-7456-4df9-af5c-4c042337bda0",
      "name": "🔄 1개씩 순회",
      "type": "n8n-nodes-base.splitInBatches",
      "typeVersion": 3,
      "position": [
        37488,
        13808
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://n8n-with-playwright-v2-production.up.railway.app/execute",
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\"site\":\"naver_store\",\"action\":\"scrape\",\"store_slug\":\"{{ $json.slug }}\",\"store_type\":\"{{ $json.type }}\"}",
        "options": {
          "timeout": 180000
        }
      },
      "id": "1159b1ae-d506-451f-a5a1-cd5d573ffc1a",
      "name": "🌐 Playwright 수집",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        37776,
        13808
      ]
    },
    {
      "parameters": {
        "conditions": {
          "options": {
            "caseSensitive": true,
            "leftValue": "",
            "typeValidation": "strict",
            "version": 2
          },
          "conditions": [
            {
              "id": "a3147f69-899b-4bab-8ee4-41293f8e54d4",
              "leftValue": "={{ $json.status }}",
              "rightValue": "OK",
              "operator": {
                "type": "string",
                "operation": "equals"
              }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "id": "dd6e5c06-7cdf-4ba2-912a-cac9b183c425",
      "name": "❓ 성공여부",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2.2,
      "position": [
        38048,
        13808
      ]
    },
    {
      "parameters": {
        "jsCode": "// v23: prefix 기반 today/weekly 분류 저장\nvar response = $input.first().json;\nvar data = response.data || [];\n\nif (data.length === 0) {\n  return [{ json: { query: 'SELECT 1', count: 0, store: 'empty' } }];\n}\n\n// product_url에서 slug, type 자동 추출\nvar firstUrl = (data[0].product_url || '');\nvar slug = 'unknown';\nvar storeType = 'brand';\n\nif (firstUrl.indexOf('brand.naver.com/') > -1) {\n  slug = (firstUrl.split('brand.naver.com/')[1] || '').split('/')[0];\n  storeType = 'brand';\n} else if (firstUrl.indexOf('smartstore.naver.com/') > -1) {\n  slug = (firstUrl.split('smartstore.naver.com/')[1] || '').split('/')[0];\n  storeType = 'smartstore';\n}\nvar isOwn = (slug === 'dcurvin');\n\n// KST 날짜\nvar now = new Date();\nvar kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);\nvar collectedDate = kst.toISOString().split('T')[0];\n\nfunction esc(val) {\n  if (val === null || val === undefined) return 'NULL';\n  var s = String(val).replace(/'/g, \"''\");\n  return \"'\" + s + \"'\";\n}\n\nvar values = [];\nfor (var i = 0; i < data.length; i++) {\n  var p = data[i];\n  var row = '(' +\n    esc(slug) + ',' +\n    esc(storeType) + ',' +\n    (isOwn ? 'TRUE' : 'FALSE') + ',' +\n    esc(collectedDate) + ',' +\n    esc(String(p.product_id)) + ',' +\n    esc(p.product_name || '') + ',' +\n    (p.sale_price || 0) + ',' +\n    (p.discount_price ? p.discount_price : 'NULL') + ',' +\n    (p.review_count || 0) + ',' +\n    (p.purchase_count_today || 0) + ',' +\n    esc(p.purchase_text_today || '') + ',' +\n    esc(p.purchase_prefix_today || '') + ',' +\n    (p.purchase_count_weekly || 0) + ',' +\n    esc(p.purchase_text_weekly || '') + ',' +\n    esc(p.purchase_prefix_weekly || '') + ',' +\n    (p.is_sold_out ? 'TRUE' : 'FALSE') + ',' +\n    esc(p.product_url || '') +\n    ')';\n  values.push(row);\n}\n\nvar sql = 'INSERT INTO dcurvin.naver_store_daily_products ' +\n  '(store_slug,store_type,is_own_store,collected_date,' +\n  'product_id,product_name,sale_price,discount_price,review_count,' +\n  'purchase_count_today,purchase_text_today,purchase_prefix_today,' +\n  'purchase_count_weekly,purchase_text_weekly,purchase_prefix_weekly,' +\n  'is_sold_out,product_url) VALUES ' +\n  values.join(',') +\n  ' ON CONFLICT (store_slug,product_id,collected_date) DO UPDATE SET ' +\n  'product_name=EXCLUDED.product_name,' +\n  'sale_price=EXCLUDED.sale_price,' +\n  'discount_price=EXCLUDED.discount_price,' +\n  'review_count=EXCLUDED.review_count,' +\n  'purchase_count_today=EXCLUDED.purchase_count_today,' +\n  'purchase_text_today=EXCLUDED.purchase_text_today,' +\n  'purchase_prefix_today=EXCLUDED.purchase_prefix_today,' +\n  'purchase_count_weekly=EXCLUDED.purchase_count_weekly,' +\n  'purchase_text_weekly=EXCLUDED.purchase_text_weekly,' +\n  'purchase_prefix_weekly=EXCLUDED.purchase_prefix_weekly,' +\n  'is_sold_out=EXCLUDED.is_sold_out,' +\n  'updated_at=NOW()';\n\nreturn [{ json: { query: sql, count: data.length, store: slug, type: storeType, date: collectedDate } }];"
      },
      "id": "34584ed0-a5f4-4c5b-a437-a5e404ac5ff6",
      "name": "📊 UPSERT SQL",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        38336,
        13728
      ]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "{{ $json.query }}",
        "options": {}
      },
      "id": "00f8a34f-0388-4aba-b640-758f244cb29c",
      "name": "💾 DB Upsert",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 2.5,
      "position": [
        38608,
        13728
      ],
      "credentials": {
        "postgres": {
          "id": "CSz0crcCB8UfcEtK",
          "name": "Postgres account"
        }
      }
    },
    {
      "parameters": {
        "jsCode": "// 수집 실패 시 로그\nvar r = $input.first().json;\nvar errMsg = r.error || r.status || 'Unknown';\nconsole.log('[FAIL] ' + errMsg);\nreturn [{ json: { error: errMsg, status: r.status || 'FAIL' } }];"
      },
      "id": "cdee3564-8c5f-4b0c-be2d-964f9b12eb35",
      "name": "⚠️ 에러 로그",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        38336,
        13920
      ]
    },
    {
      "parameters": {},
      "id": "933127c1-5cf4-43cc-8192-8f8e0f03e0cc",
      "name": "⏳ 5초 대기",
      "type": "n8n-nodes-base.wait",
      "typeVersion": 1.1,
      "position": [
        38896,
        13808
      ],
      "webhookId": "0189505a-f580-40bb-9009-d9f9fdc959c8"
    },
    {
      "parameters": {},
      "id": "20c95d45-45d7-4688-8edc-57860c1a525c",
      "name": "✅ 완료",
      "type": "n8n-nodes-base.noOp",
      "typeVersion": 1,
      "position": [
        37776,
        13616
      ]
    }
  ],
  "pinData": {},
  "connections": {
    "⏰ 6시간마다": {
      "main": [
        [
          {
            "node": "📋 스토어 URL 목록",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "🔧 수동실행": {
      "main": [
        [
          {
            "node": "📋 스토어 URL 목록",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "📋 스토어 URL 목록": {
      "main": [
        [
          {
            "node": "🔄 1개씩 순회",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "🔄 1개씩 순회": {
      "main": [
        [
          {
            "node": "✅ 완료",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "🌐 Playwright 수집",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "🌐 Playwright 수집": {
      "main": [
        [
          {
            "node": "❓ 성공여부",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "❓ 성공여부": {
      "main": [
        [
          {
            "node": "📊 UPSERT SQL",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "⚠️ 에러 로그",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "📊 UPSERT SQL": {
      "main": [
        [
          {
            "node": "💾 DB Upsert",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "💾 DB Upsert": {
      "main": [
        [
          {
            "node": "⏳ 5초 대기",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "⚠️ 에러 로그": {
      "main": [
        [
          {
            "node": "⏳ 5초 대기",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "⏳ 5초 대기": {
      "main": [
        [
          {
            "node": "🔄 1개씩 순회",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "active": true,
  "settings": {
    "executionOrder": "v1",
    "binaryMode": "separate",
    "availableInMCP": false
  },
  "versionId": "c7fab9a1-fd3f-451c-a6fa-172a8947d78c",
  "meta": {
    "templateCredsSetupCompleted": true,
    "instanceId": "8c062a229773360b4071bd938783a6d51ae2f75bf33f02dce4719649e1783735"
  },
  "id": "79ifh0X7uCzY1VJk",
  "tags": [
    {
      "updatedAt": "2026-03-05T16:00:15.749Z",
      "createdAt": "2026-03-05T16:00:15.749Z",
      "id": "NNU5uiE8sDqNnBAd",
      "name": "P5-Marketing"
    },
    {
      "updatedAt": "2026-03-05T16:00:15.754Z",
      "createdAt": "2026-03-05T16:00:15.754Z",
      "id": "WpmQA8lEKR78hzdM",
      "name": "competitor"
    },
    {
      "updatedAt": "2026-03-05T16:10:56.343Z",
      "createdAt": "2026-03-05T16:10:56.343Z",
      "id": "YzMzvuvuMXzeVZjB",
      "name": "crawling"
    }
  ]
}
