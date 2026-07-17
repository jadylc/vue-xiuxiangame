// ponytail: 云存档客户端封装 —— 所有 KV 调用集中于此,避免 fetch 逻辑散落到组件。
// 账户模式:用户名 + 密码。凭证存本地,自动存档时带上;新设备登录后拉回存档。
// 设计:localStorage-first,登录后云端才生效;所有云调用异常静默吞,绝不阻断游戏。

// ponytail: Worker URL,用自定义域名,workers.dev 在国内 DNS 污染连不上。
const WORKER_URL = 'https://xx.ygmm.de'

// ponytail: 本地凭证 key。凭证和存档('vuex')分开存,换设备时凭证在,存档可重新拉。
const CRED_KEY = 'cloudCred'

// ponytail: 读本地凭证 { id, password }。未登录返回 null。
export function getCred() {
  try {
    const raw = localStorage.getItem(CRED_KEY)
    if (!raw) return null
    const cred = JSON.parse(raw)
    return cred && cred.id && cred.password ? cred : null
  } catch {
    return null
  }
}

export function setCred(id, password) {
  localStorage.setItem(CRED_KEY, JSON.stringify({ id, password }))
}

export function clearCred() {
  localStorage.removeItem(CRED_KEY)
}

export function isLoggedIn() {
  return getCred() !== null
}

// ponytail: 统一 POST 封装,异常/非 2xx 都转成 { ok:false, error }。
async function post(path, payload) {
  try {
    const res = await fetch(`${WORKER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return await res.json()
  } catch {
    return { ok: false, error: 'network_error' }
  }
}

// 注册账户。成功后不自动登录,交给调用方决定(通常紧接一次 login/save)。
export async function register(id, password) {
  return await post('/register', { id, password })
}

// 登录。成功返回 { ok:true, data }(data 为该账户云端存档,可能 null)。
// ponytail: 登录成功即把凭证写入本地,后续自动存档会带上。
export async function login(id, password) {
  const res = await post('/login', { id, password })
  if (res.ok) setCred(id, password)
  return res
}

// 上送存档到云端。data 即 localStorage['vuex'](已是加密串)。
// ponytail: fire-and-forget 调用点不 await;未登录直接跳过(退化为本地 only)。
export async function cloudSave(data) {
  if (!data) return null
  const cred = getCred()
  if (!cred) return null // 未登录不上云
  const res = await post('/save', { id: cred.id, password: cred.password, data })
  return res.ok ? true : null
}

// 启动恢复:已登录 + 本地存档为空(换设备/清缓存)时,从云端拉回存档写入本地。
// ponytail: 仅在本地 vuex 为空时拉,避免用旧云档覆盖新本地档。
export async function tryRestore() {
  const cred = getCred()
  if (!cred) return false
  if (localStorage.getItem('vuex')) return false // 本地有档,优先本地
  const res = await post('/login', { id: cred.id, password: cred.password })
  if (res.ok && res.data) {
    localStorage.setItem('vuex', res.data)
    return true
  }
  return false
}
