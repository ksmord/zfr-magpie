/**
 * zfr-magpie —— 把本地 zfr-core 网关接成 Magpie / OpenCode 的 provider。
 *
 * 上游：https://github.com/wayne091106-hash/zfr-core （MIT）
 * 契约：https://usemagpie.ai/docs/plugins
 *
 * 设计要点：
 * - zfr-core 本身已经是 OpenAI 兼容网关（默认 127.0.0.1:18788/v1），
 *   所以这里不做协议转换，只负责 注册 provider / 注入 baseURL / 透传 key / 发现模型。
 * - zfr 不在 models.dev 里，必须用 config hook 显式声明 config.provider.zfr。
 * - 网关没起时不抛错，让 Magpie 能正常启动，调用时才报清楚的错。
 */
import { DEFAULT_BASE_URL, resolveModels } from './models.mjs'

export const PROVIDER_ID = 'zfr'

function resolveBaseUrl(env = process.env) {
  const raw = (env.ZFR_BASE_URL || env.ZFR_GATEWAY || DEFAULT_BASE_URL || '').trim()
  return raw.replace(/\/+$/, '')
}

export default async function zfrPlugin(_input = {}) {
  const baseURL = resolveBaseUrl()
  let cache = null

  async function getModels(force = false) {
    if (!force && cache) return cache
    cache = await resolveModels(baseURL)
    return cache
  }

  const hooks = {
    /** 1. 声明 provider —— models.dev 没有 zfr，必须显式注册。 */
    async config(config) {
      const { models, source } = await getModels()
      config.provider = config.provider || {}
      const prev = config.provider[PROVIDER_ID] || {}

      // 用户已在 magpie 配置里手写过 models 的，不覆盖
      const mergedModels = { ...models, ...(prev.models || {}) }

      config.provider[PROVIDER_ID] = {
        ...prev,
        name: prev.name || 'ZFR Core (local)',
        npm: prev.npm || '@ai-sdk/openai-compatible',
        api: prev.api || baseURL,
        ...(Object.keys(mergedModels).length ? { models: mergedModels } : {}),
        options: { baseURL, ...(prev.options || {}) },
      }

      if (source === 'none') {
        // 不抛错：zfr 没起 / 没登录上游时也要能进 Magpie
        globalThis.console?.warn?.(
          `[zfr-magpie] ${baseURL}/models 无响应，模型表为空。` +
          ` 先跑 \`zfr serve\`，或设 ZFR_MODELS=id1,id2 手动钉模型。`
        )
      }
      return config
    },

    /** 2. 认证 —— zfr serve 可无 key，也可 --api-key；两种都放行。 */
    auth: {
      provider: PROVIDER_ID,
      async loader(getAuth) {
        const auth = (typeof getAuth === 'function' ? await getAuth().catch(() => undefined) : undefined) || {}
        return {
          baseURL,
          ...(auth && auth.type === 'api' && auth.key ? { apiKey: auth.key } : {}),
          // 透传 fetch：只补 content-type，不改上游语义（zfr 自己管 egress 轮换）
          fetch: (input, init) => {
            const headers = new Headers((init && init.headers) || {})
            if (init && init.body && !headers.has('content-type')) {
              headers.set('content-type', 'application/json')
            }
            return fetch(input, { ...init, headers })
          },
        }
      },
      methods: [
        { type: 'api', label: 'ZFR API key（可选，对应 zfr serve --api-key）' },
      ],
    },

    /** 3. 模型表 —— 每次读取前问一次网关，失败回落缓存/环境变量。 */
    provider: {
      id: PROVIDER_ID,
      async models() {
        const { models } = await getModels()
        return models
      },
    },
  }

  return hooks
}

export { DEFAULT_BASE_URL }
