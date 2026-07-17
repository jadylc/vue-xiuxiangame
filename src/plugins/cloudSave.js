// ponytail: 云存档客户端封装 —— 所有云端调用集中于此,避免 fetch 逻辑散落到组件。
// 账户模式:用户名 + 密码。凭证存本地,自动存档时带上;新设备登录后拉回存档。
//
// 防回档核心模型(重要):
//   本地维护一个"存档内容版本" localRev —— 本地每次存档就立即前进(用时间戳,不依赖上传)。
//   上传时把 localRev 作为 rev 带给云端;云端拒绝旧 rev 覆盖新 rev。
//   多设备同步判断:只有 云端rev > 本地localRev 才拉回(说明另一台设备存了更新的进度)。
//   关键:localRev 反映"本地存档内容"的版本,本地只要在动它就在涨,
//        因此本地领先云端时绝不会被云端旧档误覆盖 —— 这是回档 bug 的根治。
//
// 上传节流(重要):游戏挂机/战斗每秒触发多次存档,若每次都上传会打爆云端写额度。
//   所以 cloudSave 只更新 localRev + 记住最新 data,真正的网络上传按 THROTTLE_MS 节流,
//   最多每 30 秒传一次;离开页面(切后台/关闭)时用 flushSave 立即补传最新,保证不丢进度。
//   本地 localStorage 存档始终实时(由 pinia persist 负责),节流只影响"上传到云端"的频率。
//
// 设计:localStorage-first,登录后云端才生效;所有云调用异常静默吞,绝不阻断游戏。

// ponytail: Worker URL,用自定义域名,workers.dev 在国内 DNS 污染连不上。
const WORKER_URL = 'https://xx.ygmm.de'

// ponytail: 本地凭证 key。凭证和存档('vuex')分开存,换设备时凭证在,存档可重新拉。
const CRED_KEY = 'cloudCred'
// ponytail: 本地存档内容版本号。本地每次存档更新为当前时间戳;上传作为 rev,拉回时设为云端 rev。
const LOCAL_REV_KEY = 'cloudLocalRev'

// ponytail: 上传节流间隔。30 秒——省额度,最多丢 30 秒进度(离开时 flush 补传兜底)。
const THROTTLE_MS = 30000

// ---------- 节流状态(模块级) ----------
let pendingData = null // 待上传的最新存档串;null 表示没有待传
let lastUploadAt = 0 // 上次真正发起上传的时刻
let trailingTimer = null // trailing 定时器句柄

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
  // 清掉待传状态,避免登出后还把上个账户的存档传出去
  pendingData = null
  if (trailingTimer) {
    clearTimeout(trailingTimer)
    trailingTimer = null
  }
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

// 本地存档时调用(pinia serialize 里)。只更新本地版本 + 记住最新 data,按节流决定何时真正上传。
// ponytail: 高频调用安全——每秒调多次也只是刷新 pendingData/localRev,网络上传最多 30 秒一次。
export function cloudSave(data) {
  if (!data) return
  const cred = getCred()
  if (!cred) return // 未登录不上云
  // 本地内容版本立即前进(时间戳,单调递增)——不依赖上传成功,本地永远领先云端旧档。
  setLocalRev(Date.now())
  pendingData = data
  scheduleUpload()
}

// ponytail: 节流调度。距上次上传够久就立即传;否则挂一个 trailing 定时器,到点用最新 data 传。
//           trailing 保证"最后一次存档"最终会上传,不会因为一直在节流窗口内而永久丢失。
function scheduleUpload() {
  const elapsed = Date.now() - lastUploadAt
  if (elapsed >= THROTTLE_MS) {
    doUpload()
  } else if (!trailingTimer) {
    trailingTimer = setTimeout(() => {
      trailingTimer = null
      doUpload()
    }, THROTTLE_MS - elapsed)
  }
}

// ponytail: 带恢复的上传核心。/save 遇到 id_not_found(账户在云端不存在)时,
//           用本地凭证自动 register 再重试一次 —— 透明迁移 KV 时代的老账户到 D1,用户无感。
//           这是从 KV 换 D1 后老账户凭证还在本地、但 D1 里没这账户的补救。
async function saveWithRecovery(data, rev) {
  const cred = getCred()
  if (!cred) return { ok: false, error: 'no_cred' }
  let res = await post('/save', { id: cred.id, password: cred.password, data, rev })
  if (!res.ok && res.error === 'id_not_found') {
    // 账户在云端不存在 → 用本地凭证注册(占坑),成功后重试上传
    const reg = await post('/register', { id: cred.id, password: cred.password })
    if (reg.ok) {
      res = await post('/save', { id: cred.id, password: cred.password, data, rev })
    }
  }
  // 云端返回 stale 表示我这个 rev 比云端旧(多设备并发),把本地 rev 对齐云端,下次 check 会拉回。
  if (res && res.ok && res.stale && res.rev) setLocalRev(res.rev)
  return res
}

// ponytail: 真正的网络上传。取当前 pendingData,带上本地 rev。
async function doUpload() {
  if (!pendingData) return
  const cred = getCred()
  if (!cred) return
  const data = pendingData
  pendingData = null
  lastUploadAt = Date.now()
  const rev = getLocalRev()
  await saveWithRecovery(data, rev)
}

// 立即上传指定存档,不走节流(用于登录后首次同步、导出存档等需要即时落云的场景)。
// ponytail: 返回 Promise,调用方可 await 确认结果。会同步更新 localRev + 清掉待传状态,
//           避免刚立即传完又被节流的 trailing 定时器重复传一次旧数据。
export async function cloudSaveNow(data) {
  if (!data) return null
  const cred = getCred()
  if (!cred) return null
  // 立即传也让本地版本前进,与云端保持一致
  setLocalRev(Date.now())
  // 取消挂起的节流上传,避免重复
  pendingData = null
  if (trailingTimer) {
    clearTimeout(trailingTimer)
    trailingTimer = null
  }
  lastUploadAt = Date.now()
  const rev = getLocalRev()
  const res = await saveWithRecovery(data, rev)
  return res && res.ok ? true : null
}

// 立即把待传存档上送云端(离开页面时调用)。用 fetch keepalive 保证请求在页面卸载后仍发出。
// ponytail: 移动端 beforeunload 不可靠,主要靠 visibilitychange→hidden 触发这里。
//           keepalive 让请求脱离页面生命周期继续发送,不 await(离开时也等不到响应)。
export function flushSave() {
  if (trailingTimer) {
    clearTimeout(trailingTimer)
    trailingTimer = null
  }
  if (!pendingData) return
  const cred = getCred()
  if (!cred) return
  const data = pendingData
  pendingData = null
  lastUploadAt = Date.now()
  const rev = getLocalRev()
  try {
    fetch(`${WORKER_URL}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: cred.id, password: cred.password, data, rev }),
      keepalive: true // 关键:页面卸载后请求仍继续发送
    }).catch(() => {})
  } catch {
    // 静默吞,离开页面时不阻塞
  }
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

// 启动多设备自动同步:页面切后台时补传本地进度,回到前台时检查其他设备的新进度。
// ponytail: hidden→flush 保证离开前云端拿到最新;visible→checkAndPull 拉回其他设备的更新。
//           不做定时轮询,避免游戏中途被拉取覆盖 + 省请求。
//           onPulled 在拉到新存档时回调(调用方负责提示 + 刷新)。
export function startAutoSync(onPulled) {
  if (typeof document === 'undefined') return
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') {
      // 切后台/关闭前,立即补传最新进度
      flushSave()
      return
    }
    if (document.visibilityState === 'visible') {
      const pulled = await checkAndPull()
      if (pulled && typeof onPulled === 'function') onPulled()
    }
  })
  // ponytail: 桌面端关闭标签页时也补传一次(移动端此事件不可靠,靠上面的 hidden 兜底)。
  window.addEventListener('beforeunload', () => flushSave())
}
