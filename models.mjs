/**
 * 模型发现 + 回退表。
 *
 * zfr-core 是一个本地 OpenAI 兼容网关（默认 http://127.0.0.1:18788/v1），
 * 上游模型由 zfr 自己从 OpenCode Zen / Kilo 拉。所以这里**不硬编码模型名**：
 * 优先问网关要 /v1/models，拿不到再用 ZFR_MODELS 环境变量里手动钉的列表。
 */

export const DEFAULT_BASE_URL = 'http://127.0.0.1:18788/v1'
const DISCOVERY_TIMEOUT_MS = 3000

function normalizeLimit(raw) {
  const ctx = raw?.context_length ?? raw?.context ?? raw?.max_context_length
  const out = raw?.max_output_tokens ?? raw?.max_output ?? raw?.output
  const limit = {}
  if (Number.isFinite(ctx) && ctx > 0) limit.context = ctx
  if (Number.isFinite(out) && out > 0) limit.output = out
  return Object.keys(limit).length ? limit : undefined
}

/**
 * 把网关返回的一条模型记录转成 Magpie/OpenCode 的 provider.models 条目。
 */
export function toModelEntry(m) {
  if (!m || !m.id) return null
  const entry = { name: m.name || m.display_name || m.id }
  const limit = normalizeLimit(m)
  if (limit) entry.limit = limit
  if (m.reasoning === true) entry.reasoning = true
  if (m.tool_call === true || m.function_calling === true) entry.tool_call = true
  if (m.attachment === true) entry.attachment = true
  if (Number.isFinite(m.temperature)) entry.temperature = m.temperature
  return [m.id, entry]
}

/**
 * 从 ZFR_MODELS="id1,id2:65536" 解析手动钉的模型表。
 * 冒号后面可选写 context 长度。
 */
export function parseEnvModels(raw) {
  const out = {}
  for (const piece of String(raw || '').split(',')) {
    const s = piece.trim()
    if (!s) continue
    const [id, ctx] = s.split(':')
    const key = id.trim()
    if (!key) continue
    const limit = Number.parseInt(ctx, 10)
    out[key] = Number.isFinite(limit) && limit > 0
      ? { name: key, limit: { context: limit, output: 8192 } }
      : { name: key }
  }
  return out
}

/**
 * GET {base}/models，3 秒超时，失败返回 null（调用方决定回退）。
 */
export async function fetchModels(baseURL = DEFAULT_BASE_URL, { timeoutMs = DISCOVERY_TIMEOUT_MS } = {}) {
  const url = `${String(baseURL).replace(/\/+$/, '')}/models`
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const body = await res.json()
    const list = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    const out = {}
    for (const m of list) {
      const kv = toModelEntry(m)
      if (kv) out[kv[0]] = kv[1]
    }
    return Object.keys(out).length ? out : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 模型来源优先级：网关实时发现 > ZFR_MODELS 环境变量 > 空表。
 * 空表时 Magpie 会显示 provider 但没有模型，README 里写了怎么救。
 */
export async function resolveModels(baseURL, env = process.env) {
  const live = await fetchModels(baseURL)
  if (live) return { models: live, source: 'gateway' }
  const pinned = parseEnvModels(env.ZFR_MODELS)
  if (Object.keys(pinned).length) return { models: pinned, source: 'env' }
  return { models: {}, source: 'none' }
}

/**
 * 网关健康探针，给 CLI / 自检用。
 */
export async function probeGateway(baseURL = DEFAULT_BASE_URL) {
  const models = await fetchModels(baseURL)
  return { reachable: models !== null, baseURL, modelCount: models ? Object.keys(models).length : 0 }
}
