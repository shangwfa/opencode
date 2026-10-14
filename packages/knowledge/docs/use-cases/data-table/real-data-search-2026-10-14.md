# 真实形态结构化数据实测（OpenAPI / RPA 指令 / CSV）

> 用三类业务真实形态的数据实测 data-table 智能检索：**OpenAPI 3.0 接口元数据**（"哪个接口能做某事"）、
> **RPA 指令库**（"哪个指令能完成某操作"）、**CSV 订单数据**（通用表格）。
> 日期：2026-10-14。环境：Docker 知识服务 + 确定性 mock 向量 + knowledge-pg（schema `knowledge_dt_real_20261014`，已清理）。
> 判定：PASS/FAIL 为可判定断言；**OBSERVE 为记录性观察**（mock 向量下的预期行为或已知缺陷实证，不计失败）。

## 数据与列设计

| 数据集 | 行数 | 列 | 来源形态 |
|---|---|---|---|
| OpenAPI 接口库 | 16 | method, path, summary, description, tags | OpenAPI 3.0 operation 级提取（method/path/summary/description/tags） |
| RPA 指令库 | 16 | category, name, description, params | RPA 指令元数据（分类/指令名/描述/参数） |
| CSV 订单 | 12 | order_no, customer, region, product, qty, amount, status, ordered_at | CSV 文件，**外部适配**转 rows（中文表头→英文列名映射） |

CSV 解析由脚本内的适配逻辑完成（csv.DictReader + 表头映射）——data-table 本身无 CSV 导入接口（审核 F10），本实测验证的是"转换后接入"路径。

## 用例矩阵

| 组 | 覆盖 |
|---|---|
| C1~C9 | 三数据集建库、PG 行数、向量 metadata.rowId 全覆盖 |
| A1~A11 (OpenAPI) | keyword 子串（支付/发票/令牌）、semantic 词面命中（校验库存/PDF）、filter（tags 子串、method 等值）、keyword×filter 组合、GET query、simple 模式观察、同义改写观察 |
| B1~B10 (RPA) | keyword（网页/Excel）、semantic 英文 token（Excel/SMTP/OCR）与中文词组（启动浏览器）、filter 分类、组合、GET query、0 分返回观察、同义改写观察 |
| C10~C20 (CSV) | keyword（商品/状态）、filter 子串/等值/精确 id、keyword×filter 组合、行分页、行详情全列、semantic 失效观察、数字范围不可用观察 |

## 内嵌测试脚本

```bash
BASE=${BASE:-http://127.0.0.1:18887/api}
PGC=${PGC:-knowledge-pg}; PGDB=${PGDB:-knowledge}; SCH=${SCH:-knowledge_dt_real_20261014}
TS=$(date +%s)
DS_API="rd_dt_api_$TS"; DS_RPA="rd_dt_rpa_$TS"; DS_CSV="rd_dt_csv_$TS"
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/dt-real.XXXXXX"); RES="$RUN_DIR/response.json"
pass=0; fail=0; obs=0
req()  { curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' "$@"; }
post() { curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' -X POST "$1" -H 'Content-Type: application/json' ${2:+-d "$2"}; }
postfile(){ curl -sS -m 90 --noproxy '*' -o "$RES" -w '%{http_code}' -X POST "$1" -H 'Content-Type: application/json' --data-binary "@$2"; }
py()   { python3 -c "${1//RESFILE/$RES}"; }
pgq()  { docker exec "$PGC" psql -U postgres -d "$PGDB" -Atc "$1"; }
check(){ if [ -n "$3" ] && [ "$3" = "$4" ]; then echo "PASS $1 $2"; pass=$((pass+1)); else echo "FAIL $1 $2 expect=[$3] got=[$4]"; fail=$((fail+1)); fi }
observe(){ echo "OBSERVE $1"; obs=$((obs+1)); }
mkbasic(){ python3 - "$1" "$2" "$3" "$4" "$5" <<'PY'
import json,sys
rows=json.load(open(sys.argv[1]))
cols=sys.argv[3].split(',')
json.dump({"id":sys.argv[2],"name":sys.argv[4],"columns":[{"name":c} for c in cols],"dataSource":rows},open(sys.argv[5],'w'),ensure_ascii=False)
PY
}
mkcsvbody(){ python3 - "$1" "$2" "$3" <<'PY'
import csv,json,sys
mp={'订单号':'order_no','客户名称':'customer','区域':'region','商品':'product','数量':'qty','金额':'amount','状态':'status','下单时间':'ordered_at'}
rows=[{mp[k]:v for k,v in r.items()} for r in csv.DictReader(open(sys.argv[1]))]
cols=['order_no','customer','region','product','qty','amount','status','ordered_at']
json.dump({"id":sys.argv[2],"name":"CSV订单数据","columns":[{"name":c} for c in cols],"dataSource":rows},open(sys.argv[3],'w'),ensure_ascii=False)
PY
}
cleanup(){ for id in "$DS_API" "$DS_RPA" "$DS_CSV"; do curl -sS -m 30 --noproxy '*' -o /dev/null -X DELETE "$BASE/database/$id" || true; done; rm -rf "$RUN_DIR"; }
trap cleanup EXIT

cat > "$RUN_DIR/data-openapi.json" <<'JSON'
[
  { "method": "POST", "path": "/users", "summary": "创建用户", "description": "创建新用户账号、支持基本信息与初始角色、返回完整用户对象", "tags": "用户" },
  { "method": "GET", "path": "/users", "summary": "查询用户列表", "description": "分页查询用户、支持按注册时间范围过滤、返回用户摘要列表", "tags": "用户" },
  { "method": "GET", "path": "/users/{id}", "summary": "查询用户详情", "description": "获取单个用户的详细信息、包括角色与权限", "tags": "用户" },
  { "method": "DELETE", "path": "/users/{id}", "summary": "删除用户", "description": "软删除指定用户、保留关联数据可恢复", "tags": "用户 管理" },
  { "method": "POST", "path": "/orders", "summary": "创建订单", "description": "创建订单、校验库存、计算订单金额、返回订单号", "tags": "订单 交易" },
  { "method": "GET", "path": "/orders", "summary": "查询订单列表", "description": "分页查询订单、支持状态与时间范围过滤", "tags": "订单 交易" },
  { "method": "GET", "path": "/orders/{id}", "summary": "查询订单详情", "description": "获取订单明细、包含商品清单与物流信息", "tags": "订单 交易" },
  { "method": "POST", "path": "/payments", "summary": "发起支付", "description": "发起支付、对接第三方支付渠道、返回支付跳转链接", "tags": "支付 交易" },
  { "method": "GET", "path": "/payments/{id}", "summary": "查询支付状态", "description": "查询支付结果、支持回调状态轮询", "tags": "支付 交易" },
  { "method": "POST", "path": "/refunds", "summary": "申请退款", "description": "提交退款申请、校验原支付单、生成退款单", "tags": "退款 交易" },
  { "method": "GET", "path": "/invoices/{id}", "summary": "下载发票", "description": "下载指定订单的发票 PDF 文件、支持重开申请", "tags": "发票 财务" },
  { "method": "POST", "path": "/invoices", "summary": "开具发票", "description": "开具增值税发票、校验开票信息、推送电子发票到邮箱", "tags": "发票 财务" },
  { "method": "PUT", "path": "/inventory/{sku}", "summary": "更新库存", "description": "更新指定 SKU 的库存数量、记录变更流水", "tags": "库存 供应链" },
  { "method": "GET", "path": "/inventory", "summary": "查询库存", "description": "查询库存余量、支持按仓库与 SKU 过滤", "tags": "库存 供应链" },
  { "method": "POST", "path": "/sessions", "summary": "创建会话", "description": "用户登录、创建会话、返回访问令牌 access token", "tags": "会话 认证" },
  { "method": "DELETE", "path": "/sessions/{id}", "summary": "注销会话", "description": "注销会话、清除登录态、吊销令牌", "tags": "会话 认证" }
]
JSON
cat > "$RUN_DIR/data-rpa.json" <<'JSON'
[
  { "category": "浏览器", "name": "打开网页", "description": "启动浏览器、导航到指定网址、支持无头模式", "params": "网址, 超时秒数" },
  { "category": "浏览器", "name": "点击元素", "description": "模拟鼠标点击网页中的指定元素、支持等待出现后点击", "params": "目标元素, 点击类型" },
  { "category": "浏览器", "name": "输入文本", "description": "在网页输入框中键入文本内容、支持清空后输入", "params": "输入框, 文本内容" },
  { "category": "浏览器", "name": "提取表格数据", "description": "从网页表格中提取数据、输出为二维数组", "params": "选择器, 输出变量" },
  { "category": "浏览器", "name": "截取网页图片", "description": "对当前网页整页或区域截图、保存为 PNG 文件", "params": "截图区域, 保存路径" },
  { "category": "文件", "name": "读取Excel", "description": "读取 Excel 文件的指定区域、输出二维数组", "params": "文件路径, 工作表, 区域" },
  { "category": "文件", "name": "写入Excel", "description": "将数据写入 Excel 工作表、支持追加与覆盖两种模式", "params": "文件路径, 数据, 写入模式" },
  { "category": "文件", "name": "复制文件夹", "description": "复制整个文件夹到目标位置、支持覆盖同名", "params": "源路径, 目标路径" },
  { "category": "鼠标键盘", "name": "模拟按键", "description": "模拟键盘按键与组合键、支持设置按键间隔", "params": "按键序列, 间隔毫秒" },
  { "category": "系统", "name": "执行命令行", "description": "运行系统命令并获取标准输出、支持设置超时", "params": "命令, 超时秒数" },
  { "category": "邮件", "name": "发送邮件", "description": "通过 SMTP 发送邮件、支持 HTML 正文与附件", "params": "收件人, 主题, 附件" },
  { "category": "图片", "name": "识别验证码", "description": "调用 OCR 识别图片中的验证码文字、输出字符串", "params": "图片路径, 输出变量" },
  { "category": "数据处理", "name": "JSON解析", "description": "解析 JSON 字符串为对象、支持按路径取值", "params": "JSON 文本, 取值路径" },
  { "category": "流程", "name": "条件分支", "description": "根据条件表达式选择执行分支、支持多路分支", "params": "条件表达式" },
  { "category": "流程", "name": "循环执行", "description": "对列表或指定次数循环执行子流程、支持中断", "params": "列表或次数" },
  { "category": "等待", "name": "等待元素出现", "description": "等待网页元素出现或超时、常配合点击指令使用", "params": "选择器, 超时秒数" }
]
JSON
cat > "$RUN_DIR/data-orders.csv" <<'CSV'
订单号,客户名称,区域,商品,数量,金额,状态,下单时间
SO-1001,杭州云启科技,浙江省杭州市,企业版授权,5,45000,已付款,2026-09-01
SO-1002,上海临港智造,上海市,传感器套件,120,86000,已发货,2026-09-03
SO-1003,北京华码软件,北京市,定制开发服务,1,120000,进行中,2026-09-05
SO-1004,深圳前海数据,广东省深圳市,数据网关,8,32000,已付款,2026-09-08
SO-1005,杭州云启科技,浙江省杭州市,维保服务,1,15000,已完成,2026-09-10
SO-1006,成都天府云图,四川省成都市,企业版授权,3,27000,待付款,2026-09-12
SO-1007,苏州纳芯微电,江苏省苏州市,传感器套件,60,43000,已发货,2026-09-15
SO-1008,广州珠江智联,广东省广州市,定制开发服务,2,96000,进行中,2026-09-18
SO-1009,北京华码软件,北京市,数据网关,4,16000,已退款,2026-09-21
SO-1010,武汉光谷软件,湖北省武汉市,培训服务,2,8000,已完成,2026-09-25
SO-1011,上海临港智造,上海市,企业版授权,10,90000,已付款,2026-09-28
SO-1012,杭州云启科技,浙江省杭州市,传感器套件,45,32000,待付款,2026-09-30
CSV

SVC=$(req "$BASE/database?page=1&pageSize=1")
if [ "$SVC" != "200" ]; then echo "SKIP 服务未就绪(http=$SVC)"; exit 0; fi
if [ "$(pgq 'SELECT 1')" != "1" ]; then echo "SKIP PG 不可达"; exit 0; fi

mkbasic "$RUN_DIR/data-openapi.json" "$DS_API" "method,path,summary,description,tags" "OpenAPI接口库" "$RUN_DIR/api.json"
mkbasic "$RUN_DIR/data-rpa.json"     "$DS_RPA" "category,name,description,params"      "RPA指令库"     "$RUN_DIR/rpa.json"
mkcsvbody "$RUN_DIR/data-orders.csv" "$DS_CSV" "$RUN_DIR/csv.json"
check C1 "OpenAPI建库" 200 "$(postfile "$BASE/database" "$RUN_DIR/api.json")"
check C2 "RPA建库"     200 "$(postfile "$BASE/database" "$RUN_DIR/rpa.json")"
check C3 "CSV建库(外部解析转rows)" 200 "$(postfile "$BASE/database" "$RUN_DIR/csv.json")"
check C4 "API行数16" 16 "$(pgq "SELECT count(*) FROM $SCH.$(pgq "SELECT data_table_name FROM $SCH.databases WHERE id='$DS_API'")")"
check C5 "RPA行数16" 16 "$(pgq "SELECT count(*) FROM $SCH.$(pgq "SELECT data_table_name FROM $SCH.databases WHERE id='$DS_RPA'")")"
check C6 "CSV行数12" 12 "$(pgq "SELECT count(*) FROM $SCH.$(pgq "SELECT data_table_name FROM $SCH.databases WHERE id='$DS_CSV'")")"
check C7 "API向量rowId覆盖=16" 16 "$(pgq "SELECT count(DISTINCT metadata->>'rowId') FROM $SCH.kb_$DS_API")"
check C8 "RPA向量rowId覆盖=16" 16 "$(pgq "SELECT count(DISTINCT metadata->>'rowId') FROM $SCH.kb_$DS_RPA")"
check C9 "CSV向量rowId覆盖=12" 12 "$(pgq "SELECT count(DISTINCT metadata->>'rowId') FROM $SCH.kb_$DS_CSV")"

SEA_API(){ post "$BASE/database/$DS_API/rows/search" "$1"; }
SEA_RPA(){ post "$BASE/database/$DS_RPA/rows/search" "$1"; }
SEA_CSV(){ post "$BASE/database/$DS_CSV/rows/search" "$1"; }
hitcount(){ py "import json;print(len(json.load(open('RESFILE'))['data']['items']))"; }

check A1 "keyword:支付→3条" 3 "$(SEA_API '{"query":"支付","searchType":"keyword","topK":10}' >/dev/null; hitcount)"
check A2 "keyword:发票→2条且含下载发票" yes "$(SEA_API '{"query":"发票","searchType":"keyword","topK":10}' >/dev/null; py "import json;d=json.load(open('RESFILE'))['data'];print('yes' if any(x['row']['summary']=='下载发票' for x in d['items']) and len(d['items'])==2 else 'no')")"
check A3 "keyword:令牌→会话2条" 2 "$(SEA_API '{"query":"令牌","searchType":"keyword","topK":10}' >/dev/null; hitcount)"
check A4 "semantic:校验库存→创建订单接口" yes "$(SEA_API '{"query":"校验库存","searchType":"semantic","topK":5}' >/dev/null; py "import json;d=json.load(open('RESFILE'))['data'];print('yes' if any(x['row']['summary']=='创建订单' for x in d['items']) else 'no')")"
check A5 "semantic:PDF→下载发票接口" yes "$(SEA_API '{"query":"PDF","searchType":"semantic","topK":5}' >/dev/null; py "import json;d=json.load(open('RESFILE'))['data'];print('yes' if any(x['row']['summary']=='下载发票' for x in d['items']) else 'no')")"
check A6 "filter:tags财务→2" 2 "$(SEA_API '{"filter":{"tags":"财务"}}' >/dev/null; hitcount)"
check A7 "filter:method=POST精确→6" 6 "$(SEA_API '{"filter":{"method":"POST"}}' >/dev/null; hitcount)"
check A8 "组合:keyword PDF×财务→1且为下载发票" yes "$(SEA_API '{"query":"PDF","searchType":"keyword","filter":{"tags":"财务"},"topK":5}' >/dev/null; py "import json;d=json.load(open('RESFILE'))['data'];print('yes' if len(d['items'])==1 and d['items'][0]['row']['summary']=='下载发票' else 'no')")"
check A9 "GET query:支付(path列有效)" yes "$(req "$BASE/database/$DS_API/query?query=%E6%94%AF%E4%BB%98&simple=1" >/dev/null; py "import json;d=json.load(open('RESFILE'))['data'];print('yes' if d and all(x.get('path') for x in d) else 'no')")"
observe "A11 GET simple模式写死name/path列：本数据集无name列→name为空（schema适配性观察）"
SEA_API '{"query":"怎么让机器人帮我付钱","searchType":"semantic","topK":5}' >/dev/null
observe "A10 semantic改写'怎么让机器人帮我付钱'命中=$(hitcount)（0分行照返回，见B3b；真实语义待真实embedding评估）"

check B1 "keyword:网页→6条" 6 "$(SEA_RPA '{"query":"网页","searchType":"keyword","topK":10}' >/dev/null; hitcount)"
check B2 "keyword:Excel→2条" 2 "$(SEA_RPA '{"query":"Excel","searchType":"keyword","topK":10}' >/dev/null; hitcount)"
check B3 "semantic:Excel前2位为Excel行" yes "$(SEA_RPA '{"query":"Excel","searchType":"semantic","topK":10}' >/dev/null; py "import json;d=json.load(open('RESFILE'))['data'];names=[x['row']['name'] for x in d['items'][:2]];print('yes' if set(names)=={'读取Excel','写入Excel'} else 'no:%s'%names)")"
observe "B3b semantic无相关性下限：'Excel'查询topK=10返回10条(含0分无关行)——F09实证，无空结果契约"
check B4 "semantic:SMTP→发送邮件" yes "$(SEA_RPA '{"query":"SMTP","searchType":"semantic","topK":5}' >/dev/null; py "import json;d=json.load(open('RESFILE'))['data'];print('yes' if any(x['row']['name']=='发送邮件' for x in d['items']) else 'no')")"
check B5 "semantic:OCR→识别验证码" yes "$(SEA_RPA '{"query":"OCR","searchType":"semantic","topK":5}' >/dev/null; py "import json;d=json.load(open('RESFILE'))['data'];print('yes' if any(x['row']['name']=='识别验证码' for x in d['items']) else 'no')")"
check B6 "semantic:启动浏览器→打开网页" yes "$(SEA_RPA '{"query":"启动浏览器","searchType":"semantic","topK":5}' >/dev/null; py "import json;d=json.load(open('RESFILE'))['data'];print('yes' if any(x['row']['name']=='打开网页' for x in d['items']) else 'no')")"
check B7 "filter:浏览器类→5" 5 "$(SEA_RPA '{"filter":{"category":"浏览器"}}' >/dev/null; hitcount)"
check B8 "组合:keyword Excel×文件类→2" 2 "$(SEA_RPA '{"query":"Excel","searchType":"keyword","filter":{"category":"文件"},"topK":5}' >/dev/null; hitcount)"
check B9 "GET query:邮件" yes "$(req "$BASE/database/$DS_RPA/query?query=%E9%82%AE%E4%BB%B6&simple=1" >/dev/null; py "import json;d=json.load(open('RESFILE'))['data'];print('yes' if d else 'no')")"
SEA_RPA '{"query":"把页面上的表格搬到变量里","searchType":"semantic","topK":5}' >/dev/null
observe "B10 semantic改写'把页面上的表格搬到变量里'命中=$(hitcount)（0分行照返回，见B3b；真实语义待真实embedding评估）"

check C10 "keyword:企业版授权→3" 3 "$(SEA_CSV '{"query":"企业版授权","searchType":"keyword","topK":10}' >/dev/null; hitcount)"
check C11 "keyword:退款→已退款1条" 1 "$(SEA_CSV '{"query":"退款","searchType":"keyword","topK":10}' >/dev/null; hitcount)"
check C12 "filter:region浙江子串→3" 3 "$(SEA_CSV '{"filter":{"region":"浙江"}}' >/dev/null; hitcount)"
check C13 "filter:customer云启→3" 3 "$(SEA_CSV '{"filter":{"customer":"云启"}}' >/dev/null; hitcount)"
check C14 "filter:status已退款→1" 1 "$(SEA_CSV '{"filter":{"status":"已退款"}}' >/dev/null; hitcount)"
check C15 "filter:order_no精确→1" 1 "$(SEA_CSV '{"filter":{"order_no":"SO-1009"}}' >/dev/null; hitcount)"
check C16 "组合:keyword传感器×上海→1" 1 "$(SEA_CSV '{"query":"传感器","searchType":"keyword","filter":{"region":"上海"},"topK":5}' >/dev/null; hitcount)"
check C17 "行列表分页pageSize5" "5|12" "$(req "$BASE/database/$DS_CSV/rows?page=1&pageSize=5" >/dev/null; py "import json;d=json.load(open('RESFILE'))['data'];print('%s|%s'%(len(d['items']),d['total']))")"
check C18 "行详情含全部CSV列" yes "$(RID=$(pgq "SELECT id FROM $SCH.$(pgq "SELECT data_table_name FROM $SCH.databases WHERE id='$DS_CSV'") WHERE order_no='SO-1001'"); req "$BASE/database/$DS_CSV/rows/$RID" >/dev/null; py "import json;d=json.load(open('RESFILE'))['data'];need=['order_no','customer','region','product','qty','amount','status','ordered_at'];print('yes' if all(k in d for k in need) else 'no')")"
SEA_CSV '{"query":"企业版授权","searchType":"semantic","topK":10}' >/dev/null
observe "C19 semantic'企业版授权'命中=$(hitcount)（CSV中文数字连排→单token，全部0分照返回——F05拼接无分隔实证；keyword路径正常）"
observe "C20 数字范围查询(金额>50000)不可用（filter仅等值/子串，类型均为TEXT——F06实证）"

echo "━━━ realdata 汇总: PASS=$pass FAIL=$fail OBSERVE=$obs ━━"
exit $fail
```

## 实测结果（2026-10-14，Docker HTTP/PG + mock 确定性向量）

**36 PASS / 0 FAIL / 6 OBSERVE**（首轮 4 个 FAIL 中 3 个为脚本期望值笔误已修正；1 个转为 B3b 观察）。

### 各路径表现

| 检索路径 | OpenAPI | RPA 指令 | CSV 订单 |
|---|---|---|---|
| keyword（ILIKE 子串） | 全部命中（支付/发票/令牌） | 全部命中（网页/Excel） | 全部命中（商品/状态） |
| semantic（词面重叠 token） | 命中且排序正确（校验库存/PDF） | 命中且排序正确（Excel/SMTP/OCR/启动浏览器） | **基本失效**（C19） |
| filter（等值/子串/精确 id） | 命中（tags/method） | 命中（category） | 命中（region/customer/status/order_no） |
| keyword × filter 组合 | 命中（PDF×财务） | 命中（Excel×文件） | 命中（传感器×上海） |
| GET /query | 可用（path 列） | 可用（name 列） | — |

### 关键发现（对优化方案的影响）

1. **keyword 路径三类数据全场景可用**：ILIKE 子串匹配不受拼接无分隔影响（子串跨字段边界仍命中），是当前最可靠的检索路径。
2. **F05 实证（拼接无分隔）**：CSV 类数据（中文+数字连排）semantic 基本失效——整行连成一个 token，查询词无法重叠（C19）。英文 token（Excel/SMTP/OCR/PDF）和字段值内部有顿号分隔的中文词组（启动浏览器/校验库存）可正常命中。**F05 是表数据语义检索可用性的直接阻断项，应提前到下一批修复**（序列化加字段边界与分隔）。
3. **F09 实证（无相关性下限）**：semantic 检索返回 topK 内全部行，0 分无关行照常返回（B3b；A10/B10 的"命中"实为 0 分全返回，不是真命中）。**没有空结果契约**：完全不相关的查询也返回满页结果，对上层应用（如 Agent 选指令）是误导。应与 F05 同批修复（minScore 下限 + 空结果语义）。
4. **F06 实证（数字范围不可用）**：CSV 的金额/数量列全部 TEXT，`金额>50000` 无法表达（C20）。结构化过滤能力依赖字段类型化（优化方案第三阶段）。
5. **GET simple 模式写死 name/path 列**（A11）：对不含这两列的 schema，simple 输出半空。simple 应按数据集 schema 适配或显式声明约定。
6. **同义改写无法在 mock 向量下评估**（A10/B10）：需接入真实 embedding 端点后按 rag 的 L2 评估准则补测；本轮不冒充语义质量结论。

### 结论

- 检索骨架（建库/写入/向量化/keyword/filter/组合/回填）在三类真实形态数据上**机制可用**。
- 对外提供"智能检索"前必须修复：**F05（索引文本序列化）与 F09（相关性下限/空结果契约）**——这两个直接决定语义检索在真实表格数据上是否可用；建议从优化方案第三阶段提前。
- CSV 导入目前依赖外部适配（脚本内表头映射转换），产品化导入链路仍是缺口（F10）。

## v2 实测（2026-10-14 追加）：多向量化策略 + searchFields + 零相关过滤

> 同日第二轮：实现 `vectorStrategy: row | field | row+field`（数据集级配置，PATCH 切换触发全量重向量化）、
> 索引文本字段边界序列化（F05 修复）、semantic 默认零相关过滤与空结果契约（F09 修复）、
> `searchFields` 字段限定语义检索（仅 field/row+field 策略，plain semantic；row-only 显式 400）。
> field 向量 id：`<rowId>__f_<col>__c<i>`，metadata 带 `field` 标记。

**结果：35 PASS / 0 FAIL / 1 OBSERVE**（Docker HTTP/PG + mock 向量；另 150 断言 + 21 契约回归全过）。

| 验证面 | 结果 |
|---|---|
| 三策略建库与向量结构 | row=16 / field=16行×4字段 / row+field=4行×(1+2)；field 向量 id 与 metadata.field 全量正确 |
| v1 失效场景恢复 | CSV（field 策略）semantic"企业版授权"→3 行命中（v1 为 0） |
| searchFields 字段限定 | name/product 限定命中、跨字段隔离（customer 限定→0）；row 策略显式 400 |
| 策略切换重建 | PATCH row+field→field 后向量 12→8（行向量移除），元数据同步 |
| 空结果契约 | 改写查询返回 0 条（不再满页 0 分行）；'Excel' 查询恰返回 2 行 |

OBSERVE：field 策略下 keyword 结果为向量级（同一行多字段命中出现重复项，如"网页"6 行 7 向量）——F07 行级聚合待做。

## OpenRouter 真实向量化实测（2026-10-14）

配置：`KNOWLEDGE_EMBEDDING_BASE_URL=https://openrouter.ai/api/v1` + `.env` 的 key，模型 `openai/text-embedding-3-small`（1536 维）。
实现补充：embedding 端点为 OpenRouter 时保留完整 `provider/model` 模型 ID（官方 OpenAI 端点仍剥前缀），带单测。

**端点直连**：200 / 1536 维 / 1.8s；语义自检 cosine——同义（创建订单~下单）0.68 > 同域（库存盘点）0.53 > 无关（发邮件）0.30。

**服务集成（7 PASS / 2 OBSERVE）**：

| 验证 | 结果 |
|---|---|
| S1 "把页面上的表格搬到变量里" → 提取表格数据 | ✅ 真实语义命中（mock 下为 0） |
| S3 "怎么让机器人帮我付钱" → 发起支付 | ✅ |
| S5 "开票报销" → 发票接口 | ✅ |
| S2 "读一下表格文件" → top1 提取表格数据（期望读取Excel） | OBSERVE：词义歧义排序（"表格文件"两义），L2 质量观察非机制缺陷 |
| S4 "用户怎么登录系统" → top1 创建用户（期望创建会话） | OBSERVE：同上 |
| S8 无关查询"量子纠缠" | **OBSERVE：仍返回 3 条（top1 分数 0.089）——真实 embedding 下所有文本对相似度非零，minScore=0 过滤不了弱相关；空结果契约需业务质量阈值（建议评估 MIN_RELEVANCE_SCORE=0.2 作为默认下限）** |

结论：F05/F09 修复 + field 策略在真实 OpenRouter 向量下语义检索可用；同义改写命中验证通过。遗留：行级聚合（F07）、生产默认质量阈值、真实环境召回质量基线（按 rag evaluation-rubric 的 L2 体系补测）。
