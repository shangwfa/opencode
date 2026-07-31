# Read 工具多格式与受管附件测试用例

本文验证 `read` 工具的字节级文件分类、文本分页、Sandbox PVC 附件持久化、稳定下载 URL、Range 响应、模型投影安全和 PostgreSQL payload 安全。

## 1. 测试范围

- UTF-8 文本、空文件、SVG 和非法 UTF-8。
- PNG、PDF 和 Office 文件附件化。
- 已知二进制和超限媒体拒绝。
- 附件 URL、MIME、文件名、Content-Disposition、ETag 和 Range。
- Sandbox 重建后附件仍可下载。
- ToolPart、事件和 API 响应不持久化 Base64 或原始二进制。
- 模型投影缺少 SandboxProvider 时不泄露内部附件 URL。

## 2. 前置条件

从仓库根目录执行。环境应为本地 PostgreSQL + 本地 OpenSandbox：

```bash
source docs/test-cases/test-env.sh 3
source docs/test-cases/test-lib.sh

export BASE=http://127.0.0.1:14096
export PG_URL=postgresql://local@127.0.0.1:15432/opencode
export NO_PROXY=localhost,127.0.0.1

curl -sS "$BASE/" -o /dev/null -w 'SaaS HTTP %{http_code}\n'
curl -sS http://127.0.0.1:8080/health
psql "$PG_URL" -Atc 'select current_user, current_database()'
docker image inspect opencode-opensandbox:local --format '{{.Id}}'
```

期望：

- SaaS 返回 HTTP 200。
- OpenSandbox 返回 `{"status":"healthy"}`。
- PostgreSQL 返回 `local|opencode`。
- 本地 Sandbox 镜像存在。
- SaaS 镜像已包含待测代码，而不是修改前的旧镜像。

## 3. 公共测试函数

```bash
SID=$(new_sid -kb)
export SID
echo "SID=$SID"

exec_cmd() {
  local command="$1"
  local payload
  payload=$(python3 -c 'import json,sys; print(json.dumps({"command":sys.argv[1],"workingDirectory":"/workspace","timeoutSeconds":60}))' "$command")
  curl -sS --max-time 90 -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' \
    -d "$payload"
}

read_file() {
  local file="$1"
  local prompt="只调用 read 工具读取 $file，不要调用其他工具。"
  local payload
  payload=$(python3 -c 'import json,sys; print(json.dumps({"parts":[{"type":"text","text":sys.argv[1]}],"model":json.loads(sys.argv[2])}))' "$prompt" "$MODEL")
  curl -sS --max-time 180 -X POST "$BASE/session/$SID/message" \
    -H 'Content-Type: application/json' \
    -d "$payload" > /tmp/read-last-response.json
}

latest_read_state() {
  curl -sS "$BASE/session/$SID/message" | python3 -c '
import json,sys
messages=json.load(sys.stdin, strict=False)
states=[part["state"] for message in messages for part in message.get("parts",[]) if part.get("type")=="tool" and part.get("tool")=="read"]
if not states: raise SystemExit("no read tool state found")
print(json.dumps(states[-1]))
'
}

state_value() {
  local expression="$1"
  latest_read_state | python3 -c "import json,sys; d=json.load(sys.stdin); print($expression)"
}
```

## 4. 创建文件夹具

```bash
exec_cmd "mkdir -p /workspace/read-fixtures && printf 'alpha\nbeta\ngamma\n' > /workspace/read-fixtures/text.txt && : > /workspace/read-fixtures/empty.txt"

exec_cmd "printf '<svg xmlns=\"http://www.w3.org/2000/svg\"><rect width=\"1\" height=\"1\"/></svg>\n' > /workspace/read-fixtures/vector.svg"

exec_cmd "printf 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC%2BaJAAAoVElEQVR4nAXBcWTkCMMw8HiN13iMxzjjjDPOWGPFihUrVqxYsaKioqKioqKioqKioqKioqKioqKioqKioqKioqJixYoVK1asWLHGGmecccYZZzzGY7zGZ/74fj8AAIAG8D9NoNEC/rcNNDvAv7pAqwf8uw%2B0B8AvINCBgF9hoIsAv6FADwN%2Bx4E%2BAbwggQEFvKQBkAFesQDEAa95ABaANyKASMBbGUAV4J0KYBrwXgdwA/hgAoQFbNgA6QCbLkB5wJYP0AGwHQJMBOzEAJsAuynAZcBeDvAFsF8CQgUc1IA4BA5HgDQGjiaAPAWOZ4AyB04WgLoETleAtgbOAKDxP41Go9n431aj2W78q9NodRv/7jXa/cYvg0YHbPwKNbpw4zek0UMbv2ONPt54QTQGZOMl1QDpxiumAbGN11wD5htvhAYiNt5KDVRuvFMamNp4rzVwvfHBaBBmY8NqkHZj02lQbmPLa9B%2BYztoMGFjJ2qwcWM3aXBpYy9r8Hljv2gIZeOgaoh143DYkEaNo3FDnjSOpw1l1jiZN9RF43TZ0FaNs3VDB4Bmo9H832az2Wr%2Bq91sdZr/7jbbveYv/WZn0PwVbHah5m9ws4c0f0ebfaz5Am8OiOZLsglSzVd0E2Kar9kmzDXf8E1EaL4Vm6jUfCc3MaX5Xm3iWvOD3iSM5obZJK3mpt2knOaW26S95rbfZILmTthko%2BZu3OSS5l7a5LPmft4UiuZB2RSr5mHdlIbNo1FTHjePJ01l2jyZNdV583TR1JbNs1VTXzfPAaD1v41Ws9n6V6vVarf%2B3Wm1u61feq1Ov/XroNUFW79BrR7c%2Bh1p9dHWC6w1wFsviRZItl5RLYhuvWZaMNt6w7UQvvVWaKFi653UwuTWe6WFq60PWovQWxtGizRbm1aLsltbTot2W9tei/FbO0GLDVu7UYuLW3tJi09b%2B1lLyFsHRUssW4dVS6pbR8OWPGodj1vKpHUybamz1um8pS1aZ8uWvmqdr1sGALSbjfa/mu1Wq/3vdrvdaf/SbXd67V/77e6g/RvY7kHt3%2BF2H2m/QNsDrP0Sb4NE%2BxXZhqj2a7oNM%2B03bBvh2m/5Niq034ltTGq/l9u40v6gtgmtvaG3SaO9abYpq71lt2mnve22Ga%2B947fZoL0btrmovRe3%2BaS9n7aFrH2Qt8WifVi2pap9VLflYft41FbG7ZNJW522T2dtbd4%2BW7T1Zft81TbW7QsA6Pyr0Wk1O/9uddrtzi%2BdTqfb%2BbXX6fY7vw06PbDzO9Tpw50XSGeAdl5iHRDvvCI6ENl5TXVguvOG6SBs5y3XQfnOO6GDiZ33UgeXOx%2BUDqF2NrQOqXc2jQ5ldrasDm13tp0O43Z2vA7rd3aDDhd29qIOH3f2k46Qdg6yjph3DouOVHaOqo5cd46HHWXUORl31EnndNrRZp2zeUdfdM6XHWPVuVh3TADothrdfze77Vb3l3a30%2Bn%2B2u12e93f%2Bt3eoPs72O1D3Rdwd4B0X6JdEOu%2BwrsQ0X1NdmGq%2B4buIkz3LdtFue47vosJ3fdiF5e6H%2BQuoXQ31C6pdTf1LmV0t8wubXW37S7jdHfcLut1d/0uF3T3wi4fdfbjrpB0D9KumHUP865UdI/Krlx1j%2BuuMuyejLrquHs66WrT7tmsq8%2B754uusexerLrmunsJAL1/N3rtZu%2BXVq/T7v3a6XW7vd96vV6/9/ug1wd7L6DeAO69RHog2nuF9SC895rowWTvDdVD6N5bpoeyvXdcD%2BN774UeLvY%2BSD1C7m0oPVLtbWo9Su9tGT3a7G1bPcbu7Tg91u3tej3O7%2B0FPT7s7Uc9Ie4dJD0x7R1mPSnvHRU9uewdVz2l7p0Me%2BqodzruaZPe2bSnz3rn856x6F0se%2Baqd7nuWQDQbzf6vzT7nVb/13a/2%2Bn/1u33ev3f%2B3/4P8C7A%2Bg/ku4DyL9V2gfwvqv8T5M9N%2BQfYTqv6X7KNN/x/Yxrv%2Be7%2BNC/4PYJ6T%2Bhtwnlf6m2qe0/pbep43%2BttlnrP6O3Wed/q7b57z%2Bnt/ng/5%2B2Bei/kHcF5P%2BYdqXsv5R3peL/nHZV6r%2BSd1Xh/3TUV8b988mfX3aP5/1jXn/YtE3l/3LVd9a968AYPBLY9BpDn5tDbrtwW%2BdQa87%2BL036PcHLwaDATh4CQ1AePAKGUDo4DU2gPHBG2KAkIO31AClB%2B%2BYAcYO3nMDnB98EAaEONiQBqQ82FQGlDrY0ga0Ptg2Bow52LEGrD3YdQacO9jzBrw/2A8GQjg4iAZiPDhMBlI6OMoGcj44LgZKOTipBmo9OB0OtNHgbDzQJ4Pz6cCYDS7mA3MxuFwOrNXgaj2wAQDsNMBfm2C3Bf7WBnsd8Pcu2O%2BBL/rgYAC%2BBEEQAl/BIISAr1EQxsA3OIgQ4FsSRCnwHQ1iDPieBXEO/ACDhABuiCApgZsySCnglgrSGritg4wB7pgga4G7Nsg54J4L8h6474NCAB6EoBiBhzEoJeBRCsoZeJyDSgGelKBagac1qA3BsxGoj8HzCWhMwYsZaM7BywVoLcGrFWivwWsAgH5tQN0m9FsL6rWh3ztQvwu96EGDPvRyAIEg9AqCIBh6jUAwCr3BIASH3hIQSkLvKAijofcMhLPQBw4ieGhDgEgR2pQgSoa2FIhWoW0NYnRox4BYE9q1IM6G9hyId6F9DxJ86CCAxBA6jCApho4SSE6h4wxScuikgNQSOq0grYbOhpA%2Bgs7HkDGBLqaQOYMu55C1gK6WkL2CrteQAwBwtwH/1oR7Lfj3NtzvwC%2B68KAHv%2BzD4AB%2BBcIQBL%2BGYRiB36AwgsFvcRgl4HckjFHwexrGGfgDCxMcvMHDpABvijAlwVsyTCvwtgozGryjw6wB75owZ8F7Nsw78L4LCx584MNiAB%2BGsBTBRzEsJ/BxCisZfJLDagGflrBWwWc1rA/h8xFsjOGLCWxO4csZbM3hqwVsL%2BHrFeys4RsAQH5rIL0m8nsL6beRFx1k0EVe9hCwj7waIBCIvIYQGEbeIAiCIm8xBMWRdwSCkch7CsFp5AODECyywSEkj2wKCCUiWxJCy8i2gjAqsqMhrI7sGghnInsWwtvIvoMILnLgIaKPHAaIFCJHESLHyHGCKClykiFqjpwWiFYiZxWi18j5EDFGyMUYMSfI5RSxZsjVHLEXyPUScVbIzRpxAQDtNdDfm2i/hb5oo4MO%2BrKLgj30VR%2BFBuhrEIUh9A2MIgj6FkVRDH2HoxiBvidRnEI/0CjBoBssSnLoJo9SArolorSEbssoo6A7Kspq6K6Ocga6Z6K8he7bqOCgBy4qeuihj0oBehSicoQex6iSoCcpqmboaY5qBXpWonqFnteoMUQvRqg5Ri8nqDVFr2aoPUevF6izRG9WqLtGbwEA%2B72B9ZvYixY2aGMvOxjYxV71MKiPvR5gMIi9gTAExt4iGIpi7zAMw7H3BIaT2AcKI2hsg8FIFtvkMIrHtgSMFrFtCWNkbEfBWBXb1TBOx/YMjDexfQsTbOzAwUQXO/QwyceOAkwOseMIU2LsJMHUFDvNMC3HzgpML7HzCjNq7GKImSPscoxZE%2Bxqitkz7HqOOQvsZom5K%2Bx2jXkAgPcb%2BIsmPmjhL9s42MFfdXGoh7/u4/AAfwPiCIS/hXEUwd%2BhOIbh73EcJ/APJE5Q%2BAaNkwy%2ByeIUh2/xOC3g2yLOSPiOjLMKvqvinIbv6Thv4PsmLlj4gY2LDn7o4pKHH/m4HODHIa5E%2BEmMqwl%2BmuJahp/luF7g5yVuVPhFjZtD/HKEW2P8aoLbU/x6hjtz/GaBu0v8doV7a/wOAIgXDWLQJF62CLBNvOoQUJd43SPgPvFmQCAg8RYiUJh4hxAYSrzHCBwnPhAEQRIbFEHSxCZDUCyxxRE0T2wLBCMSOxLBysSuQnAqsacRvE7sG4RgEgcWIdrEoUNILnHkEbJPHAeEEhInEaHGxGlCaClxlhF6TpwXhFESFxVh1sTlkLBGxNWYsCfE9ZRwZsTNnHAXxO2S8FbE3ZrwAYAcNMiXTRJska/aJNQhX3dJuEe%2B6ZPIgHwLkihEvoNJDCHfoySOkR9wkiDIDZIkKXKTJimG3GJJmiO3eZIRyB2RZCVyVyY5hdxTSV4j93VSMMgDkxQt8tAmJYc8cknZI499UgnIk5BUI/I0JrWEPEtJPSPPc9IoyIuSNCvysiatIXk1Iu0xeT0hnSl5MyPdOXm7IL0lebci/TV5DwDUywYFNqlXLQpqU687FNyl3vQopE%2B9HVAoSL2DKAym3iMUjlIfMIrAqQ2CIklqk6IomtpiKJqltjmK4akdgWJFaleiOJnaUyhepfY1StCpA4MSTerQoiSbOnIo2aWOPUrxqZOAUkPqNKK0mDpLKD2lzjPKyKmLgjJL6rKirJq6GlL2iLoeU86EuplS7oy6nVPegrpbUv6Kul9TAQDQYIN%2B1aShFv26TcMd%2Bk2XRnr02z6NDuh3II1B9HuYxhH6A0oTGL2B0yRBb5I0RdFbNE0z9DZLMxy9w9OsQO%2BKNCfRezLNK/S%2BSgsafaDTokEfmrRk0Uc2LTv0sUsrHn3i02pAn4a0FtFnMa0n9HlKGxl9kdNmQV%2BWtFXRVzVtD%2BnrEe2M6ZsJ7U7p2xntzem7Be0v6fsVHazpBwBgXjUYqMm8bjFwm3nTYZAu87bHoH3m3YDBQOY9xOAw8wFhCJTZwBgSZzYJhiKZLYqhaWabYRiW2eEYlmd2BYYTmT2J4WVmX2EElTnQGFFnDg1GMpkji5Ft5thhFJc58RjVZ04DRguZs4jRY%2BY8YYyUucgYM2cuC8YqmauKsWvmesg4I%2BZmzLgT5nbKeDPmbs74C%2BZ%2ByQQr5mHNhADAQg32dZOFW%2BybNot02LddFu2x7/osNmDfgywOsR9glkDYDZQlMXYTZymC3SJZmmK3aZZh2B2WZTl2l2c5gd0TWV5i92VWUNgDlRU19lBnJYM9MlnZYo9tVnHYE5dVPfbUZ7WAPQtZPWLPY9ZI2IuUNTP2Mmetgr0qWbtir2vWGbI3I9Yds7cT1puydzPWn7P3CzZYsg8rNlyzjwDAvW5wcJN70%2BKQNve2w6Fd7l2Pw/rc%2BwGHg9wHiCNgbgPhSJTbxDgK57YIjia5bYpjaG6H4ViW2%2BU4juf2BI4XuX2JE2TuQOFElTvUOEnnjgxONrlji1Ns7sThVJc79TjN584CTg%2B584gzYu4i4cyUu8w4K%2BeuCs4uueuKc2ruZsi5I%2B52zHkT7m7K%2BTPufs4FC%2B5hyYUr7nHNRQDAww3%2BTZNHWvzbNo92%2BHddHuvx7/s8PuA/gDwB8RswTyL8JspTGL%2BF8zTBb5M8Q/E7NM8y/C7Lcxy/x/O8wO%2BLvCDxBzIvKvyhyksaf6TzssEfm7xi8Sc2rzr8qctrHn/m83rAn4e8EfEXMW8m/GXKWxl/lfN2wV%2BXvFPxNzXvDvnbEe%2BN%2BbsJ70/5%2BxkfzPmHBR8u%2BccVH635JwAQ3jQEpCm8bQloW3jXEbCu8L4n4H3hw0AgQGEDEkhY2EQEChW2MIHGhW1CYEhhhxJYWthlBI4V9jiB54V9QRBE4UASRFk4VARJFY40QdaFY0NQTOHEElRbOHUEzRXOPEH3hfNAMELhIhLMWLhMBCsVrjLBzoXrQnBK4aYS3Fq4HQreSLgbC/5EuJ8KwUx4mAvhQnhcCtFKeFoLMQCISEN82xTRlviuLWId8X1XxHvih75IDMQNUCQhcRMWKUTcQkUaE7dxkSHEHVJkKXGXFjlG3GNFnhP3eVEQxANRFCXxUBYlRTxSRVkTj3VRMcQTU1Qt8dQWNUc8c0XdE8990QjEi1A0I/EyFq1EvEpFOxOvc9EpxJtSdCvxtha9oXg3Ev2xeD8Rg6n4MBPDufi4EKOl%2BLQS47X4DADS24aENqV3LQlrS%2B87Et6VPvQkoi9tDCQSlDYhiYKlLUSiUWkbkxhc2iEklpR2KYmjpT1G4llpn5MEXjoQJFGUDiVJkqUjRZJV6ViTFF06MSTVlE4tSbOlM0fSXenckwxfuggkM5QuI8mKpatEslPpOpOcXLopJLeUbivJq6W7oeSPpPuxFEykh6kUzqTHuRQtpKelFK%2Bk57WUAICMNuR3TRlrye/bMt6RP3Rloidv9GVyIG%2BCMgXJW7BMI/I2KjOYvIPLLCHvkjJHyXu0zDPyPisLnHzAy6IgH4qyJMlHsiwr8rEqK5p8osuqIZ%2BasmbJZ7asO/K5KxuefOHLZiBfhrIVyVexbCfydSo7mXyTy24h35ayV8l3tewP5fuRHIzlh4kcTuXHmRzN5aeFHC/l55WcrOWPAKC8ayhYU3nfUvC28qGjEF1lo6eQfWVzoFCgsgUpNKxsIwqDKjuYwuLKLqFwpLJHKTyt7DOKwCoHnCLyyqGgSKJyJCmyrBwriqIqJ5qi6sqpoWimcmYpuq2cO4rhKheeYvrKZaBYoXIVKXasXCeKkyo3meLmym2heKVyVyl%2BrdwPlWCkPIyVcKI8TpVopjzNlXihPC%2BVZKV8XCspAKhYQ33fVPGW%2BqGtEh11o6uSPXWzr1IDdQtUaUjdhlUGUXdQlcXUXVzlCHWPVHlK3adVgVEPWFXk1ENelQT1SFRlST2WVUVRT1RV1dRTXdUM9cxUdUs9t1XDUS9c1fTUS1%2B1AvUqVO1IvY5VJ1FvUtXN1Ntc9Qr1rlT9Sr2v1WCoPozUcKw%2BTtRoqj7N1HiuPi/UZKl%2BXKnpWv0EANr7hoY3tQ8tjWhrGx2N7GqbPY3qa1sDjQa1bUhjYG0H0VhU28U0Dtf2CI0ntX1KE2jtgNFEVjvkNInXjgRNFrVjSVNk7UTRVFU71TRN184MTTe1c0szbO3C0UxXu/Q0y9euAs0OtetIc2LtJtHcVLvNNC/X7grNL7X7Sgtq7WGohSPtcaxFE%2B1pqsUz7XmuJQvt41JLV9qntZYBgI439A9NnWjpG22d7OibXZ3q6Vt9nR7o26DOQPoOrLOIvovqHKbv4TpP6PukLlD6Aa2LjH7I6hKnH/G6LOjHoq5I%2Bomsq4p%2Bquqapp/pum7o56ZuWPqFrZuOfunqlqdf%2Bbod6Neh7kT6Tay7iX6b6l6m3%2BW6X%2Bj3pR5U%2BkOth0P9caRHY/1posdT/XmmJ3P940JPl/qnlZ6t9c8AYHxoGETT2GgZZNvY7BhU19jqGXTf2B4YDGjsQAYLG7uIwaHGHmbwuLFPGAJpHFCGSBuHjCGxxhFnyLxxLBiKaJxIhiobp4qhqcaZZui6cW4YhmlcWIZpG5eOYbnGlWfYvnEdGE5o3ESGGxu3ieGlxl1m%2BLlxXxhBaTxURlgbj0MjGhlPYyOeGM9TI5kZH%2BdGujA%2BLY1sZXxeGzkAmETD3GiaZMvcbJtUx9zqmnTP3O6bzMDcAU0WMndhk0PMPdTkMXMfNwXCPCBNkTIPaVNizCPWlDnzmDcVwTwRTVUyT2VTU8wz1dQ181w3DcO8ME3TMi9t03LMK9e0PfPaN53AvAlNNzJvY9NLzLvU9DPzPjeDwnwozbAyH2szGppPIzMem88TM5maH2dmOjc/LcxsaX5emfna/AIA1kbDIpvWZsui2tZWx6K71nbPYvrWzsBiQWsXsjjY2kMsHrX2MUvArQPCEknrkLIk2jpiLJm1jjlL4a0TwVJF61SyNNk6Uyxdtc41y9CtC8MyTevSsizbunIs27WuPcvxrZvAckPrNrK82LpLLD%2B17jMryK2HwgpL67Gyotp6GlrxyHoeW8nE%2Bji10pn1aW5lC%2Bvz0spX1pe1VQCATTbszaZNteyttk137O2uzfTsnb7NDuxd0OYgew%2B2ecTeR20Bsw9wWyTsQ9KWKPuItmXGPmZthbNPeFsV7FPR1iT7TLZ1xT5XbUOzL3TbNOxL07Ys%2B8q2bce%2Bdm3Hs2982w3s29D2Ivsutv3Evk/tILMfcjss7MfSjir7qbbjof08spOx/XFip1P708zO5vbnhZ0v7S8ru1jbXwHA2Ww4VNPZajl029nuOEzX2ek5bN/ZHTgc6OxBDg87%2B4gjoM4B5oi4c0g4EukcUY5MO8eMo7DOCeeovHMqOJronEmOLjvnimOozoXmmLpzaTiW6VxZjm07147juM6N57i%2Bcxs4XujcRY4fO/eJE6TOQ%2BaEufNYOFHpPFVOXDvPQycZOR/HTjpxPk2dbOZ8njv5wvmydIqV83XtlADgUg13q%2BnSLXe77TIdd6frsj13t%2B9yA3cPdHnI3YddAXEPUFfE3EPclQj3iHRlyj2mXYVxT1hX5dxT3tUE90x0dck9l11DcS9U19TcS921DPfKdG3LvbZdx3FvXNf13Fvf9QL3LnT9yL2P3SBxH1I3zNzH3I0K96l048p9rt1k6H4cuenY/TRxs6n7eebmc/fLwi2W7teVW67dbwDgbTU8uulttzym7e10PLbr7fY8ru/tDTwe9PYhT4C9A8QTUe8Q8yTcOyI8mfSOKU%2BhvRPGU1nvlPM03jsTPF30ziXPkL0LxTNV71LzLN27Mjzb9K4tz7G9G8dzXe/W8zzfuws8P/TuIy%2BIvYfEC1PvMfOi3HsqvLj0nisvqb2PQy8deZ/GXjbxPk%2B9fOZ9mXvFwvu69MqV923tVQDg0w1/u%2BkzLX%2Bn7bMdf7frcz1/r%2B/zA38f9AXIP4B9EfEPUV/C/CPclwn/mPQVyj%2BhfZXxT1lf4/wz3tcF/1z0Dcm/kH1T8S9V39L8K923Df/a9B3Lv7F91/FvXd/z/Dvf9wP/PvSDyH%2BI/TDxH1M/yvyn3I8L/7n0k8r/WPvp0P800rOx/3ni51P/y8wv5v7XhV8u/W8rv1r73wEg2G4ETDPYaQVsO9jtBFw32OsFfD/YHwQCGBxAgQgHh0ggocERFsh4cEwEChmcUIFKB6dMoLHBGRfofHAuBIYYXEiBKQeXSmCpwZUW2HpwbQSOGdxYgWsHt07gucGdF/h%2BcB8EQRg8REEYB49JEKXBUxbEefBcBEkZfKyCtA4%2BDYNsFHweB/kk%2BDINilnwdR6Ui%2BDbMqhWwfd1UANAyDTCnWbItsLddsh1wr1uyPfC/X4oDMIDMBSh8BAOJSQ8QkMZC4/xUCHCEzJUqfCUDjUmPGNDnQvP%2BdAQwgsxNKXwUg4tJbxSQ1sLr/XQMcIbM3St8NYOPSe8c0PfC%2B/9MAjChzAMo/AxDqMkfErDOAuf8zApwo9lmFbhpzrMhuHnUZiPwy%2BTsJiGX2dhOQ%2B/LcJqGX5fhfU6/AEA0U4jYpvRbivi2tFeJ%2BK70X4vEvrRwSASwegQiiQ4OkIiGY2OsUjBoxMiUsnolIo0OjpjIp2NzrnI4KMLITLF6FKKLDm6UiJbja61yNGjGyNyzejWijw7unMi343uvSjwo4cgCsPoMYqiOHpKojiNnrMoyaOPRZSW0acqyuro8zDKR9GXcVRMoq/TqJxF3%2BZRtYi%2BL6N6Ff1YR0MAiNlGvNuMuVa81475TrzfjYVefNCPxUF8CMYSFB/BsYzEx2isYPEJHqtEfErGGhWf0bHOxOdsbHDxBR%2BbQnwpBpbUX8mxrcTXauxo8Y0eu0Z8a8aeFd/Zse/E924cePGDH4dB/BjGURQ/xXGcxM9pnGTxxzxOi/hTGWdV/LmO82H8ZRQX4/jrJC6n8bdZXM3j74u4XsY/VvFwHf8EgGS3kXDNZK%2BV8O1kv5MI3eSgl4j95HCQSGByBCUynBwjiYImJ1ii4skpkWhkckYlOp2cM4nBJhdcYvLJpZBYYnIlJbacXCuJoyY3WuLqya2ReGZyZyW%2Bndw7SeAmD14S%2BsljkERh8hQlcZw8J0mSJh%2BzJM2TT0WSlcnnKsnr5MswKUbJ13FSTpJv06SaJd/nSb1IfiyT4Sr5uU5GAJByjXSvmfKtdL%2BdCp30oJuKvfSwn0qD9AhMZSg9hlMFSU/QVMXSUzzViPSMTHUqPadTg0kv2NTk0ks%2BtYT0SkxtKb2WU0dJb9TU1dJbPfWM9M5MfSu9t9PASR/cNPTSRz%2BNgvQpTOMofY7TJEk/pmmapZ/yNCvSz2WaV%2BmXOi2G6ddRWo7Tb5O0mqbfZ2k9T38s0uEy/blKR%2Bv0DwDI9hoZ38z2W5nQzg46mdjNDnuZ1M%2BOBpkMZsdQpsDZCZKpaHaKZRqenRGZTmbnVGbQ2QWTmWx2yWUWn10JmS1m11LmyNmNkrlqdqtlnp7dGZlvZvdWFtjZg5OFbvboZZGfPQVZHGbPUZbE2cckS9PsU5Zlefa5yPIy%2B1JlRZ19HWblKPs2zqpJ9n2a1bPsxzwbLrKfy2y0yv5YZ2MAyPlGvt/MhVZ%2B0M7FTn7YzaVeftTP5UF%2BDOYKlJ/AuYrkp2iuYfkZnutEfk7mBpVf0LnJ5JdsbnH5FZ/bQn4t5o6U38i5q%2BS3au5p%2BZ2e%2B0Z%2Bb%2BaBlT/Yeejkj24eefmTn8dB/hzmSZR/jPM0yT%2BleZbln/M8L/IvZV5U%2Bdc6L4f5t1FejfPvk7ye5j9m%2BXCe/1zko2X%2Bxyofr/M/AaDYbxRCszhoFWK7OOwUUrc46hVyvzgeFApYnECFChenSKGhxRlW6HhxThQGWVxQhUkXl0xhscUVV9h8cS0UjljcSIUrF7dK4anFnVb4enFvFIFZPFhFaBePThG5xZNXxH7xHBRJWHyMijQuPiVFlhafsyLPiy9FUZTF16oo6%2BLbsKhGxfdxUU%2BKH9NiOCt%2BzovRovhjWYxXxZ/rYgIApdAoD5ql2CoP26XUKY%2B6pdwrj/ulMihPwFKFylO41JDyDC11rDzHS4MoL8jSpMpLurSY8ootba685ktHKG/E0pXKW7n0lPJOLX2tvNfLwCgfzDK0yke7jJzyyS1jr3z2yyQoP4ZlGpWf4jJLys9pmWfll7wsivJrWZZV%2Ba0uq2H5fVTW4/LHpBxOy5%2BzcjQv/1iU42X556qcrMu/AKA6aFRiszpsVVK7OupUcrc67lVKvzoZVCpYnUKVBldnSKWj1TlWGXh1QVQmWV1SlUVXV0xls9U1Vzl8dSNUrljdSpUnV3dK5avVvVYFevVgVKFZPVpVZFdPThW71bNXJX71MajSsPoUVVlcfU6qPK2%2BZFWRV1%2BLqiyrb1VV1dX3YVWPqh/jajipfk6r0az6Y16NF9Wfy2qyqv5aV1MAqMVGfdispVZ91K7lTn3crZVefdKv1UF9CtYaVJ/BtY7U52htYPUFXptEfUnWFlVf0bXN1Nds7XD1DV%2B7Qn0r1p5U38m1r9T3ah1o9YNeh0b9aNaRVT/ZdezUz26dePVHv06D%2BlNYZ1H9Oa7zpP6S1kVWf83rsqi/lXVV1d%2Bruh7WP0b1cFz/nNSjaf3HrB7P6z8X9WRZ/7Wqp%2Bv6bwAYHjaGUnN41BrK7eFxZ6h0hye9odofng6GGjg8g4Y6PDxHhgY6vMCGJj68JIYWObyihjY9vGaGDju84YYuP7wVhp44vJOGvjy8V4aBOnzQhqE%2BfDSGkTl8soaxPXx2hok7/OgNU3/4KRhm4fBzNMzj4ZdkWKTDr9mwzIffimFVDr9Xw7oe/hgOh6Phz/FwNBn%2BMR2OZ8M/58PJYvjXcjhdDf9eD2cAMJIao6PmSG6NjtsjpTM66Y7U3ui0P9IGozNwpEOjc3hkIKMLdGRio0t8ZBGjK3JkU6NreuQwoxt25HKjW37kCaM7ceRLo3t5FCijB3UUaqNHfRQZoydzFFujZ3uUOKOP7ij1Rp/8URaMPoejPBp9iUdFMvqajsps9C0fVcXoezmqq9GPejQcjn6ORqPx6I/JaDwd/TkbTeajvxaj6XL092o0W4/%2BAYDxUWMsN8fHrbHSHp90xmp3fNoba/3x2WCsg%2BNzaGzA4wtkbKLjS2xs4eMrYmyT42tq7NDjG2bssuNbbuzx4zth7Ivje2kcyOMHZRyq40dtHOnjJ2Mcm%2BNna5zY44/OOHXHn7xx5o8/B%2BM8HH%2BJxkU8/pqMy3T8LRtX%2Bfh7Ma7L8Y9qPKzHP4fj0Wj8x3g8noz/nI4ns/Ff8/F0Mf57OZ6txv%2Bsx3MAmMiNyXFzorQmJ%2B2J2pmcdidab3LWn%2BiDyTk4MaDJBTwxkcklOrGwyRU%2BsYnJNTlxqMkNPXGZyS078bjJHT/xhcm9OAmkyYM8CZXJozqJtMmTPomNybM5SazJR3uSOpNP7iTzJp/9SR5MvoSTIpp8jSdlMvmWTqps8j2f1MXkRzkZVpOf9WQ0nPwxmozHkz8nk8l08tdsMp1P/l5MZsvJP6vJfD35DwBMjxtTpTk9aU3V9vS0M9W607PeVO9PzwdTA5xeQFMTnl4iUwudXmFTG59eE1OHnN5QU5ee3jJTj53ecVOfn94L00CcPkjTUJ4%2BKtNInT5p01ifPhvTxJx%2BtKapPf3kTDN3%2Btmb5v70SzAtwunXaFrG02/JtEqn37NpnU9/FNNhOf1ZTUf19I/hdDya/jmeTibTv6bT6Wz693w6W0z/WU7nq%2Bl/1tMFAMyUxuykOVNbs9P2TOvMzrozvTc778%2BMwewCnJnQ7BKeWcjsCp3Z2OwanznE7IacudTslp55zOyOnfnc7J6fBcLsQZyF0uxRnkXK7EmdxdrsWZ8lxuyjOUut2Sd7ljmzz%2B4s92Zf/FkRzL6GszKafYtnVTL7ns7qbPYjnw2L2c9yNqpmf9Sz8XD252g2Gc/%2Bmsym09nfs9lsPvtnMZsvZ/9ZzRbr2X8BYH7SmKvN%2BWlrrrXnZ5253p2f9%2BZGf34xmJvg/BKaW/D8Cpnb6Pwamzv4/IaYu%2BT8lpp79PyOmfvs/J6bB/z8QZiH4vxRmkfy/EmZx%2Br8WZsn%2BvyjMU/N%2BSdrntnzz848d%2BdfvHnhz78G8zKcf4vmVTz/nszrdP4jmw/z%2Bc9iPirnf1TzcT3/czifjOZ/jefTyfzv6Xw2m/8zn88X8/8s54vV/L/r%2BRIAFmpjcdpcaK3FWXuhdxbn3YXRW1z0F%2BZgcQkuLGhxBS9sZHGNLhxscYMvXGJxSy48anFHL3xmcc8uAm7xwC9CYfEoLiJp8SQvYmXxrC4SbfFRX6TG4pO5yKzFZ3uRO4sv7qLwFl/9RRksvoWLKlp8jxd1sviRLobZ4me%2BGBWLP8rFuFr8WS8mw8Vfo8V0vPh7sphNF//MFvP54j%2BLxWK5%2BO9qsVwv/g8AlqeNpdZcnrWWent53lka3eVFb2n2l5eDpQUur6ClDS%2BvkaWDLm%2BwpYsvb4mlRy7vqKVPL%2B%2BZZcAuH7hlyC8fhWUkLp%2BkZSwvn5Vloi4/astUX34ylpm5/Gwtc3v5xVkW7vKrtyz95bdgWYXL79Gyjpc/kuUwXf7MlqN8%2BUexHJfLP6vlpF7%2BNVxOR8u/x8vZZPnPdDmfLf8zXy4Wy/8ul8vV8v/WyxUArLTG6qy50lur8/bK6Kwuuiuzt7rsr6zB6gpc2dDqGl45yOoGXbnY6hZfecTqjlz51OqeXgXM6oFdhdzqkV9FwupJXMXS6lleJcrqo7pKtdUnfZUZq8/mKrdWX%2BxV4ay%2BuqvSW33zV1Ww%2Bh6u6mj1I14Nk9XPdDXKVn/kq3Gx%2BrNcTarVX/VqOlz9PVrNxqt/Jqv5dPWf2WoxX/13sVouV/%2B3Wq3Wq/8HAOuzxlpvrs9ba6O9vuisze76sre2%2BurqwdoG19fQ2oHXN8jaRde32NrD13fE2ifX99Q6oNcPzDpk14/cOuLXT8I6FtfP0jqR1x%2BVdaquP2nrTF9/Nta5uf5irQt7/dVZl%2B76m7eu/PX3YF2H6x/RehivfybrUbr%2BI1uP8/WfxXpSrv%2Bq1tN6/fdwPRut/xmv55P1f6brxWz93/l6uVj/33K9Wq3/33q9/v/5e6Fad9aafgAAAABJRU5ErkJggg==' | base64 -d > /workspace/read-fixtures/pixel.png"

exec_cmd "printf 'JVBERi0xLjQKMSAwIG9iago8PD4+CmVuZG9iagolJUVPRgo=' | base64 -d > /workspace/read-fixtures/sample.pdf"

exec_cmd "printf 'UEsDBAo=' | base64 -d > /workspace/read-fixtures/sample.docx"

exec_cmd "printf 'f0VMRg==' | base64 -d > /workspace/read-fixtures/program"

exec_cmd "printf '//4=' | base64 -d > /workspace/read-fixtures/invalid-utf8.txt"

exec_cmd "printf 'iVBORw0KGgo=' | base64 -d > /workspace/read-fixtures/oversized.png && dd if=/dev/zero bs=1048576 count=21 >> /workspace/read-fixtures/oversized.png 2>/dev/null"
```

期望：每次 `/exec` 均返回 `exitCode: 0`。

## 5. 文本读取

### T-READ-01 UTF-8 文本分页

```bash
read_file /workspace/read-fixtures/text.txt
latest_read_state | python3 -m json.tool

test "$(state_value 'd["status"]')" = completed
test "$(state_value 'd["metadata"]["kind"]')" = text
test "$(state_value 'd["metadata"]["mime"]')" = text/plain
latest_read_state | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "alpha" in d["output"] and "beta" in d["output"]'
```

验收：状态为 `completed`，输出带 1-based 行号，metadata 包含 `kind=text`、`mime=text/plain`、文件大小和 bounded preview。

### T-READ-02 空文件

```bash
read_file /workspace/read-fixtures/empty.txt
latest_read_state | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="completed"; assert "total 0 lines" in d["output"]'
```

验收：空文件不能被误判为不存在或目录。

### T-READ-03 SVG 走文本路径

```bash
read_file /workspace/read-fixtures/vector.svg
latest_read_state | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="completed"; assert d["metadata"]["kind"]=="svg"; assert d["metadata"]["mime"]=="image/svg+xml"; assert not d.get("attachments")'
```

验收：SVG 作为文本返回，不生成可直接注入 HTML 的媒体附件。

### T-READ-04 非法 UTF-8

```bash
read_file /workspace/read-fixtures/invalid-utf8.txt
latest_read_state | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="error"; assert "valid UTF-8" in d["error"]'
```

验收：状态为 `error`，错误不包含原始字节或 Base64。

## 6. 受管附件

### T-READ-05 PNG 附件化

```bash
read_file /workspace/read-fixtures/pixel.png
latest_read_state | python3 -m json.tool

test "$(state_value 'd["status"]')" = completed
test "$(state_value 'd["metadata"]["kind"]')" = image
test "$(state_value 'd["metadata"]["mime"]')" = image/png

PNG_URL=$(state_value 'd["attachments"][0]["url"]')
export PNG_URL
test "${PNG_URL#"/session/$SID/attachment/"}" != "$PNG_URL"

curl -sS "$BASE$PNG_URL" -o /tmp/read-pixel.png
test "$(xxd -p -l 8 /tmp/read-pixel.png)" = 89504e470d0a1a0a
```

验收：

- `output` 仅包含短文本 `Image read successfully`。
- 附件 URL 为 `/session/{sessionID}/attachment/{attachmentID}`。
- URL 不是 Data URL，不包含 Sandbox 路径。
- 下载字节保持 PNG signature。

### T-READ-06 PDF 附件化

```bash
read_file /workspace/read-fixtures/sample.pdf
latest_read_state | python3 -c 'import json,sys; d=json.load(sys.stdin); a=d["attachments"][0]; assert d["status"]=="completed"; assert d["metadata"]["kind"]=="pdf"; assert a["mime"]=="application/pdf"'

PDF_URL=$(state_value 'd["attachments"][0]["url"]')
curl -sS "$BASE$PDF_URL" -o /tmp/read-sample.pdf
test "$(dd if=/tmp/read-sample.pdf bs=1 count=5 2>/dev/null)" = '%PDF-'
```

验收：PDF 不进入文本解码路径，下载内容以 `%PDF-` 开头。

### T-READ-07 Office 仅展示

```bash
read_file /workspace/read-fixtures/sample.docx
latest_read_state | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="completed"; assert d["metadata"]["kind"]=="office"; assert d["metadata"]["textExtracted"] is False'

OFFICE_URL=$(state_value 'd["attachments"][0]["url"]')
curl -sS -D /tmp/read-office.headers "$BASE$OFFICE_URL" -o /tmp/read-sample.docx
grep -qi '^content-disposition: attachment;' /tmp/read-office.headers
```

验收：Office 返回下载附件，metadata 明确 `textExtracted=false`，不默认发送给模型。

## 7. 下载协议

### T-READ-08 Range

```bash
curl -sS -D /tmp/read-range.headers \
  -H 'Range: bytes=0-7' \
  "$BASE$PNG_URL" \
  -o /tmp/read-range.bin

grep -q 'HTTP/1.1 206' /tmp/read-range.headers
grep -qi '^accept-ranges: bytes' /tmp/read-range.headers
grep -qi '^content-range: bytes 0-7/' /tmp/read-range.headers
test "$(wc -c < /tmp/read-range.bin | tr -d ' ')" = 8
test "$(xxd -p /tmp/read-range.bin)" = 89504e470d0a1a0a
```

### T-READ-09 非法 Range

```bash
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Range: bytes=999999-' "$BASE$PNG_URL")
test "$STATUS" = 416
```

### T-READ-10 ETag 条件请求

```bash
curl -sS -D /tmp/read-etag.headers "$BASE$PNG_URL" -o /dev/null
ETAG=$(awk 'BEGIN{IGNORECASE=1} /^etag:/{sub(/\r$/,""); print $2}' /tmp/read-etag.headers)
test -n "$ETAG"

STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -H "If-None-Match: $ETAG" "$BASE$PNG_URL")
test "$STATUS" = 304
```

### T-READ-11 字节完整性

```bash
SOURCE_SHA=$(exec_cmd "sha256sum /workspace/read-fixtures/pixel.png" | jexec 'd["stdout"].split()[0]')
DOWNLOADED_SHA=$(shasum -a 256 /tmp/read-pixel.png | awk '{print $1}')
test "$SOURCE_SHA" = "$DOWNLOADED_SHA"
```

## 8. 拒绝与上限

### T-READ-12 已知二进制

```bash
read_file /workspace/read-fixtures/program
latest_read_state | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="error"; assert "binary file" in d["error"]; assert not d.get("attachments")'
```

### T-READ-13 超过 20MB

```bash
read_file /workspace/read-fixtures/oversized.png
latest_read_state | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["status"]=="error"; assert "ingestion limit" in d["error"]; assert not d.get("attachments")'
```

验收：读取在流式复制阶段失败，不返回部分附件，不把文件读入 ToolPart。

## 9. PostgreSQL 与 payload 安全

### T-READ-14 数据库不含 Base64、Data URL 和 null byte

```bash
psql "$PG_URL" -Atc "
SELECT count(*)
FROM part
WHERE session_id = '$SID'
  AND (
    data::text LIKE '%data:image/%'
    OR data::text LIKE '%base64,%'
    OR data::text LIKE '%\\u0000%'
  );
"
```

期望返回 `0`。

```bash
curl -sS "$BASE/session/$SID/message" > /tmp/read-messages.json
python3 - <<'PY'
import json, os
with open('/tmp/read-messages.json') as file:
    raw=file.read()
assert 'data:image/' not in raw
assert 'base64,' not in raw
messages=json.loads(raw, strict=False)
urls=[a['url'] for m in messages for p in m.get('parts',[]) if p.get('type')=='tool' for a in p.get('state',{}).get('attachments',[])]
assert urls
assert all(url.startswith(f'/session/{os.environ["SID"]}/attachment/att_') for url in urls)
PY
```

## 10. PVC 持久性

### T-READ-15 Sandbox 重建后附件仍可访问

```bash
curl -sS -X POST "$BASE/session/$SID/kill-sandbox"
curl -sS --max-time 180 -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"boot":true}' | python3 -m json.tool

curl -sS "$BASE$PNG_URL" -o /tmp/read-pixel-after-rebuild.png
test "$(shasum -a 256 /tmp/read-pixel-after-rebuild.png | awk '{print $1}')" = "$DOWNLOADED_SHA"
```

验收：Sandbox ID 改变后，稳定附件 URL 和字节内容不变。

### T-READ-16 SaaS 重启后附件仍可访问

该用例会短暂中断本地服务，单独执行：

```bash
docker restart opencode-saas-test

for i in $(seq 1 30); do
  STATUS=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/" || true)
  test "$STATUS" = 200 && break
  sleep 1
done

curl -sS "$BASE$PNG_URL" -o /tmp/read-pixel-after-saas-restart.png
test "$(shasum -a 256 /tmp/read-pixel-after-saas-restart.png | awk '{print $1}')" = "$DOWNLOADED_SHA"
```

## 11. 模型投影回归

### T-READ-17 单元级安全回归

```bash
cd packages/opencode
bun test test/tool/attachment.test.ts test/session/message-v2.test.ts
```

验收：

- 受管 URL 只在单次 provider 请求构建期间转换为临时 Base64。
- 缺少 SandboxProvider 时省略媒体，不把内部 URL 交给 provider。
- `display-only` Office 附件不进入模型输入。
- 测试结果为 `50 pass / 0 fail` 或更多，不能减少现有断言。

## 12. 前端集成指南

### 12.1 数据契约

工具完成后，`GET /session/:sessionID/message` 返回的 ToolPart 中包含受管附件：

```jsonc
{
  "type": "tool",
  "tool": "read",
  "state": {
    "status": "completed",
    "output": "Image read successfully",
    "metadata": {
      "kind": "image", // text | svg | image | pdf | office
      "mime": "image/png",
      "size": 4096,
      "truncated": false,
    },
    "attachments": [
      {
        "type": "file",
        "mime": "image/png",
        "filename": "screenshot.png",
        "url": "/session/ses_123/attachment/att_123",
      },
    ],
  },
}
```

字段说明：

| 字段                     | 类型      | 说明                                                       |
| ------------------------ | --------- | ---------------------------------------------------------- |
| `attachments[].type`     | `"file"`  | 固定值                                                     |
| `attachments[].mime`     | `string`  | MIME 类型，如 `image/png`、`application/pdf`               |
| `attachments[].filename` | `string?` | 清洗后的文件名，可用于下载和展示                           |
| `attachments[].url`      | `string`  | 相对路径，需拼接 API origin 后使用                         |
| `metadata.kind`          | `string`  | 文件分类：`text`、`svg`、`image`、`pdf`、`office`          |
| `metadata.audience`      | `string`  | 间接体现在 `Content-Disposition`：`inline` 或 `attachment` |

关键约束：

- `url` 永远是相对路径 `/session/{sid}/attachment/{aid}`，不是 Data URL、不是 Sandbox 文件路径。
- 响应体是原始字节，不是 JSON。
- 未启用密码时可直接访问；启用认证时需带 `Authorization` 头。

### 12.2 构建完整 URL

```js
const apiBase = "http://localhost:14096"

// 拼接稳定 URL
function attachmentUrl(attachment) {
  return new URL(attachment.url, apiBase).href
}
```

### 12.3 图片展示

```js
// 未启用认证时直接用 src
function renderImage(attachment) {
  const src = new URL(attachment.url, apiBase).href
  const img = document.createElement("img")
  img.src = src
  img.alt = attachment.filename || "attachment"
  return img
}
```

启用认证时改用 fetch + ObjectURL：

```js
async function renderSecureImage(attachment, authHeader) {
  const res = await fetch(new URL(attachment.url, apiBase), {
    headers: { Authorization: authHeader },
  })
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)

  const img = document.createElement("img")
  img.src = objectUrl
  img.alt = attachment.filename || "attachment"

  // 组件卸载时释放
  img.onload = () => {} // 可按需延迟释放
  return { el: img, cleanup: () => URL.revokeObjectURL(objectUrl) }
}
```

### 12.4 PDF 预览

```js
async function renderPdf(attachment, authHeader) {
  const headers = authHeader ? { Authorization: authHeader } : undefined
  const res = await fetch(new URL(attachment.url, apiBase), { headers })
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)

  const iframe = document.createElement("iframe")
  iframe.src = objectUrl
  iframe.title = attachment.filename || "PDF"
  iframe.style.width = "100%"
  iframe.style.height = "600px"

  return { el: iframe, cleanup: () => URL.revokeObjectURL(objectUrl) }
}
```

### 12.5 Office / 未知文件下载

Office 附件的 `Content-Disposition` 为 `attachment`，浏览器不会内联渲染，应提供下载按钮：

```js
async function downloadAttachment(attachment, authHeader) {
  const headers = authHeader ? { Authorization: authHeader } : undefined
  const res = await fetch(new URL(attachment.url, apiBase), { headers })
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)

  const a = document.createElement("a")
  a.href = objectUrl
  a.download = attachment.filename || "attachment"
  a.click()
  URL.revokeObjectURL(objectUrl)
}
```

### 12.6 按 MIME 分流渲染

```js
async function renderAttachment(attachment, authHeader) {
  const mime = attachment.mime

  if (mime.startsWith("image/")) return renderImage(attachment)
  if (mime === "application/pdf") return renderPdf(attachment, authHeader)
  return downloadAttachment(attachment, authHeader)
}
```

### 12.7 从消息列表提取附件

```js
function extractAttachments(messages) {
  return messages
    .flatMap(function (msg) {
      return msg.parts
    })
    .filter(function (part) {
      return part.type === "tool" && part.state.status === "completed"
    })
    .flatMap(function (part) {
      return part.state.attachments || []
    })
}
```

### 12.8 Range 请求与流式加载

大文件可分段加载，适用于视频或大 PDF：

```js
async function fetchRange(url, start, end) {
  const res = await fetch(url, { headers: { Range: "bytes=" + start + "-" + end } })
  if (res.status !== 206) throw new Error("Expected 206, got " + res.status)
  return res.arrayBuffer()
}
```

### 12.9 ETag 缓存

首次请求后保存 ETag，后续请求带 `If-None-Match` 可避免重复传输：

```js
const etagCache = new Map()

async function fetchAttachment(url) {
  const etag = etagCache.get(url)
  const headers = {}
  if (etag) headers["If-None-Match"] = etag

  const res = await fetch(url, { headers })
  if (res.status === 304) return null // 本地缓存有效

  const newEtag = res.headers.get("etag")
  if (newEtag) etagCache.set(url, newEtag)
  return res.blob()
}
```

### 12.10 错误处理

```js
async function safeFetchAttachment(url) {
  const res = await fetch(url)
  if (res.status === 404) throw new Error("附件不存在或已被清理")
  if (res.status === 403) throw new Error("无权访问该 Session 的附件")
  if (res.status === 416) throw new Error("请求的 Range 超出文件大小")
  if (!res.ok) throw new Error("附件下载失败: HTTP " + res.status)
  return res.blob()
}
```

### 12.11 清理 ObjectURL

使用 `URL.createObjectURL` 创建的 URL 必须在组件卸载或附件变化时释放，否则会内存泄漏：

```jsx
// 以 React 为例
import { useState, useEffect } from "react"

function useAttachmentBlob(url, authHeader) {
  const [objectUrl, setObjectUrl] = useState(null)

  useEffect(() => {
    let revoked = false
    let createdUrl = null

    fetch(url, { headers: authHeader ? { Authorization: authHeader } : undefined })
      .then((res) => res.blob())
      .then((blob) => {
        if (revoked) return
        createdUrl = URL.createObjectURL(blob)
        setObjectUrl(createdUrl)
      })

    return () => {
      revoked = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [url, authHeader])

  return objectUrl
}
```

### 12.12 完整示例：React 附件组件

```jsx
import { useState, useEffect } from "react"

const API_BASE = "http://localhost:14096"

function Attachment({ attachment, authHeader }) {
  const [objectUrl, setObjectUrl] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let revoked = false
    let createdUrl = null

    setLoading(true)
    setError(null)

    const headers = authHeader ? { Authorization: authHeader } : undefined
    fetch(new URL(attachment.url, API_BASE), { headers })
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status)
        return res.blob()
      })
      .then((blob) => {
        if (revoked) return
        createdUrl = URL.createObjectURL(blob)
        setObjectUrl(createdUrl)
      })
      .catch((e) => !revoked && setError(e.message))
      .finally(() => !revoked && setLoading(false))

    return () => {
      revoked = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [attachment.url, authHeader])

  if (loading) return <div>loading…</div>
  if (error) return <div className="error">{error}</div>

  if (attachment.mime.startsWith("image/")) {
    return <img src={objectUrl} alt={attachment.filename || "attachment"} />
  }

  if (attachment.mime === "application/pdf") {
    return <iframe src={objectUrl} title={attachment.filename || "PDF"} style={{ width: "100%", height: "600px" }} />
  }

  return (
    <a href={objectUrl} download={attachment.filename || "attachment"}>
      Download {attachment.filename || "file"}
    </a>
  )
}

export default Attachment
```

### 12.13 前端测试用例

#### T-FE-01 图片附件渲染

```bash
# 前置：T-READ-05 已通过，PNG_URL 可用
# 验证：浏览器直接访问 $BASE$PNG_URL 返回 PNG 图片
curl -sS -o /dev/null -w "content-type=%{content_type} size=%{size_download}" "$BASE$PNG_URL"
```

期望：`content-type=image/png`，`size` > 0。

#### T-FE-02 PDF 附件内联预览

```bash
curl -sS -D - "$BASE$PDF_URL" -o /dev/null | grep -i content-disposition
```

期望：`Content-Disposition: inline`（PDF 可内联预览）。

#### T-FE-03 Office 附件强制下载

```bash
curl -sS -D - "$BASE$OFFICE_URL" -o /dev/null | grep -i content-disposition
```

期望：`Content-Disposition: attachment`（Office 文件不内联，浏览器触发下载）。

#### T-FE-04 认证场景附件访问

```bash
# 未启用密码时
curl -sS -o /dev/null -w "%{http_code}" "$BASE$PNG_URL"
# 期望 200

# 启用密码时（需带 Authorization 头）
curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Basic xxx" "$BASE$PNG_URL"
# 期望 200；不带 Authorization 时期望 401
```

## 13. 清理

```bash
curl -sS -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}'
curl -sS -X POST "$BASE/session/$SID/kill-sandbox"
curl -sS -X DELETE "$BASE/session/$SID"

rm -f /tmp/read-last-response.json \
  /tmp/read-pixel.png \
  /tmp/read-sample.pdf \
  /tmp/read-sample.docx \
  /tmp/read-range.bin \
  /tmp/read-range.headers \
  /tmp/read-office.headers \
  /tmp/read-etag.headers \
  /tmp/read-messages.json \
  /tmp/read-pixel-after-rebuild.png \
  /tmp/read-pixel-after-saas-restart.png
```

## 14. 验收汇总

| 编号         | 能力                | 通过标准                                  |
| ------------ | ------------------- | ----------------------------------------- |
| T-READ-01~04 | 文本、安全解码、SVG | 分页正确，空文件正常，非法 UTF-8 明确失败 |
| T-READ-05~07 | 图片、PDF、Office   | 稳定附件 URL，MIME 和 audience 正确       |
| T-READ-08~11 | 下载协议            | 206/416/304、Range、ETag、SHA-256 正确    |
| T-READ-12~13 | 二进制与大小上限    | 明确拒绝，无部分附件                      |
| T-READ-14    | PG 与 payload 安全  | 无 Base64、Data URL、null byte            |
| T-READ-15~16 | 持久性              | Sandbox/SaaS 重建后附件仍可读取           |
| T-READ-17    | 模型投影            | 内部 URL 不泄露，Office 不发送模型        |
| T-FE-01~04   | 前端集成            | 图片渲染、PDF 内联、Office 下载、认证访问 |
