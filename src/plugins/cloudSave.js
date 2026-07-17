// ponytail: 云存档客户端封装 —— 所有 KV 调用集中于此,避免 fetch 逻辑散落到组件。
// 账户模式:用户名 + 密码。凭证存本地,自动存档时带上;新设备登录后拉回存档。
// 多设备同步:本地记住上次同步的云端时间戳,启动/切前台时 check 云端是否更新,更新则拉回。
// 设计:localStorage-first,登录后云端才生效;所有云调用异常静默吞,绝不阻断游戏。

// ponytail: Worker URL,用自定义域名,workers.dev 在国内 DNS 污染连不上。
const WORKER_URL = 'https://xx.ygmm.de'

// ponytail: 本地凭证 key。凭证和存档('vuex')分开存,换设备时凭证在,存档可重新拉。
const CRED_KEY = 'cloudCred'
// ponytail: 上次同步的云端时间戳。save 成功/login 拉回后更新;check 时和云端比对判断新旧。
const SYNC_TS_KEY = 'cloudSyncTs'

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
  // ponytail: 登出连带清掉同步时间戳,避免下次登录别的账户时误判版本新旧。
  localStorage.removeItem(SYNC_TS_KEY)
}

export function isLoggedIn() {
  return getCred() !== null
}

// ponytail: 上次同步时间戳读写。缺省 0(从没同步过)。
function getSyncTs() {
  return parseInt(localStorage.getItem(SYNC_TS_KEY) || '0', 10) || 0
}
export function setSyncTs(ts) {
  if (ts) localStorage.setItem(SYNC_TS_KEY, String(ts))
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

// 登录。成功返回 { ok:true, data, updatedAt }(data 为该账户云端存档,可能 null)。
// ponytail: 登录成功即把凭证写入本地,后续自动存档会带上。
export async function login(id, password) {
  const res = await post('/login', { id, password })
  if (res.ok) setCred(id, password)
  return res
}

// 上送存档到云端。data 即 localStorage['vuex'](已是加密串)。
// ponytail: 成功后记录云端时间戳,标记"本地即云端最新版本",避免自己刚传又被 check 拉回。
export async function cloudSave(data) {
  if (!data) return null
  const cred = getCred()
  if (!cred) return null // 未登录不上云
  const res = await post('/save', { id: cred.id, password: cred.password, data })
  if (res.ok) {
    setSyncTs(res.updatedAt)
    return true
  }
  return null
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
    setSyncTs(res.updatedAt)
    return true
  }
  return false
}

// 检查云端是否有比本地更新的存档(另一台设备上传的),有则拉回写入本地并更新时间戳。
// 返回 true 表示拉到了新存档(调用方应提示用户并刷新页面)。
// ponytail: 只有云端时间戳 > 本地上次同步时间戳才拉,不会误覆盖本地刚产生的进度。
//           先用轻量 /check 只比时间戳,确认更新了再 /login 拉整个存档,省流量。
export async function checkAndPull() {
  const cred = getCred()
  if (!cred) return false
  const chk = await post('/check', { id: cred.id, password: cred.password })
  if (!chk.ok || !chk.updatedAt) return false
  if (chk.updatedAt <= getSyncTs()) return false // 云端不比本地新,不拉
  const res = await post('/login', { id: cred.id, password: cred.password })
  if (res.ok && res.data) {
    localStorage.setItem('vuex', res.data)
    setSyncTs(res.updatedAt)
    return true
  }
  return false
}

// 启动多设备自动同步:页面回到前台时检查云端是否有其他设备的新进度。
// ponytail: 不做定时轮询——只在切回前台时查,避免游戏中途被拉取覆盖 + 省请求。
//           onPulled 在拉到新存档时回调(调用方负责提示 + 刷新)。
export function startAutoSync(onPulled) {
  if (typeof document === 'undefined') return
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return
    const pulled = await checkAndPull()
    if (pulled && typeof onPulled === 'function') onPulled()
  })
}
