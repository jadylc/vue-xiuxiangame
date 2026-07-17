import App from './App.vue'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import 'element-plus/dist/index.css'
import router from '@/plugins/router'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import ElementPlus from 'element-plus'
import { tryRestore } from '@/plugins/cloudSave'

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
  await tryRestore()
  app.mount('#app')
})()
