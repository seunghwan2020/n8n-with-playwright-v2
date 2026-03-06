{
  "name": "[IN] NaverComm : 주문 상세 (Bulk)",
  "nodes": [
    {
      "parameters": {},
      "id": "cc334dd5-5730-4431-8e3d-11461708ab22",
      "name": "Manual_트리거",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [
        0,
        200
      ]
    },
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "bulk-orders",
        "options": {}
      },
      "id": "a2f8388f-2810-4b2b-8a66-66e151c3dbf2",
      "name": "Webhook_벌크주문",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [
        0,
        400
      ]
    },
    {
      "parameters": {
        "jsCode": "// 날짜 설정 — Manual: DEFAULT값 / Webhook: body에서 추출\nvar DEFAULT_FROM = '2024-01-01';\nvar DEFAULT_TO   = '2025-01-01';\n\nvar from_d, to_d;\ntry {\n  var body = $input.first().json.body;\n  from_d = body && body.from;\n  to_d = body && body.to;\n} catch(e) {}\n\nif (!from_d) from_d = DEFAULT_FROM;\nif (!to_d) to_d = DEFAULT_TO;\n\nvar fromDate = new Date(from_d + 'T00:00:00+09:00');\nvar toDate = new Date(to_d + 'T00:00:00+09:00');\nif (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {\n  throw new Error('날짜 형식 오류: from=' + from_d + ', to=' + to_d);\n}\nif (fromDate >= toDate) {\n  throw new Error('from(' + from_d + ')이 to(' + to_d + ')보다 같거나 큼');\n}\nvar diffDays = Math.ceil((toDate - fromDate) / (24*60*60*1000));\n\nreturn [{\n  json: {\n    from: from_d, to: to_d,\n    fromISO: from_d + 'T00:00:00.000+09:00',\n    toISO: to_d + 'T00:00:00.000+09:00',\n    totalDays: diffDays,\n    description: from_d + ' ~ ' + to_d + ' (' + diffDays + '일)'\n  }\n}];"
      },
      "id": "eee61013-d0c8-4e17-aba1-0fbd42b10b73",
      "name": "날짜_설정",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        280,
        300
      ]
    },
    {
      "parameters": {
        "jsCode": "// 24h 슬라이스 생성 (네이버 API 최대 조회 범위: 24시간)\nvar info = $input.first().json;\nvar from = new Date(info.fromISO);\nvar to = new Date(info.toISO);\n\nfunction toKST(d) {\n  var kst = new Date(d.getTime() + 9 * 3600000);\n  return kst.toISOString().slice(0, 23) + '+09:00';\n}\n\nvar slices = [];\nvar cur = new Date(from);\nvar idx = 0;\nwhile (cur < to) {\n  var next = new Date(cur.getTime() + 24 * 60 * 60 * 1000);\n  var end = next > to ? to : next;\n  slices.push({\n    json: {\n      sliceIdx: idx,\n      sliceFrom: toKST(cur),\n      sliceTo: toKST(end),\n      sliceLabel: toKST(cur).slice(0, 10),\n      totalSlices: 0\n    }\n  });\n  cur = next;\n  idx++;\n}\n\n// totalSlices 채우기\nfor (var i = 0; i < slices.length; i++) {\n  slices[i].json.totalSlices = slices.length;\n}\n\nreturn slices;"
      },
      "id": "24b48f68-3b9a-49b8-976f-9406004775fc",
      "name": "24h_슬라이스",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        560,
        300
      ]
    },
    {
      "parameters": {
        "options": {}
      },
      "id": "09fd781d-7336-4ed1-8aae-eee84026b92f",
      "name": "슬라이스_루프",
      "type": "n8n-nodes-base.splitInBatches",
      "typeVersion": 3,
      "position": [
        840,
        300
      ]
    },
    {
      "parameters": {
        "workflowId": {
          "__rl": true,
          "value": "kgc88eVshMvxgTvn",
          "mode": "list",
          "cachedResultUrl": "/workflow/kgc88eVshMvxgTvn",
          "cachedResultName": "02_P1_AUTH_NaverToken"
        },
        "workflowInputs": {
          "mappingMode": "defineBelow",
          "value": {},
          "matchingColumns": [],
          "schema": [],
          "attemptToConvertTypes": false,
          "convertFieldsToString": true
        },
        "options": {}
      },
      "id": "70469704-0cb5-4cb7-ba3e-d01c3a7c85cd",
      "name": "인증_토큰_획득",
      "type": "n8n-nodes-base.executeWorkflow",
      "typeVersion": 1.2,
      "position": [
        1120,
        300
      ]
    },
    {
      "parameters": {
        "jsCode": "// 인증 토큰 + 현재 슬라이스 정보 병합\nvar tokenData = $input.first().json;\nvar sliceData = $('슬라이스_루프').all();\nvar slice = sliceData[sliceData.length - 1].json;\n\nreturn [{\n  json: {\n    token: tokenData.access_token,\n    sliceIdx: slice.sliceIdx,\n    sliceFrom: slice.sliceFrom,\n    sliceTo: slice.sliceTo,\n    sliceLabel: slice.sliceLabel,\n    totalSlices: slice.totalSlices\n  }\n}];"
      },
      "id": "15c2c88a-cabb-43d6-b3f9-6def13ffb156",
      "name": "토큰+슬라이스_병합",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        1400,
        300
      ]
    },
    {
      "parameters": {
        "method": "GET",
        "url": "https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "Authorization",
              "value": "=Bearer {{ $json.token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendQuery": true,
        "queryParameters": {
          "parameters": [
            {
              "name": "from",
              "value": "={{ $json.sliceFrom }}"
            },
            {
              "name": "to",
              "value": "={{ $json.sliceTo }}"
            },
            {
              "name": "rangeType",
              "value": "PAYED_DATETIME"
            },
            {
              "name": "pageSize",
              "value": "100"
            },
            {
              "name": "page",
              "value": "1"
            }
          ]
        },
        "options": {
          "response": {
            "response": {}
          },
          "timeout": 30000
        }
      },
      "id": "670bdbf2-5813-418f-a88f-48aa5953f630",
      "name": "HTTP_조건검색",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        1680,
        300
      ],
      "retryOnFail": true,
      "maxTries": 3,
      "waitBetweenTries": 3000
    },
    {
      "parameters": {
        "jsCode": "// HTTP_조건검색 응답에서 productOrderId 추출\nvar resp = $input.first().json;\nvar mergedInfo = $('토큰+슬라이스_병합').first().json;\n\nvar respData = resp.data || resp;\nvar contents = respData.contents || [];\nvar totalPages = respData.totalPages || 1;\n\nvar ids = [];\nfor (var i = 0; i < contents.length; i++) {\n  var content = contents[i].content || contents[i];\n  var pOrder = content.productOrder || {};\n  if (pOrder.productOrderId) {\n    ids.push(pOrder.productOrderId);\n  }\n}\n\n// 300건 이하이므로 바로 상세조회용 body 생성\n// 데이터 없으면 빈 배열 → HTTP_상세조회가 빈 body로 호출됨\nreturn [{\n  json: {\n    _hasData: ids.length > 0,\n    totalIds: ids.length,\n    totalPages: totalPages,\n    sliceLabel: mergedInfo.sliceLabel,\n    token: mergedInfo.token,\n    productOrderIds: ids,\n    _reqBody: JSON.stringify({ productOrderIds: ids })\n  }\n}];"
      },
      "id": "48d84c3d-689b-4a04-b6ba-f1ddb6c5e48d",
      "name": "ID추출+준비",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        1960,
        300
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/query",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "Authorization",
              "value": "=Bearer {{ $json.token }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={{ $json._reqBody }}",
        "options": {
          "timeout": 30000
        }
      },
      "id": "8a29e097-bb05-478f-8395-10553463b1f3",
      "name": "HTTP_상세조회",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        2240,
        300
      ],
      "retryOnFail": true,
      "maxTries": 3,
      "waitBetweenTries": 3000,
      "onError": "continueRegularOutput"
    },
    {
      "parameters": {
        "jsCode": "// 상세조회 응답 → Bulk UPSERT SQL 생성\nvar input = $input.first().json;\nvar idInfo = $('ID추출+준비').first().json;\n\n// 데이터 없는 슬라이스 → skip\nif (!idInfo._hasData) {\n  return [{ json: { _empty: true, query: 'SELECT 1', rowCount: 0, sliceLabel: idInfo.sliceLabel } }];\n}\n\nvar items = input.data || [];\nif (items.length === 0) {\n  return [{ json: { _empty: true, query: 'SELECT 1', rowCount: 0, sliceLabel: idInfo.sliceLabel } }];\n}\n\nfunction esc(v) {\n  if (v === null || v === undefined || v === '') return 'NULL';\n  return \"'\" + String(v).replace(/'/g, \"''\") + \"'\";\n}\nfunction escNum(v) {\n  if (v === null || v === undefined || isNaN(v)) return '0';\n  return String(Number(v));\n}\nfunction escTs(v) {\n  if (!v) return 'NULL';\n  return \"'\" + String(v).replace(/'/g, \"''\") + \"'::timestamptz\";\n}\nfunction escJson(v) {\n  if (!v) return 'NULL::jsonb';\n  var s = typeof v === 'string' ? v : JSON.stringify(v);\n  return \"'\" + s.replace(/'/g, \"''\") + \"'::jsonb\";\n}\n\nvar valueRows = [];\nfor (var i = 0; i < items.length; i++) {\n  var row = items[i];\n  var c = row.content || row;\n  var o = c.order || {};\n  var p = c.productOrder || {};\n  if (!p.productOrderId) continue;\n\n  valueRows.push('(' + [\n    esc(p.productOrderId), esc(o.orderId),\n    escTs(o.orderDate), escTs(o.paymentDate),\n    esc(o.ordererName), esc(o.ordererTel),\n    esc(p.productId), esc(p.productName),\n    esc(p.productOrderStatus),\n    escNum(p.quantity), escNum(p.totalPaymentAmount),\n    escJson(row), 'NOW()'\n  ].join(', ') + ')');\n}\n\nif (valueRows.length === 0) {\n  return [{ json: { _empty: true, query: 'SELECT 1', rowCount: 0, sliceLabel: idInfo.sliceLabel } }];\n}\n\nvar query = 'INSERT INTO dcurvin.raw_naver_orders ('\n  + '  product_order_id, order_id, order_date, payment_date,'\n  + '  orderer_name, orderer_tel, product_id, product_name,'\n  + '  product_order_status, quantity, total_payment_amount, payload, synced_at'\n  + ') VALUES '\n  + valueRows.join(', ')\n  + ' ON CONFLICT (product_order_id) DO UPDATE SET'\n  + '  order_date = EXCLUDED.order_date,'\n  + '  payment_date = EXCLUDED.payment_date,'\n  + '  product_order_status = EXCLUDED.product_order_status,'\n  + '  quantity = EXCLUDED.quantity,'\n  + '  total_payment_amount = EXCLUDED.total_payment_amount,'\n  + '  payload = EXCLUDED.payload,'\n  + '  synced_at = NOW()';\n\nreturn [{ json: { _empty: false, query: query, rowCount: valueRows.length, sliceLabel: idInfo.sliceLabel } }];"
      },
      "id": "1e835637-06d6-4f91-a912-8cce011e4cfe",
      "name": "SQL생성",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        2520,
        300
      ]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "={{ $json.query }}",
        "options": {}
      },
      "id": "bd4e8442-645f-4b43-9d37-3a2bdc52692f",
      "name": "💾 DB_Bulk_UPSERT",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 2.5,
      "position": [
        2800,
        300
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
        "amount": 1,
        "unit": "seconds"
      },
      "id": "d71c7dce-ea80-4f30-8287-02f9da425753",
      "name": "Wait_1초",
      "type": "n8n-nodes-base.wait",
      "typeVersion": 1.1,
      "position": [
        3080,
        300
      ]
    },
    {
      "parameters": {
        "jsCode": "// 전체 슬라이스 결과 요약\nvar items = $input.all();\nvar totalRows = 0;\nvar sliceResults = [];\n\nfor (var i = 0; i < items.length; i++) {\n  totalRows += (items[i].json.rowCount || 0);\n  if (items[i].json.sliceLabel) {\n    sliceResults.push({\n      label: items[i].json.sliceLabel,\n      rows: items[i].json.rowCount || 0\n    });\n  }\n}\n\nvar desc = $('날짜_설정').first().json.description || '';\n\nreturn [{\n  json: {\n    success: true,\n    description: desc,\n    totalUpserted: totalRows,\n    sliceCount: sliceResults.length,\n    sliceResults: sliceResults,\n    completedAt: new Date().toISOString()\n  }\n}];"
      },
      "id": "40e6b243-0481-49b6-98ab-99394c2cd371",
      "name": "결과_요약",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        1120,
        100
      ]
    },
    {
      "parameters": {
        "respondWith": "json",
        "responseBody": "={{ $json }}",
        "options": {}
      },
      "id": "5bd04e87-6de8-4385-b6a8-8cc6d06d21e8",
      "name": "완료_응답",
      "type": "n8n-nodes-base.respondToWebhook",
      "typeVersion": 1.1,
      "position": [
        1400,
        100
      ]
    },
    {
      "parameters": {},
      "id": "6a5c9545-6ce0-4958-ac27-21789e922664",
      "name": "에러_트리거",
      "type": "n8n-nodes-base.errorTrigger",
      "typeVersion": 1,
      "position": [
        560,
        700
      ]
    },
    {
      "parameters": {
        "jsCode": "var errMsg = ($input.first().json.execution && $input.first().json.execution.error && $input.first().json.execution.error.message) || 'Unknown error';\nvar errNode = ($input.first().json.execution && $input.first().json.execution.error && $input.first().json.execution.error.node && $input.first().json.execution.error.node.name) || 'Unknown node';\nvar wfName = ($input.first().json.execution && $input.first().json.execution.workflowData && $input.first().json.execution.workflowData.name) || $workflow.name || 'Unknown';\n\nreturn [{\n  json: {\n    workflow_name: wfName,\n    node_name: errNode,\n    error_message: errMsg,\n    error_data: JSON.stringify($input.first().json).slice(0, 2000),\n    alert_text: '\\ud83d\\udd34 [D.CURVIN] \\uc6cc\\ud06c\\ud50c\\ub85c\\uc6b0 \\uc5d0\\ub7ec\\n\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\nWF: ' + wfName + '\\nNode: ' + errNode + '\\nError: ' + errMsg + '\\nTime: ' + new Date().toISOString() + '\\n\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501\\u2501'\n  }\n}];"
      },
      "id": "0ee21641-8788-42ea-90fa-1e90a2ba272a",
      "name": "에러_구조화",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        840,
        700
      ]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "INSERT INTO dcurvin.log_workflow_errors (\n    workflow_name, node_name, error_message, error_data, created_at\n) VALUES (\n    $1, $2, $3, $4::jsonb,\n    NOW() AT TIME ZONE 'Asia/Seoul'\n);",
        "options": {
          "queryReplacement": "={{ [\n  $json.workflow_name,\n  $json.node_name,\n  $json.error_message,\n  JSON.stringify({ raw: $json.error_data, timestamp: new Date().toISOString() })\n] }}"
        }
      },
      "id": "c2c6a1fb-f3aa-42b1-9503-11b0d4338368",
      "name": "에러_DB기록",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 2.6,
      "position": [
        1120,
        700
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
        "jsCode": "var crypto = require('crypto');\n\nvar apiKey = $env.SOLAPI_API_KEY || '';\nvar apiSecret = $env.SOLAPI_API_SECRET || '';\n\nvar date = new Date().toISOString();\nvar salt = crypto.randomBytes(32).toString('hex');\nvar signature = crypto.createHmac('sha256', apiSecret)\n  .update(date + salt)\n  .digest('hex');\n\nreturn [{\n  json: {\n    workflow_name: $json.workflow_name,\n    node_name: $json.node_name,\n    alert_text: $json.alert_text,\n    solapi_auth: 'HMAC-SHA256 apiKey=' + apiKey + ', date=' + date + ', salt=' + salt + ', signature=' + signature\n  }\n}];"
      },
      "id": "f13a6d58-ad78-4fec-96ba-e6e93a875ff0",
      "name": "Solapi_인증생성",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [
        1400,
        700
      ]
    },
    {
      "parameters": {
        "method": "POST",
        "url": "https://api.solapi.com/messages/v4/send",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "Authorization",
              "value": "={{ $json.solapi_auth }}"
            },
            {
              "name": "Content-Type",
              "value": "application/json"
            }
          ]
        },
        "sendBody": true,
        "specifyBody": "json",
        "jsonBody": "={\n  \"message\": {\n    \"to\": \"{{ $env.ALERT_PHONE || '' }}\",\n    \"from\": \"{{ $env.SOLAPI_SENDER || '' }}\",\n    \"text\": {{ JSON.stringify($json.alert_text) }}\n  }\n}",
        "options": {}
      },
      "id": "6391f53b-9850-4532-b74d-eb0ad83be1e2",
      "name": "Solapi_알림발송",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [
        1680,
        700
      ]
    },
    {
      "parameters": {
        "content": "## [IN] NaverComm : 주문 상세 (Bulk) v5\n\n**v4.3 대비 변경사항**\n- SplitInBatches: 2개 → 1개 (슬라이스 루프만)\n- 중첩 루프/IF 노드 전부 제거\n- Code 내 fetch 제거 → HTTP Request 노드 사용\n- 기능 노드: 17개 → 13개\n\n**실행**: Manual / Webhook POST {from, to}\n**흐름**: 24h 슬라이스 → 조건검색 → ID추출 → 상세조회 → UPSERT",
        "height": 260,
        "width": 420,
        "color": 4
      },
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [
        -480,
        160
      ],
      "id": "ae5ee6bf-ecba-4dea-8cc7-d73a41918426",
      "name": "📋 워크플로우_설명"
    },
    {
      "parameters": {
        "content": "### ⚠️ n8n Task Runner 제약\nCode 노드에서 fetch/require('http') 사용 불가\n→ HTTP 호출은 반드시 HTTP Request 노드로!",
        "height": 80,
        "width": 380,
        "color": 7
      },
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [
        1600,
        100
      ],
      "id": "b298feff-dd43-480e-bfaa-4e3067adf14d",
      "name": "📝 제약사항"
    }
  ],
  "pinData": {},
  "connections": {
    "Manual_트리거": {
      "main": [
        [
          {
            "node": "날짜_설정",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Webhook_벌크주문": {
      "main": [
        [
          {
            "node": "날짜_설정",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "날짜_설정": {
      "main": [
        [
          {
            "node": "24h_슬라이스",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "24h_슬라이스": {
      "main": [
        [
          {
            "node": "슬라이스_루프",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "슬라이스_루프": {
      "main": [
        [
          {
            "node": "결과_요약",
            "type": "main",
            "index": 0
          }
        ],
        [
          {
            "node": "인증_토큰_획득",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "인증_토큰_획득": {
      "main": [
        [
          {
            "node": "토큰+슬라이스_병합",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "토큰+슬라이스_병합": {
      "main": [
        [
          {
            "node": "HTTP_조건검색",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "HTTP_조건검색": {
      "main": [
        [
          {
            "node": "ID추출+준비",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "ID추출+준비": {
      "main": [
        [
          {
            "node": "HTTP_상세조회",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "HTTP_상세조회": {
      "main": [
        [
          {
            "node": "SQL생성",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "SQL생성": {
      "main": [
        [
          {
            "node": "💾 DB_Bulk_UPSERT",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "💾 DB_Bulk_UPSERT": {
      "main": [
        [
          {
            "node": "Wait_1초",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Wait_1초": {
      "main": [
        [
          {
            "node": "슬라이스_루프",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "결과_요약": {
      "main": [
        [
          {
            "node": "완료_응답",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "에러_트리거": {
      "main": [
        [
          {
            "node": "에러_구조화",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "에러_구조화": {
      "main": [
        [
          {
            "node": "에러_DB기록",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "에러_DB기록": {
      "main": [
        [
          {
            "node": "Solapi_인증생성",
            "type": "main",
            "index": 0
          }
        ]
      ]
    },
    "Solapi_인증생성": {
      "main": [
        [
          {
            "node": "Solapi_알림발송",
            "type": "main",
            "index": 0
          }
        ]
      ]
    }
  },
  "active": false,
  "settings": {
    "executionOrder": "v1",
    "binaryMode": "separate",
    "availableInMCP": false
  },
  "versionId": "81c711de-5b93-498b-8ce2-26f9fb5c5c12",
  "meta": {
    "instanceId": "8c062a229773360b4071bd938783a6d51ae2f75bf33f02dce4719649e1783735"
  },
  "id": "",
  "tags": []
}
