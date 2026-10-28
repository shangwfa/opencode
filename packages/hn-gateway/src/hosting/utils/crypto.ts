/**
 * 上报解密（原 utils/crypto.util 语义）：RSA 私钥解出 AES 口令 → CryptoJS 口令模式 AES 解密。
 * RSA 腿用 jsencrypt（原实现同款，纯 JS 大数运算）——Bun/OpenSSL 3 已禁用 PKCS#1 v1.5 私钥解密，
 * node:crypto 的 RSA_PKCS1_PADDING 不可用；AES 腿为 node 实现（Salted__ + EVP_BytesToKey(md5,1轮) → aes-256-cbc）。
 * 私钥经 GATEWAY_REPORT_PRIVATE_KEY 配置（迁移期兜底原内置 key，上线前轮换）。
 */
import { createDecipheriv, createHash } from "node:crypto"
import { JSEncrypt } from "jsencrypt"

const FALLBACK_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDivLYJAJW3IKpN
6XTibRvHKBg30DWBCCEbbXFfbGrdB4sVed/zQWwt5P8R0OouqUqDgiQ67bl8xmts
82nAA8kqMmIIxRbvj4Tdrled4BQGEf0HOEPpVQX49obVgv4K351YgcErHH1JLXLj
+u0Z0CikyFanKhSJKXa6SuYyD7JYMezRtC+rZ8iQgKN1RXjUZB9T51u4eZA1IY1L
mnWgh/jFT/DdDGqphg+gpWPiBuCFqzEXOAhg5v4MWYOOt6HtN+ei5mIpTIEdacUh
r7FRkT3zRRJMN9CS33ymvMsIars78ESgPGCwKigtX6AKfXPi0Bccwvp+XiDpNSaZ
FeeLeFu/AgMBAAECggEABFYCGSv5Q0P6y3wQJpc1kOy4XUVzC+qBKwFAExGDj+/y
2WK3/BdWVmnGPmKMh+zDb5nPq0X3r2YrbAitWFLVo5Gn8f/YmJUQwB0X1Uaj3/XX
0ZuraxYt3zP2j9nb3rNc5RbVACNXw7oO6tV6nLYwN6VbbSaqbifsaFNUWsUDgRkW
rIZ7pHcWkSt31xzIJHZ0cQdwmp0rZb5M2WsQfvvq/JzgxZxxBbC+9yd1BPZxparF
3M//NeNrEvFAigmvo6rdM4PE1hbm/Zf1VwDoMs6+luLjy+yf1ajawnCVPXMpqoa9
VPWTwUhoSFtM3MVqPu68c4kzX7lCEm0r7WehVaeCuQKBgQDzClQONifNCBLQg7uN
/XDjqo7jsxP9Ba3UJSqCqh+IO/QbrsjGL4d/r0Sgh/NGzZzWbUGSNF7TxbC+/AkR
oEhbEsarfaWQZZgaNcXidA9TEE/k0JAFNRPACP8Ci2R4YlzKAmTQszhRDra1ZWFA
OTcZCVkseF+3iWssYI8UF6AgYwKBgQDu09UrGR+7SIRC/pnqHllxSKp0CqMdOgTN
1paLCoQqvslbG0hT8NXWm/BakRMYt//cKfKa6AigCHA0kQ9kV0eOD7T1Sp9HV0zw
fthCL7D2fP2s87SQ+gh2lNRnsK3ZknBYcw2L2AcGylruTp78LYatIc/eACU0eeKI
j93WQQs/9QKBgQDRDHo+eyCDAEXGqvjBalUWztb3TkqMIb1iM9G78H8M3JzcztuN
dMZ08pnyBt4fca5M1k9HZdqHB40+yWU3jwmNpLnUOlAVwv0w1j3uyeuAhBBkfWzT
vdLOJC7Mzn9N+TVc4PA8f1uahTBtGNWsu0oENAFK+gNCyGWyFyAapTOrhwKBgEHO
aKxJbe7i2l7DXJGf7zFBvoXe8Hb7J5u4Bx8ktKo6i6zo5ZMLh0BtE1tBIivrdzqo
7Eo2qTm/WXuChOU3D2ZbeZclCqJTscWKjfgev/oLErL3K8fOvUo/VA+GJUEQEpis
iwz/Z2A9nbSQQUpnGPbXnDklfRrqgrryOUPyBDGJAoGAZ2ySOFYg1vNzKJtbrBr8
nZC/7eqtJQFha9twcUWC0QZMQVmyoIMlQerH+yOxNz4zn0SlAbSkcW9qkAR2u2IS
Dtmrx9li539kE8AHtjz+keq7YsIZLtYt4UHa/N9oFDP/Awc1DprOMayQjUErs/GI
e8vtLrn0kFYq9j4t/rGHIig=
-----END PRIVATE KEY-----`

export function getReportPrivateKey(): string {
  return process.env["GATEWAY_REPORT_PRIVATE_KEY"] || FALLBACK_PRIVATE_KEY
}

/** OpenSSL EVP_BytesToKey（MD5，1 轮迭代）派生 key+iv（CryptoJS 口令模式） */
function evpBytesToKey(passphrase: string, salt: Buffer, keyLen = 32, ivLen = 16): { key: Buffer; iv: Buffer } {
  const md5 = (data: Buffer) => createHash("md5").update(data).digest()
  let d = Buffer.alloc(0)
  let prev = Buffer.alloc(0)
  while (d.length < keyLen + ivLen) {
    prev = md5(Buffer.concat([prev, Buffer.from(passphrase, "utf8"), salt]))
    d = Buffer.concat([d, prev])
  }
  return { key: d.subarray(0, keyLen), iv: d.subarray(keyLen, keyLen + ivLen) }
}

/** RSA 解密 AES 口令（PKCS#1 v1.5，jsencrypt 纯 JS 实现，等价原实现） */
let crypt: JSEncrypt | null = null
function rsaDecrypt(encryptedKey: string): string | null {
  try {
    if (!crypt) {
      crypt = new JSEncrypt()
      crypt.setPrivateKey(getReportPrivateKey())
    }
    const result = crypt.decrypt(encryptedKey)
    return typeof result === "string" && result ? result : null
  } catch {
    return null
  }
}

/** AES-256-CBC 口令模式解密（等价 CryptoJS.AES.decrypt(data, passphrase)） */
function aesDecrypt(ciphertextBase64: string, passphrase: string): string | null {
  try {
    const raw = Buffer.from(ciphertextBase64, "base64")
    const saltPrefix = raw.subarray(0, 8)
    if (saltPrefix.toString("latin1") !== "Salted__") return null
    const salt = raw.subarray(8, 16)
    const ciphertext = raw.subarray(16)
    const { key, iv } = evpBytesToKey(passphrase, salt)
    const decipher = createDecipheriv("aes-256-cbc", key, iv)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return decrypted.toString("utf8")
  } catch {
    return null
  }
}

/** 原 decrypt(data: {data, key})：RSA 解 key → AES 解 data → 尝试 JSON.parse */
export function decryptReport(data: { data: string; key: string }): unknown {
  const aesPassphrase = rsaDecrypt(data.key)
  if (!aesPassphrase) return null
  const text = aesDecrypt(data.data, aesPassphrase)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
