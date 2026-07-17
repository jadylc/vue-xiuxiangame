// ponytail: 云存档客户端封装 —— 所有 KV 调用集中于此,避免 fetch 逻辑散落到组件。
// 设计:localStorage-first,KV 是"同步 + 防丢"补充层。所有云调用异常静默吞,绝不阻断游戏。

// ponytail: Worker URL,部署后回填真实域名。用自定义域名,workers.dev 在国内 DNS 污染连不上。
const WORKER_URL = 'https://xx.ygmm.de'

// ponytail: 存档码本地记忆 key。和存档本身('vuex')分开存,便于换设备时单独恢复。
const SAVE_CODE_KEY = 'saveCode'

export function getSaveCode() {
  return localStorage.getItem(SAVE_CODE_KEY) || ''
}

export function setSaveCode(code) {
  if (code) localStorage.setItem(SAVE_CODE_KEY, code)
}

// 上送存档到 KV。data 即 localStorage['vuex'] 的内容(已是加密串)。
// code 缺省时服务端新建并返回;之后本地记住这个 code。
// ponytail: fire-and-forget,返回 null 表示失败,调用方无需处理(顶多没同步上云)。
export async function cloudSave(data) {
  if (!data) return null
  try {
    const res = await fetch(`${WORKER_URL}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: getSaveCode(), data })
    })
    const json = await res.json()
    if (json.ok) {
      setSaveCode(json.code)
      return json.code
    }
    return null
  } catch {
    // ponytail: 网络失败静默吞,不阻塞游戏;下次存档再补传
    return null
  }
}

// 按存档码从 KV 拉回存档字符串。
export async function cloudLoad(code) {
  try {
    const res = await fetch(`${WORKER_URL}/load?code=${encodeURIComponent(code)}`)
    const json = await res.json()
    return json.ok ? json.data : null
  } catch {
    return null
  }
}

// 启动恢复:本地有 saveCode 但本地存档丢了(换浏览器/清缓存),尝试从云端拉回。
// ponytail: 仅在本地 vuex 为空时拉云端,避免用旧云档覆盖新本地档。
export async function tryRestore() {
  const code = getSaveCode()
  if (code && !localStorage.getItem('vuex')) {
    const data = await cloudLoad(code)
    if (data) {
      localStorage.setItem('vuex', data)
      return code
    }
  }
  return null
}
