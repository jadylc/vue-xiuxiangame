/**
 * 修仙游戏存档 Worker —— Cloudflare Workers + D1
 *
 * 账户模式：用户名 + 密码（无邮箱/手机，纯匿名账户）
 *
 * 接口：
 *   POST /register { id, password }              → { ok } / { ok:false, error:"id_taken" }
 *   POST /login    { id, password }              → { ok, data, rev, updatedAt } / { ok:false, error:... }
 *   POST /check    { id, password }              → { ok, rev, updatedAt }
 *   POST /save     { id, password, data, rev }   → { ok, rev } / { ok:false, error:... }
 *   GET  /ping                                   → { ok:true }   健康检查
 *
 * 数据（D1 表，见 schema.sql）：
 *   accounts(id, salt, hash, created_at)         密码 PBKDF2-SHA256 派生，挡爆破
 *   saves(id, data, rev, updated_at)             data 为加密存档串，rev 为版本号(防回档)
 *
 * ponytail: 从 KV 迁到 D1 的原因——KV 免费额度每天 1000 写,挂机游戏每秒触发存档会瞬间打爆。
 *           D1 每天 10 万写,配合前端 30s 节流上传,单玩家每分钟最多 2 次写,额度绰绰有余。
 *
 * 鉴权：
 *   1. Origin 白名单——只接受来自你自己 Pages/自定义域名的请求。
 *   2. 写入限速——每个来源 IP 每分钟最多 MAX_WRITES_PER_MIN 次写(内存态,配合前端节流足够)。
 *   3. 用户名 + 密码——存/取存档必须带正确凭证。
 */

// ponytail: 允许的来源域名。末段匹配，pages.dev 子域原生支持；生产自定义域名记得加进来。
const ALLOWED_ORIGINS = [
  'xiu.ygmm.de', // Pages 前端自定义域名(玩家访问入口)
  'xx.ygmm.de', // Worker 后端自定义域名(自身回环备用)
  'localhost',
  '127.0.0.1'
]

// ponytail: 每来源 IP 每分钟最大写入次数。前端已 30s 节流,这里是防滥用的第二道闸。
const MAX_WRITES_PER_MIN = 30
// ponytail: 存档字符串安全上限。实测满存档 ~20KB；这里保守挡恶意大包。
const MAX_DATA_BYTES = 1 * 1024 * 1024 // 1 MB
// ponytail: id / 密码长度约束（挡空值和超长恶意输入；不限字符集）。
const MAX_ID_BYTES = 256
const MIN_PASSWORD_LEN = 1
const MAX_PASSWORD_LEN = 128
// ponytail: PBKDF2 迭代轮数。10 万轮在 Workers CPU 时限内可接受，且显著抬高爆破成本。
const PBKDF2_ITERATIONS = 100000

// ponytail: 限速内存态。per-isolate,冷启动会重置——但配合前端 30s 节流 + origin 白名单,
//           作为防滥用足够,且不消耗 D1 写额度(这正是迁 D1 要省的东西)。
const rateBuckets = new Map()

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

        case '/check':
          if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
          return await handleCheck(request, env)

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
  if (!allowWrite(ip)) {
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

  // ponytail: 占坑——accounts 已有该 id 即视为被占，拒绝重名注册。
  const existing = await env.DB.prepare('SELECT id FROM accounts WHERE id = ?').bind(id).first()
  if (existing) {
    return json({ ok: false, error: 'id_taken' }, 409)
  }

  const salt = randomSaltHex()
  const hash = await derivePasswordHash(password, salt)
  await env.DB.prepare('INSERT INTO accounts (id, salt, hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, salt, hash, Date.now())
    .run()

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
  //           同时返回 updatedAt + rev，供前端判断云端版本新旧、做多设备同步。
  const save = await env.DB.prepare('SELECT data, rev, updated_at FROM saves WHERE id = ?').bind(id).first()
  return json({
    ok: true,
    data: save?.data ?? null,
    rev: save?.rev ?? 0,
    updatedAt: save?.updated_at ?? 0,
    // ponytail: 是否管理员——前端据此决定是否显示道具修改器入口(轻量控制,非服务端强鉴权)。
    isAdmin: auth.is_admin === 1
  })
}

// ---------- /save ----------
async function handleSave(request, env) {
  const ip = getClientIp(request)
  if (!allowWrite(ip)) {
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

  // ponytail: rev = 客户端存档内容版本。多设备同步靠它判断新旧。
  const rev = typeof body.rev === 'number' ? body.rev : Date.now()

  // ponytail: 拒绝旧 rev 覆盖新 rev——防 fire-and-forget 并发/乱序上传把旧存档盖到新存档上。
  //           这是防回档的服务端最后一道闸:即使请求乱序到达,云端也只保留最新版本。
  const existing = await env.DB.prepare('SELECT rev FROM saves WHERE id = ?').bind(id).first()
  if (existing && existing.rev && rev < existing.rev) {
    return json({ ok: true, rev: existing.rev, stale: true })
  }

  const updatedAt = Date.now()
  // ponytail: UPSERT——首次存档 INSERT,之后 ON CONFLICT 更新。一条 SQL 搞定,一次写。
  await env.DB.prepare(
    `INSERT INTO saves (id, data, rev, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at`
  )
    .bind(id, data, rev, updatedAt)
    .run()

  return json({ ok: true, rev, updatedAt })
}

// ---------- /check ----------
// ponytail: 轻量版本检查——只返回云端存档 rev + 时间戳，不传整个存档，省流量。
//           前端切前台时调用，判断云端是否有比本地更新的进度。
async function handleCheck(request, env) {
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

  const save = await env.DB.prepare('SELECT rev, updated_at FROM saves WHERE id = ?').bind(id).first()
  return json({ ok: true, rev: save?.rev ?? 0, updatedAt: save?.updated_at ?? 0 })
}

// ---------- 账户读取 ----------

async function getAuth(env, id) {
  // ponytail: 返回 { salt, hash, is_admin } 供密码校验 + 管理员判断;不存在返回 null。
  //           is_admin 必须一起查出来,否则 login 里 auth.is_admin 为 undefined,永远判非管理员。
  return await env.DB.prepare('SELECT salt, hash, is_admin FROM accounts WHERE id = ?').bind(id).first()
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
  // ponytail: 用字节长度约束（中文占 3 字节），挡超长恶意 id。
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

// ponytail: 内存态限速——per-isolate 的滑动窗口计数。冷启动重置,但配合前端 30s 节流
//           + origin 白名单足够防滥用,且不消耗 D1 写额度。
function allowWrite(ip) {
  const now = Date.now()
  const windowStart = Math.floor(now / 60000)
  const bucket = rateBuckets.get(ip)
  if (!bucket || bucket.window !== windowStart) {
    rateBuckets.set(ip, { window: windowStart, count: 1 })
    // ponytail: 顺手清理陈旧桶,避免内存无限增长(单 isolate 内很少量,足够)。
    if (rateBuckets.size > 5000) {
      for (const [k, v] of rateBuckets) {
        if (v.window < windowStart) rateBuckets.delete(k)
      }
    }
    return true
  }
  if (bucket.count >= MAX_WRITES_PER_MIN) return false
  bucket.count++
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
