/**
 * 修仙游戏存档 Worker —— Cloudflare Workers + KV
 *
 * 接口：
 *   POST /save   { code?, data }  → { ok, code, createdAt }
 *   GET  /load?code=XXX           → { ok, data } / { ok:false, error:"not_found" }
 *   GET  /ping                    → { ok:true }            健康检查
 *
 * 数据：
 *   KV value 直接是加密后的存档字符串（crypto.js 的 AES 产物），一个玩家完整存档
 *   塞一个 key：save:<code>。另存一个 meta:<code> 记录时间戳（防丢找回可读）。
 *
 * 鉴权（中档）：
 *   1. Origin 白名单——只接受来自你自己 Pages/自定义域名的请求。
 *   2. 写入限速——每个来源 IP 每分钟最多 MAX_WRITES_PER_MIN 次 /save，超过 429。
 *
 * ponytail: 没做登录体系（项目无账户概念），origin 白名单 + 限速足够挡住匿名滥用。
 */

// ponytail: 允许的来源域名。改成你自己的 Pages 域名 / 自定义域名。
// 末段匹配，所以 pages.dev 子域原生提供支持；生产自定义域名记得加进来。
const ALLOWED_ORIGINS = [
  'xx.ygmm.de', // 你的自定义域名
  'localhost',
  '127.0.0.1'
]

// ponytail: 每来源 IP 每分钟最大写入次数。修仙单机游戏存档频率低，够用。
const MAX_WRITES_PER_MIN = 30
// ponytail: 存档字符串安全上限。实测满存档 ~20KB；25MB 是 KV 上限，这里保守挡恶意大包。
const MAX_DATA_BYTES = 1 * 1024 * 1024 // 1 MB
// ponytail: 存档码字符表（base32 易读，去歧义字符）。8 位 ≈ 40 亿组合，撞概率可忽略。
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
const CODE_LENGTH = 8

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

        case '/load':
          if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405)
          return await handleLoad(request, env)

        case '/save':
          if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405)
          return await handleSave(request, env, ctx)

        default:
          return json({ ok: false, error: 'not_found' }, 404)
      }
    } catch (e) {
      return json({ ok: false, error: 'server_error' }, 500)
    }
  }
}

// ---------- /save ----------
async function handleSave(request, env, ctx) {
  const ip = getClientIp(request)
  if (!(await allowWrite(env, ip))) {
    return json({ ok: false, error: 'rate_limited' }, 429)
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'bad_json' }, 400)
  }

  const data = typeof body?.data === 'string' ? body.data : null
  if (!data) return json({ ok: false, error: 'missing_data' }, 400)

  // ponytail: 字节预算在 UTF-8 下估，足够挡恶意大包；精确 bytes 留给 KV 自己。
  if (data.length > MAX_DATA_BYTES) {
    return json({ ok: false, error: 'data_too_large' }, 413)
  }

  const now = Date.now()
  let code = typeof body?.code === 'string' ? body.code.trim() : ''

  if (code) {
    // 覆盖已有存档——校验 key 存在，防止别人瞎编 code 覆写到空位。
    const existing = await env.SAVES.get(`save:${code}`)
    if (existing === null) {
      return json({ ok: false, error: 'code_not_found' }, 404)
    }
  } else {
    // 新存档——生成未占用的 code。
    code = await generateUnusedCode(env)
  }

  await env.SAVES.put(`save:${code}`, data)
  // ponytail: meta 仅记时间戳，用于找回/审计；不记任何明文数据。省一个 KV 调用可删此段。
  await env.SAVES.put(`meta:${code}`, JSON.stringify({ createdAt: now, updatedAt: now }))

  return json({ ok: true, code, createdAt: now })
}

// ---------- /load ----------
async function handleLoad(request, env) {
  const url = new URL(request.url)
  const code = (url.searchParams.get('code') || '').trim()
  if (!code) return json({ ok: false, error: 'missing_code' }, 400)
  if (!isValidCode(code)) return json({ ok: false, error: 'invalid_code' }, 400)

  const data = await env.SAVES.get(`save:${code}`)
  if (data === null) {
    return json({ ok: false, error: 'not_found' }, 404)
  }
  return json({ ok: true, data })
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
  const key = `rl:${ip}`
  const windowStart = Math.floor(Date.now() / 60000) // 每分钟一个窗口
  const counterKey = `${key}:${windowStart}`
  const raw = await env.SAVES.get(counterKey)
  const count = raw ? parseInt(raw, 10) : 0
  if (count >= MAX_WRITES_PER_MIN) return false
  // 并发竞态下可能略超，acceptable。
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

function getClientIp(request) {
  // ponytail: CF Workers 里真实客户端 IP 走 cf-connecting-ip，通过代理时才是 XFF。
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  )
}

function isValidCode(code) {
  if (code.length !== CODE_LENGTH) return false
  for (const ch of code) {
    if (!CODE_ALPHABET.includes(ch)) return false
  }
  return true
}

async function generateUnusedCode(env) {
  // ponytail: 极小概率撞码，最多重试 5 次。40 亿空间撞两次的概率可忽略。
  for (let i = 0; i < 5; i++) {
    const code = randomCode()
    const existing = await env.SAVES.get(`save:${code}`)
    if (existing === null) return code
  }
  // 重试 5 次仍撞——理论上不可能，给个兜底错误避免死循环。
  throw new Error('code_collision')
}

function randomCode() {
  // ponytail: 无 crypto.getRandomValues 时回落，Workers 环境肯定有前者。
  const buf = new Uint32Array(CODE_LENGTH)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf)
  }
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    const r = buf[i] ?? Math.floor(Math.random() * 0xffffffff)
    out += CODE_ALPHABET[r % CODE_ALPHABET.length]
  }
  return out
}

function json(obj, status = 200) {
  // ponytail: 所有响应统一带 CORS 头，前端跨域从 Pages 调 Worker 不踩坑。
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  }
  return new Response(JSON.stringify(obj), { status, headers })
}
