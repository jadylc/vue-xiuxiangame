// ponytail: 云存档客户端封装 —— 所有 KV 调用集中于此,避免 fetch 逻辑散落到组件。
// 账户模式:用户名 + 密码。凭证存本地,自动存档时带上;新设备登录后拉回存档。
//
// 防回档核心模型(重要):
//   本地维护一个"存档内容版本" localRev —— 本地每次存档就立即 +1(不依赖上传成功)。
//   上传时把 localRev 作为 rev 带给云端;云端拒绝旧 rev 覆盖新 rev。
//   多设备同步判断:只有 云端rev > 本地localRev 才拉回(说明另一台设备存了更新的进度)。
//   关键:localRev 反映"本地存档内容"的版本,本地只要在动它就在涨,
//        因此本地领先云端时绝不会被云端旧档误覆盖 —— 这是之前回档 bug 的根治。
//
// 设计:localStorage-first,登录后云端才生效;所有云调用异常静默吞,绝不阻断游戏。

// ponytail: Worker URL,用自定义域名,workers.dev 在国内 DNS 污染连不上。
const WORKER_URL = 'https://xx.ygmm.de'

// ponytail: 本地凭证 key。凭证和存档('vuex')分开存,换设备时凭证在,存档可重新拉。
const CRED_KEY = 'cloudCred'
// ponytail: 本地存档内容版本号。本地每次存档 +1;上传作为 rev,拉回时设为云端 rev。
const LOCAL_REV_KEY = 'cloudLocalRev'

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
  // ponytail: 登出连带清掉本地版本号,避免下次登录别的账户时误判版本新旧。
  localStorage.removeItem(LOCAL_REV_KEY)
}

export function isLoggedIn() {
  return getCred() !== null
}

// ponytail: 本地版本号读写。缺省 0(从没同步过)。
function getLocalRev() {
  return parseInt(localStorage.getItem(LOCAL_REV_KEY) || '0', 10) || 0
}
export function setLocalRev(rev) {
  if (rev) localStorage.setItem(LOCAL_REV_KEY, String(rev))
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

// 登录。成功返回 { ok:true, data, rev }(data 为该账户云端存档,可能 null)。
// ponytail: 登录成功即把凭证写入本地,后续自动存档会带上。不在这里动 localRev,
//           交给调用方(见 homePage 的 doCloudLogin)按"拉回/上传"场景显式设置。
export async function login(id, password) {
  const res = await post('/login', { id, password })
  if (res.ok) setCred(id, password)
  return res
}

// 上送存档到云端。data 即 localStorage['vuex'](已是加密串)。
// ponytail: 每次调用把本地版本 +1 作为 rev 上传 —— 本地存档内容的版本立即前进,
//           不依赖上传成功。上传成功后本地 rev 已是最新,云端也是最新,一致。
//           即使这次网络失败,本地 rev 已 +1,下次进入时云端 rev 不会 > 本地,不会误拉回。
export async function cloudSave(data) {
  if (!data) return null
  const cred = getCred()
  if (!cred) return null // 未登录不上云
  // 本地版本前进一格,作为这次上传的 rev
  const rev = getLocalRev() + 1
  setLocalRev(rev)
  const res = await post('/save', { id: cred.id, password: cred.password, data, rev })
  // ponytail: 云端返回 stale 表示我这个 rev 比云端旧(理论上不该发生,除非多设备并发)。
  //           这种情况把本地 rev 对齐到云端,下次 check 会拉回云端的新版本。
  if (res.ok && res.stale && res.rev) setLocalRev(res.rev)
  return res.ok ? true : null
}

// 启动恢复:已登录 + 本地存档为空(换设备/清缓存)时,从云端拉回存档写入本地。
// ponytail: 仅在本地 vuex 为空时拉。拉回后把本地 rev 设为云端 rev,视为"本地=云端最新"。
export async function tryRestore() {
  const cred = getCred()
  if (!cred) return false
  if (localStorage.getItem('vuex')) return false // 本地有档,优先本地
  const res = await post('/login', { id: cred.id, password: cred.password })
  if (res.ok && res.data) {
    localStorage.setItem('vuex', res.data)
    setLocalRev(res.rev || 0)
    return true
  }
  return false
}

// 检查云端是否有比本地更新的存档(另一台设备上传的),有则拉回写入本地。
// 返回 true 表示拉到了新存档(调用方应提示用户并刷新页面)。
// ponytail: 只有 云端rev > 本地localRev 才拉。本地只要在存档 localRev 就在涨,
//           所以本地领先时绝不会被拉回覆盖 —— 根治回档。
//           先用轻量 /check 只比 rev,确认云端更新了再 /login 拉整个存档,省流量。
export async function checkAndPull() {
  const cred = getCred()
  if (!cred) return false
  const chk = await post('/check', { id: cred.id, password: cred.password })
  if (!chk.ok) return false
  // 云端 rev 不大于本地,说明本地是最新(或持平),不拉
  if (!chk.rev || chk.rev <= getLocalRev()) return false
  const res = await post('/login', { id: cred.id, password: cred.password })
  if (res.ok && res.data) {
    localStorage.setItem('vuex', res.data)
    setLocalRev(res.rev || 0)
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
