/**
 * 修仙游戏存档 Worker —— Cloudflare Workers + KV
 *
 * 账户模式：用户名 + 密码（无邮箱/手机，纯匿名账户）
 *
 * 接口：
 *   POST /register { id, password }        → { ok } / { ok:false, error:"id_taken" }
 *   POST /login    { id, password }         → { ok, data } / { ok:false, error:... }
 *   POST /save     { id, password, data }   → { ok } / { ok:false, error:... }
 *   GET  /ping                              → { ok:true }   健康检查
 *
 * 数据（KV key 规划）：
 *   auth:<id>  = JSON { salt, hash, createdAt }   密码 PBKDF2-SHA256 派生，挡爆破
 *   save:<id>  = 加密存档字符串（crypto.js 的 AES 产物），一个玩家完整存档
 *
 * 鉴权：
 *   1. Origin 白名单——只接受来自你自己 Pages/自定义域名的请求。
 *   2. 写入限速——每个来源 IP 每分钟最多 MAX_WRITES_PER_MIN 次写，超过 429。
 *   3. 用户名 + 密码——存/取存档必须带正确凭证。
 *
 * ponytail: id 不限字符（可中文/符号），KV key 支持任意 UTF-8（≤512B），日常 id 远不到上限。
 */

// ponytail: 允许的来源域名。末段匹配，pages.dev 子域原生支持；生产自定义域名记得加进来。
const ALLOWED_ORIGINS = [
  'xiu.ygmm.de', // Pages 前端自定义域名(玩家访问入口)
  'xx.ygmm.de', // Worker 后端自定义域名(自身回环备用)
  'localhost',
  '127.0.0.1'
]

// ponytail: 每来源 IP 每分钟最大写入次数。修仙单机游戏存档频率低，够用。
const MAX_WRITES_PER_MIN = 30
// ponytail: 存档字符串安全上限。实测满存档 ~20KB；25MB 是 KV 上限，这里保守挡恶意大包。
const MAX_DATA_BYTES = 1 * 1024 * 1024 // 1 MB
// ponytail: id / 密码长度约束（挡空值和超长恶意输入；不限字符集）。
const MAX_ID_BYTES = 256
const MIN_PASSWORD_LEN = 1
const MAX_PASSWORD_LEN = 128
// ponytail: PBKDF2 迭代轮数。10 万轮在 Workers CPU 时限内可接受，且显著抬高爆破成本。
const PBKDF2_ITERATIONS = 100000

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // CORS：预检直接放行，实际请求按 origin 白名单校验
    if (request.method === 'OPTIONS') {
      return handlePreflight(request)
    }
    if (!isAllowedOrigin(request)) {
      return json({ ok: false, error: 'forbidden_origin' }, 403)
    }

    try {
      switch (url.pathname) {
        case '/ping':
          return json({ ok: true })

        case '/register':
          if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
          return await handleRegister(request, env)

        case '/login':
          if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
          return await handleLogin(request, env)

        case '/save':
          if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
          return await handleSave(request, env)

        default:
          return json({ ok: false, error: 'not_found' }, 404)
      }
    } catch (e) {
      return json({ ok: false, error: 'server_error' }, 500)
    }
  }
}

// ---------- /register ----------
async function handleRegister(request, env) {
  const ip = getClientIp(request)
  if (!(await allowWrite(env, ip))) {
    return json({ ok: false, error: 'rate_limited' }, 429)
  }

  const body = await readJson(request)
  if (!body) return json({ ok: false, error: 'bad_json' }, 400)

  const id = normalizeId(body.id)
  const password = typeof body.password === 'string' ? body.password : ''
  const idErr = validateId(id)
  if (idErr) return json({ ok: false, error: idErr }, 400)
  const pwErr = validatePassword(password)
  if (pwErr) return json({ ok: false, error: pwErr }, 400)

  // ponytail: 占坑——auth:<id> 已存在即视为被占，拒绝重名注册。
  const existing = await env.SAVES.get(`auth:${id}`)
  if (existing !== null) {
    return json({ ok: false, error: 'id_taken' }, 409)
  }

  const salt = randomSaltHex()
  const hash = await derivePasswordHash(password, salt)
  await env.SAVES.put(
    `auth:${id}`,
    JSON.stringify({ salt, hash, createdAt: Date.now() })
  )

  return json({ ok: true })
}

// ---------- /login ----------
async function handleLogin(request, env) {
  const body = await readJson(request)
  if (!body) return json({ ok: false, error: 'bad_json' }, 400)

  const id = normalizeId(body.id)
  const password = typeof body.password === 'string' ? body.password : ''
  if (!id) return json({ ok: false, error: 'missing_id' }, 400)

  const auth = await getAuth(env, id)
  if (!auth) return json({ ok: false, error: 'id_not_found' }, 404)
  if (!(await verifyPassword(password, auth))) {
    return json({ ok: false, error: 'wrong_password' }, 401)
  }

  // ponytail: 登录成功返回该账户的存档（可能为 null，表示注册后还没存过档）。
  const data = await env.SAVES.get(`save:${id}`)
  return json({ ok: true, data: data ?? null })
}

// ---------- /save ----------
async function handleSave(request, env) {
  const ip = getClientIp(request)
  if (!(await allowWrite(env, ip))) {
    return json({ ok: false, error: 'rate_limited' }, 429)
  }

  const body = await readJson(request)
  if (!body) return json({ ok: false, error: 'bad_json' }, 400)

  const id = normalizeId(body.id)
  const password = typeof body.password === 'string' ? body.password : ''
  const data = typeof body.data === 'string' ? body.data : null
  if (!id) return json({ ok: false, error: 'missing_id' }, 400)
  if (!data) return json({ ok: false, error: 'missing_data' }, 400)
  if (data.length > MAX_DATA_BYTES) {
    return json({ ok: false, error: 'data_too_large' }, 413)
  }

  const auth = await getAuth(env, id)
  if (!auth) return json({ ok: false, error: 'id_not_found' }, 404)
  if (!(await verifyPassword(password, auth))) {
    return json({ ok: false, error: 'wrong_password' }, 401)
  }

  await env.SAVES.put(`save:${id}`, data)
  return json({ ok: true })
}

// ---------- 密码派生 / 校验 ----------

// ponytail: PBKDF2-SHA256 派生密码哈希。WebCrypto 原生，无需外部库。
async function derivePasswordHash(password, saltHex) {
  const enc = new TextEncoder()
  const salt = hexToBytes(saltHex)
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  )
  return bytesToHex(new Uint8Array(bits))
}

async function verifyPassword(password, auth) {
  if (!auth || !auth.salt || !auth.hash) return false
  const hash = await derivePasswordHash(password, auth.salt)
  return timingSafeEqual(hash, auth.hash)
}

async function getAuth(env, id) {
  const raw = await env.SAVES.get(`auth:${id}`)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ponytail: 常量时间比较，避免按字符早退泄漏时序信息（两串等长的 hex）。
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// ---------- 校验 / 归一化 ----------

// ponytail: id 大小写不敏感——统一 trim + 转小写，避免"Abc"和"abc"占两个坑。
function normalizeId(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

function validateId(id) {
  if (!id) return 'missing_id'
  // ponytail: 用字节长度约束（中文占 3 字节），挡超长恶意 key。
  if (utf8ByteLength(id) > MAX_ID_BYTES) return 'id_too_long'
  return null
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    return 'missing_password'
  }
  if (password.length > MAX_PASSWORD_LEN) return 'password_too_long'
  return null
}

// ---------- 鉴权 / 限速 ----------

function isAllowedOrigin(request) {
  const origin = request.headers.get('Origin') || request.headers.get('Referer')
  if (!origin) return false // 不带来源的请求一律拒绝（curl 直怼挡掉）
  let host
  try {
    host = new URL(origin).hostname
  } catch {
    return false
  }
  return ALLOWED_ORIGINS.some(
    allowed => host === allowed || host.endsWith('.' + allowed)
  )
}

// ponytail: 限速用 KV 计数器简单实现。KV 最终一致，极端并发下可能多放几笔，
//           修仙存档场景无所谓，不引入 Durable Objects 增加 60s 硬下限。
async function allowWrite(env, ip) {
  const windowStart = Math.floor(Date.now() / 60000) // 每分钟一个窗口
  const counterKey = `rl:${ip}:${windowStart}`
  const raw = await env.SAVES.get(counterKey)
  const count = raw ? parseInt(raw, 10) : 0
  if (count >= MAX_WRITES_PER_MIN) return false
  await env.SAVES.put(counterKey, String(count + 1), {
    expirationTtl: 120 // ponytail: 120s TTL 自动清理过期窗口的计数器，无需手动 GC
  })
  return true
}

function handlePreflight(request) {
  const origin = request.headers.get('Origin') || ''
  // ponytail: 预检宽松通过，真正校验在 isAllowedOrigin；不在这里挡避免 CORS 排错困难。
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  })
}

// ---------- 工具 ----------

async function readJson(request) {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function getClientIp(request) {
  // ponytail: CF Workers 里真实客户端 IP 走 cf-connecting-ip，通过代理时才是 XFF。
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  )
}

function randomSaltHex() {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  return bytesToHex(buf)
}

function bytesToHex(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return bytes
}

function utf8ByteLength(str) {
  return new TextEncoder().encode(str).length
}

function json(obj, status = 200) {
  // ponytail: 所有响应统一带 CORS 头，前端跨域从 Pages 调 Worker 不踩坑。
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  }
  return new Response(JSON.stringify(obj), { status, headers })
}
