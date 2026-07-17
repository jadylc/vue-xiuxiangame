import App from './App.vue'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'element-plus/dist/index.css'
import router from '@/plugins/router'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import ElementPlus from 'element-plus'
import { tryRestore, checkAndPull, startAutoSync } from '@/plugins/cloudSave'

const app = createApp(App)

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)
app.use(pinia)

for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(router)
app.use(ElementPlus)
// ponytail: 异步恢复云端存档后再 mount。用 IIFE 包裹避免顶层 await(esbuild prod target=es2020 不支持顶层 await)
;(async () => {
  // 本地存档为空时从云端拉回(换设备/清缓存首次登录)
  await tryRestore()
  // 本地有档但云端另一台设备有更新时也拉回——多设备同步的关键
  // ponytail: 启动阶段还没 mount,直接写 localStorage 即可,pinia 初始化时会读到最新的
  await checkAndPull()
  app.mount('#app')
  // 切回前台时检查其他设备的新进度,拉到则自动刷新载入(用户选择"自动加载并提示")
  startAutoSync(() => {
    // ponytail: 新档已写入 localStorage。存一个标记,刷新后由页面提示"已同步",不阻塞当前操作。
    sessionStorage.setItem('cloudSynced', '1')
    location.reload()
  })
})()
