# 沙箱文件管理 API：创建目录 / 创建文件 / 下载 / 上传 / 删除 / 搜索

> 仅适用于 opencode SaaS。验证 `POST /session/:id/files/mkdir`、`POST /session/:id/files/create`、`GET /session/:id/files/download`、`POST /session/:id/files/upload`、`POST /session/:id/files/remove` 五个 sandbox-proxy 接口，以及 `GET /find/file` 文件搜索接口（实现于 `packages/opencode/src/server/sandbox-proxy.ts` 和 `packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts`）。
> 环境变量 `$BASE $PG_URL $MODEL` 由 `test-env.sh` 提供；本组用例不依赖 `$MODEL`（不经 AI 消息）。

```bash
source docs/test-cases/test-env.sh 1   # 或 3（本地 OpenSandbox）
source docs/test-cases/test-lib.sh
export NO_PROXY="$NO_PROXY,localhost,127.0.0.1"
```

---

## 一、创建目录 `POST /session/:sessionID/files/mkdir`

### T-FILE-01 多级目录创建（懒创建）

**验证点**：mkdir 接口自动创建沙箱（懒），多级目录一次递归创建。

```bash
SID=$(new_sid -k)
curl -s --noproxy '*' -m 120 -X POST "$BASE/session/$SID/files/mkdir?path=/workspace/project/src/utils" | python3 -m json.tool
# 期望: {"sessionID":"...","path":"/workspace/project/src/utils","created":true}

curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"[ -d /workspace/project/src/utils ] && echo exists || echo missing"}' \
  | python3 -c "import json,sys;print('dir:', json.load(sys.stdin,strict=False)['stdout'].strip())"
```

**期望**：返回 `created:true`；沙箱内 `test -d` 通过。

### T-FILE-02 幂等（重复创建不报错）

```bash
test "$(curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/mkdir?path=/workspace/project/src/utils" -o /dev/null -w '%{http_code}')" = 200
```

**期望**：已存在目录再次 mkdir 返回 200（幂等）。

### T-FILE-03 参数校验

```bash
test "$(curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/mkdir" -o /dev/null -w '%{http_code}')" = 400
```

**期望**：缺 `path` 返回 400。相对路径 `path=relative/path` 会被 `toSandboxPath` 映射到 `/workspace/relative/path`（与 exec 的 workingDirectory 语义一致），属于正常创建，不返回 400。

### T-FILE-04 特殊字符目录名

```bash
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/mkdir?path=/workspace/空 格 'dir' 目录" \
  -o /dev/null -w '%{http_code}'
curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"[ -d \"/workspace/空 格 '\''dir'\'' 目录\" ] && echo exists || echo missing"}' \
  | python3 -c "import json,sys;print('dir:', json.load(sys.stdin,strict=False)['stdout'].strip())"
```

**期望**：空格/中文/单引号目录名创建成功，沙箱内 `test -d` 通过（验证 shellQuote 转义正确）。

### T-FILE-05 边界与错误路径

**验证点**：四个接口对不存在 session 返回 404；类型冲突路径返回明确错误；download 缺 path 返回 400。

```bash
# 1) session 不存在 → 404（四个接口）
for ep in "files/mkdir?path=/workspace/x" "files/create?path=/workspace/x.txt" \
          "files/download?path=/workspace/x.txt" "files/upload?path=/workspace&filename=x.txt"; do
  case "$ep" in
    files/download*) METHOD="" ;;
    *) METHOD="-X POST --data-binary x" ;;
  esac
  test "$(curl -s --noproxy '*' -m 10 -o /dev/null -w '%{http_code}' $METHOD \
    "$BASE/session/ses_nonexistent/$ep")" = 404
done

# 2) mkdir 到已存在文件路径 → 502
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/create?path=/workspace/afile" --data-binary 'x' >/dev/null
test "$(curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/mkdir?path=/workspace/afile" -o /dev/null -w '%{http_code}')" = 502

# 3) create 到已存在目录路径 → 502 且目录不破坏
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/vdir && echo inner > /workspace/vdir/inner.txt","timeoutSeconds":30}' >/dev/null
test "$(curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/create?path=/workspace/vdir" --data-binary 'x' -o /dev/null -w '%{http_code}')" = 502
test "$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"[ -d /workspace/vdir ] && cat /workspace/vdir/inner.txt || echo dir-lost"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin,strict=False)['stdout'].strip())")" = 'inner'

# 4) download 缺 path → 400
test "$(curl -s --noproxy '*' -m 10 -o /dev/null -w '%{http_code}' "$BASE/session/$SID/files/download")" = 400
```

**期望**：session 不存在统一 404；`mkdir` 打在文件上 502（`not a directory`）；`create` 打在目录上 502 且原目录内容不受影响；缺 `path` 400。

---

## 二、创建文件 `POST /session/:sessionID/files/create`

### T-FILE-10 创建文本文件（父目录自动创建）

```bash
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/create?path=/workspace/project/src/app.py" \
  --data-binary 'print("hello")' | python3 -m json.tool
# 期望: {"sessionID":"...","path":"/workspace/project/src/app.py","size":14,"created":true}

test "$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/project/src/app.py"}' | python3 -c "import json,sys;print(json.load(sys.stdin,strict=False)['stdout'])")" = 'print("hello")'
```

**期望**：返回 `size=14`（`print("hello")` 恰为 14 字节）；内容逐字节一致；`src` 目录自动创建。

### T-FILE-11 创建空文件

```bash
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/create?path=/workspace/project/empty.txt" \
  -d '' | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['size']==0 and d['created'] is True, d; print('empty file ok')"
```

### T-FILE-12 覆盖写

```bash
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/create?path=/workspace/project/src/app.py" \
  --data-binary 'print("v2")' >/dev/null
test "$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/project/src/app.py"}' | python3 -c "import json,sys;print(json.load(sys.stdin,strict=False)['stdout'])")" = 'print("v2")'
```

### T-FILE-13 二进制内容 + 参数校验

```bash
head -c 4096 /dev/urandom > /tmp/files-create.bin
C_SHA=$(shasum -a 256 /tmp/files-create.bin | awk '{print $1}')
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/create?path=/workspace/project/data.bin" \
  --data-binary @/tmp/files-create.bin >/dev/null
SRC=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"sha256sum /workspace/project/data.bin"}' | python3 -c "import json,sys;print(json.load(sys.stdin,strict=False)['stdout'].split()[0])")
test "$C_SHA" = "$SRC"

test "$(curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/create" --data-binary x -o /dev/null -w '%{http_code}')" = 400
```

**期望**：二进制内容 SHA 一致；缺 `path` 返回 400（相对路径会被映射到 `/workspace/` 下，正常创建）。

### T-FILE-14 特殊字符文件名 + 未知扩展名下载

```bash
# 中文/空格/单引号文件名创建并下载
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/create?path=/workspace/project/测试 文档'txt" \
  --data-binary '你好 world' >/dev/null
curl -s --noproxy '*' -m 30 -D /tmp/files-special.headers \
  "$BASE/session/$SID/files/download?path=/workspace/project/测试 文档'txt" -o /tmp/files-special.txt
grep -qi "^content-disposition: attachment; filename=\"download\"; filename\*=UTF-8''" /tmp/files-special.headers
test "$(cat /tmp/files-special.txt)" = '你好 world'

# 未知扩展名 → application/octet-stream fallback
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/create?path=/workspace/project/blob.xyzabc" \
  --data-binary 'raw' >/dev/null
curl -s --noproxy '*' -m 30 -D /tmp/files-fallback.headers \
  "$BASE/session/$SID/files/download?path=/workspace/project/blob.xyzabc" -o /dev/null
grep -qi "^content-type: application/octet-stream" /tmp/files-fallback.headers

# PDF → application/pdf
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/create?path=/workspace/project/doc.pdf" \
  --data-binary '%PDF-1.4' >/dev/null
curl -s --noproxy '*' -m 30 -D /tmp/files-pdf.headers \
  "$BASE/session/$SID/files/download?path=/workspace/project/doc.pdf" -o /dev/null
grep -qi "^content-type: application/pdf" /tmp/files-pdf.headers
```

**期望**：中文/空格/单引号文件名下载正常（`filename*=UTF-8''` URL 编码，内容一致）；未知扩展名回退 `application/octet-stream`；PDF 返回 `application/pdf`。

---

## 三、下载 `GET /session/:sessionID/files/download`

### T-FILE-20 单文件下载字节完整性与 Content-Type

**验证点**：不同格式文件下载，Content-Type 按扩展名推断（mime-types），字节完整。

```bash
# 准备多格式夹具
curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/fmt && echo hi > /workspace/fmt/note.txt && printf \"%s\" \"{\\\"a\\\":1}\" > /workspace/fmt/data.json && head -c 100 /dev/urandom > /workspace/fmt/img.png","timeoutSeconds":30}' >/dev/null

check_ct() {  # 期望: $1=path $2=mime
  local got=$(curl -s --noproxy '*' -m 30 -D /tmp/files-ct.headers "$BASE/session/$SID/files/download?path=$1" -o /dev/null)
  local ct=$(python3 -c "
import re
h=open('/tmp/files-ct.headers').read()
m=re.search(r'^Content-Type:\s*(\S+)', h, re.I|re.M)
print(m.group(1) if m else '')
")
  test "$ct" = "$2"
}
check_ct "/workspace/fmt/note.txt" "text/plain"
check_ct "/workspace/fmt/data.json" "application/json"
check_ct "/workspace/fmt/img.png" "image/png"

curl -s --noproxy '*' -m 30 -D /tmp/files-dl.headers "$BASE/session/$SID/files/download?path=/workspace/fmt/note.txt" -o /tmp/files-dl.txt
grep -qi '^content-disposition: attachment;' /tmp/files-dl.headers
grep -qi '^content-length:' /tmp/files-dl.headers
test "$(cat /tmp/files-dl.txt)" = 'hi'
python3 - <<'PY'
import re
h = open('/tmp/files-dl.headers').read()
m = re.search(r'^Content-Length:\s*(\d+)', h, re.I | re.M)
assert m, 'no content-length'
assert int(m.group(1)) == len(open('/tmp/files-dl.txt', 'rb').read()), 'content-length mismatch'
PY
```

**期望**：`note.txt→text/plain`、`data.json→application/json`、`img.png→image/png`；`Content-Disposition: attachment`，`filename*` 为 URL 编码文件名，`Content-Length` 与实际下载字节数一致。

### T-FILE-21 目录打包下载（统一 zip）

**验证点**：目录始终打包为 zip（不依赖系统 zip 命令），含子目录与空目录根条目。

```bash
curl -s --noproxy '*' -m 180 -D /tmp/files-zip.headers "$BASE/session/$SID/files/download?path=/workspace/fmt" -o /tmp/files-archive.zip
python3 - <<'PY'
import re
h = open('/tmp/files-zip.headers').read()
m = re.search(r'^Content-Type:\s*(\S+)', h, re.I | re.M)
assert m and m.group(1) == 'application/zip', m.group(1) if m else 'no CT'
m = re.search(r'^Content-Length:\s*(\d+)', h, re.I | re.M)
assert m, 'no content-length'
assert int(m.group(1)) == len(open('/tmp/files-archive.zip', 'rb').read()), 'content-length mismatch'
import zipfile
z = zipfile.ZipFile('/tmp/files-archive.zip')
names = sorted(z.namelist())
assert any(n.endswith('note.txt') for n in names), names
assert any(n.endswith('data.json') for n in names), names
assert any(n.endswith('img.png') for n in names), names
print('zip ok:', names)
PY

# 空目录也含根条目
curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID/files/mkdir?path=/workspace/emptydir" >/dev/null
curl -s --noproxy '*' -m 120 "$BASE/session/$SID/files/download?path=/workspace/emptydir" -o /tmp/files-empty.zip
python3 -c "import zipfile; z=zipfile.ZipFile('/tmp/files-empty.zip'); names=z.namelist(); assert 'emptydir/' in names, names; print('empty dir zip ok:', names)"
```

### T-FILE-22 下载 404

```bash
test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$BASE/session/$SID/files/download?path=/workspace/no-such-file")" = 404
```

---

## 四、上传 `POST /session/:sessionID/files/upload`

### T-FILE-30 上传文件（目录自动创建）

```bash
printf 'upload-content-123' > /tmp/files-up.txt
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/upload?path=/workspace/inbox/nested&filename=up.txt" \
  --data-binary @/tmp/files-up.txt | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['size']==18, d; print('upload ok', d['path'])"

test "$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/inbox/nested/up.txt"}' | python3 -c "import json,sys;print(json.load(sys.stdin,strict=False)['stdout'])")" = 'upload-content-123'
```

### T-FILE-31 二进制上传 + 回环一致性

```bash
head -c 1048576 /dev/urandom > /tmp/files-up.bin
UP_SHA=$(shasum -a 256 /tmp/files-up.bin | awk '{print $1}')
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/upload?path=/workspace/inbox&filename=big.bin" \
  --data-binary @/tmp/files-up.bin | python3 -c "import json,sys; assert json.load(sys.stdin)['size']==1048576, 'size'; print('upload 1MB ok')"

curl -s --noproxy '*' -m 60 "$BASE/session/$SID/files/download?path=/workspace/inbox/big.bin" -o /tmp/files-loop.bin
test "$(shasum -a 256 /tmp/files-loop.bin | awk '{print $1}')" = "$UP_SHA"
```

### T-FILE-32 上传参数校验

```bash
test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST "$BASE/session/$SID/files/upload?path=/workspace&filename=a/b.txt" --data-binary @/tmp/files-up.txt)" = 400
test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST "$BASE/session/$SID/files/upload?path=/workspace" --data-binary @/tmp/files-up.txt)" = 400
test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST "$BASE/session/$SID/files/upload?path=/workspace&filename=ok.txt" -d '')" = 200
```

### T-FILE-33 上传覆盖写 + path 缺省 + 危险 filename

```bash
# 覆盖写：同路径二次上传内容替换
printf 'v1' > /tmp/files-ow.txt
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/upload?path=/workspace/ow&filename=file.txt" \
  --data-binary @/tmp/files-ow.txt >/dev/null
printf 'v2-longer' > /tmp/files-ow.txt
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/upload?path=/workspace/ow&filename=file.txt" \
  --data-binary @/tmp/files-ow.txt >/dev/null
test "$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/ow/file.txt"}' | python3 -c "import json,sys;print(json.load(sys.stdin,strict=False)['stdout'])")" = 'v2-longer'

# path 缺省 → 默认 /workspace
printf 'rootfile' > /tmp/files-root.txt
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/upload?filename=root.txt" \
  --data-binary @/tmp/files-root.txt | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['path']=='/workspace/root.txt', d; print('default path ok')"

# 危险 filename 拒绝：含 /（含 URL 编码）
test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST "$BASE/session/$SID/files/upload?path=/workspace&filename=a/b.txt" --data-binary x)" = 400
test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST "$BASE/session/$SID/files/upload?path=/workspace&filename=..%2Fescape.txt" --data-binary x)" = 400
test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST "$BASE/session/$SID/files/upload?path=/workspace&filename=bad%00file.txt" --data-binary x)" = 400
```

**期望**：同路径覆盖写生效；`path` 缺省时文件落在 `/workspace`；`filename` 含 `/`、URL 编码 `..%2F`、空字节均返回 400。

### T-FILE-34 upload 特殊字符 filename

```bash
printf 'sp' > /tmp/files-sp.txt
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/upload?path=/workspace&filename=测 试'file.txt" \
  --data-binary @/tmp/files-sp.txt | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['path']=='/workspace/测 试\'file.txt', d; print('upload special ok')"
curl -s --noproxy '*' -m 30 "$BASE/session/$SID/files/download?path=/workspace/测 试'file.txt" -o /tmp/files-sp2.txt
test "$(cat /tmp/files-sp2.txt)" = 'sp'
```

**期望**：中文/空格/单引号 filename 上传成功，下载回环内容一致。

### T-FILE-35 filename 拒绝 `.` / `..`

```bash
test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST "$BASE/session/$SID/files/upload?path=/workspace&filename=." --data-binary x)" = 400
test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X POST "$BASE/session/$SID/files/upload?path=/workspace&filename=.." --data-binary x)" = 400
```

**期望**：`.` / `..` 作为 filename 直接返回 400（路径穿越语义拒绝，不落到 502）。

---

## 五、横切行为

### T-FILE-40 exec_log 审计记录

```bash
psql "$PG_URL" -t -A -c "
  SELECT source, count(*) FROM exec_log
  WHERE session_id='$SID' AND source IN ('file-mkdir','file-create','file-download','file-upload')
  GROUP BY source ORDER BY source;
"
```

**期望**：四种 source 各至少 1 条，`command` 字段为 JSON（含 path/size 等），`status=completed`。

### T-FILE-41 目录打包临时文件清理

```bash
test "$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"ls /tmp | grep -c \"^oc-dl-\" || true"}' | python3 -c "import json,sys;print(json.load(sys.stdin,strict=False)['stdout'].strip())")" = 0
```

### T-FILE-42 沙箱重建后文件接口仍可用（PVC 持久）

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/kill-sandbox" >/dev/null
curl -s --noproxy '*' -m 180 -X POST "$BASE/session/$SID/keep-alive" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"boot":true}' >/dev/null

curl -s --noproxy '*' -m 120 "$BASE/session/$SID/files/download?path=/workspace/inbox/big.bin" -o /tmp/files-loop2.bin
test "$(shasum -a 256 /tmp/files-loop2.bin | awk '{print $1}')" = "$UP_SHA"
```

**期望**：kill-sandbox 后重建，PVC 中上传的文件经下载接口仍可完整取回。

### T-FILE-43 host 形式路径兼容

```bash
DIR=$(psql "$PG_URL" -t -A -c "SELECT directory FROM session WHERE id='$SID'")
test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$BASE/session/$SID/files/download?path=$DIR/inbox/big.bin")" = 200
```

### T-FILE-44 app 模式 PVC（跨 session 共享卷）

**验证点**：`pvcMode=app` + `appId` 的 session，文件接口挂 `apps/{appId}` 共享 subPath，同 appId 的不同 session 看到同一文件。

```bash
SID_APP1=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"pvcMode":"app","appId":"files-api-app-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' -m 180 -X POST "$BASE/session/$SID_APP1/keep-alive" -H 'Content-Type: application/json' \
  -d '{"enabled":true,"boot":true}' >/dev/null

printf 'app-shared' > /tmp/files-app.txt
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID_APP1/files/upload?path=/workspace&filename=shared.txt" \
  --data-binary @/tmp/files-app.txt >/dev/null

# 第二个同 appId 的 session 应读到同一文件
SID_APP2=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"pvcMode":"app","appId":"files-api-app-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' -m 120 "$BASE/session/$SID_APP2/files/download?path=/workspace/shared.txt" -o /tmp/files-app2.txt
test "$(cat /tmp/files-app2.txt)" = 'app-shared'

# 清理 app sessions
curl -s --noproxy '*' -X POST "$BASE/session/$SID_APP1/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null
curl -s --noproxy '*' -X POST "$BASE/session/$SID_APP2/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null
curl -s --noproxy '*' -X POST "$BASE/session/$SID_APP1/kill-sandbox" >/dev/null
curl -s --noproxy '*' -X POST "$BASE/session/$SID_APP2/kill-sandbox" >/dev/null
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID_APP1" >/dev/null
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID_APP2" >/dev/null
```

**期望**：app 模式下两个 session 的文件接口共享同一 PVC subPath，跨 session 读到同一文件。

---

## 六、删除 `POST /session/:sessionID/files/remove`

### T-FILE-50 删除单个文件

```bash
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/create?path=/workspace/delete-me.txt" \
  --data-binary 'to-be-deleted' >/dev/null

curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/remove?path=/workspace/delete-me.txt" \
  | python3 -m json.tool
# 期望: {"sessionID":"...","path":"/workspace/delete-me.txt","removed":true,"type":"file"}

test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' \
  "$BASE/session/$SID/files/download?path=/workspace/delete-me.txt")" = 404
```

**期望**：返回 `removed:true`、`type:file`；删除后 download 返回 404。

### T-FILE-51 递归删除目录

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/rmdir/sub && touch /workspace/rmdir/sub/a.txt && touch /workspace/rmdir/sub/b.txt"}' >/dev/null

curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/remove?path=/workspace/rmdir" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['removed'] and d['type']=='directory', d; print('dir removed ok')"

test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' \
  "$BASE/session/$SID/files/download?path=/workspace/rmdir")" = 404
```

**期望**：目录递归删除成功，子目录和文件全部清除。

### T-FILE-52 不存在路径返回 404

```bash
test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/session/$SID/files/remove?path=/workspace/no-such-file")" = 404
```

### T-FILE-53 参数校验

```bash
test "$(curl -s --noproxy '*' -m 10 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/session/$SID/files/remove")" = 400
```

### T-FILE-54 session 不存在返回 404

```bash
test "$(curl -s --noproxy '*' -m 10 -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/session/ses_nonexistent/files/remove?path=/workspace/x")" = 404
```

### T-FILE-55 删除后 exec_log 审计

```bash
psql "$PG_URL" -t -A -c "
  SELECT command FROM exec_log
  WHERE session_id='$SID' AND source='file-remove'
  ORDER BY time_created;
"
```

**期望**：至少一条 `source=file-remove` 记录，`command` 为 JSON（含 path 和 type）。

---

## 八、文件搜索 `GET /find/file`

> 实现于 `packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts`（HttpApi 路由，与 sandbox-proxy 同端口）。沙箱内搜索走 `rg --files --hidden | grep -iF` + `find -type d | grep -iF`，返回结构化条目。

### T-FILE-60 文件名搜索

```bash
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/files/create?path=/workspace/auth-middleware.ts" \
  --data-binary 'export function auth() {}' >/dev/null

curl -s --noproxy '*' -m 30 "$BASE/find/file?sessionID=$SID&query=auth&type=file" \
  | python3 -m json.tool
# 期望: [{"name":"auth-middleware.ts","path":"auth-middleware.ts","absolute":"/workspace/auth-middleware.ts","type":"file","ignored":false}]
```

**期望**：返回包含 `auth-middleware.ts` 的 LegacyEntry 数组，`name`/`path`/`absolute`/`type`/`ignored` 字段完整。

### T-FILE-61 隐藏文件搜索

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"touch /workspace/.env /workspace/.gitignore"}' >/dev/null

curl -s --noproxy '*' -m 30 "$BASE/find/file?sessionID=$SID&query=.env&type=file" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); assert any(e['name']=='.env' for e in d), d; print('hidden file found ok')"
```

**期望**：`rg --files --hidden` 包含 `.env` 等隐藏文件，搜索结果中能匹配到。

### T-FILE-62 目录搜索

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/sub/dir"}' >/dev/null

curl -s --noproxy '*' -m 30 "$BASE/find/file?sessionID=$SID&query=sub&dirs=true" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); assert any(e['type']=='directory' for e in d), d; print('dir search ok')"
```

**期望**：`dirs=true` 时返回目录条目，`type` 为 `"directory"`。

### T-FILE-63 无匹配返回空数组

```bash
test "$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' \
  "$BASE/find/file?sessionID=$SID&query=zzz_nonexistent_zzz&type=file")" = 200
test "$(curl -s --noproxy '*' "$BASE/find/file?sessionID=$SID&query=zzz_nonexistent_zzz&type=file")" = '[]'
```

### T-FILE-64 返回结构化 LegacyEntry

```bash
ENTRY=$(curl -s --noproxy '*' "$BASE/find/file?sessionID=$SID&query=auth&type=file" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if d:
    e=d[0]
    assert 'name' in e and 'path' in e and 'absolute' in e and 'type' in e and 'ignored' in e, e
    assert e['type'] in ('file','directory'), e
    print('valid entry')
")
test "$ENTRY" = 'valid entry'
```

**期望**：每条结果包含 `name`、`path`、`absolute`、`type`、`ignored` 五个字段，`type` 取值 `"file"` 或 `"directory"`。

---

## 九、清理

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null
curl -s --noproxy '*' -X POST "$BASE/session/$SID/kill-sandbox" >/dev/null
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID" >/dev/null
rm -f /tmp/files-dl.headers /tmp/files-dl.txt /tmp/files-ct.headers /tmp/files-zip.headers /tmp/files-archive.zip \
  /tmp/files-up.txt /tmp/files-up.bin /tmp/files-create.bin /tmp/files-loop.bin /tmp/files-loop2.bin /tmp/files-empty.zip \
  /tmp/files-special.headers /tmp/files-special.txt /tmp/files-fallback.headers /tmp/files-pdf.headers \
  /tmp/files-ow.txt /tmp/files-root.txt /tmp/files-app.txt /tmp/files-app2.txt /tmp/files-sp.txt /tmp/files-sp2.txt
summary
```

---

## 验收汇总

| 编号 | 能力 | 通过标准 |
|---|---|---|
| T-FILE-01~05 | 创建目录 | 多级递归、幂等、参数校验 400、特殊字符目录名、边界/错误路径（404/502/目录不破坏） |
| T-FILE-10~14 | 创建文件 | 内容逐字节一致、空文件、覆盖写、二进制、特殊字符/未知扩展名、参数校验 |
| T-FILE-20~22 | 下载 | 多格式 Content-Type（mime-types）、字节完整、Content-Length 一致、目录统一 zip（含空目录根条目）、404 |
| T-FILE-30~35 | 上传 | 目录自动创建、二进制完整、覆盖写、path 缺省、特殊字符 filename、`.`/`..` 拒绝、危险 filename 拒绝 |
| T-FILE-40~44 | 横切 | exec_log 审计、临时文件清理、PVC 持久、host 路径兼容、app 模式共享卷 |
| T-FILE-50~55 | 删除 | 文件删除、目录递归删除、不存在返回 404、参数校验、session 不存在 404、exec_log 审计 |
| T-FILE-60~64 | 文件搜索 | 文件名搜索、隐藏文件搜索、目录搜索、无匹配空数组、LegacyEntry 结构化响应 |

## 复测记录

| 日期 | 环境 | 结果 | 备注 |
|---|---|---|---|
| 2026-08-19 | 本地 PG + 远程沙箱（组合 1 沙箱 + 组合 3 PG） | PASS | T-FILE-01~44 全过（24 个用例 PASS / 0 FAIL）；含 T-FILE-05/34/35 边界用例、Content-Length 一致性断言、`filename=.`/`..` 400 校验 |
