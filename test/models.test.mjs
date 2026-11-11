import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { parseEnvModels, toModelEntry, fetchModels, resolveModels } from '../models.mjs'

/** 起一个临时 HTTP 服务，跑完自动关掉。 */
async function withServer(handler, run) {
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await run(`http://127.0.0.1:${port}/v1`)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

test('parseEnvModels：带冒号的模型 id 不被截断', () => {
  const models = parseEnvModels('kilo/qwen3:free,qwen-plus:131072')
  assert.deepEqual(Object.keys(models).sort(), ['kilo/qwen3:free', 'qwen-plus'])
  assert.equal(models['qwen-plus'].limit.context, 131072)
  assert.equal(models['kilo/qwen3:free'].limit, undefined)
})

test('parseEnvModels：空串 / 尾逗号 / 纯数字后缀才当长度', () => {
  assert.deepEqual(parseEnvModels(''), {})
  assert.deepEqual(parseEnvModels(' , '), {})
  assert.deepEqual(parseEnvModels('a:b:2048'), { 'a:b': { name: 'a:b', limit: { context: 2048, output: 8192 } } })
})

test('toModelEntry：多来源 limit 字段归一化', () => {
  assert.deepEqual(toModelEntry({ id: 'a', context_length: 128000, max_completion_tokens: 4096 }).entry.limit,
    { context: 128000, output: 4096 })
  assert.deepEqual(toModelEntry({ id: 'b', max_model_len: 32768 }).entry.limit, { context: 32768 })
  assert.deepEqual(toModelEntry({ id: 'c', top_provider: { context_length: 200000, max_completion_tokens: 8192 } }).entry.limit,
    { context: 200000, output: 8192 })
  assert.deepEqual(toModelEntry({ id: 'd', context: { length: 1000 } }).entry.limit, undefined)
})

test('toModelEntry：id 缺省返回 null，cost 只透传数字字段', () => {
  assert.equal(toModelEntry(null), null)
  assert.equal(toModelEntry({}), null)
  const { entry } = toModelEntry({ id: 'e', cost: { input: 1.5, output: 2, cache_read: 'x' } })
  assert.deepEqual(entry.cost, { input: 1.5, output: 2 })
  assert.equal(toModelEntry({ id: 'f' }).entry.cost, undefined)
})

test('fetchModels：正常返回模型表', async () => {
  await withServer((req, res) => {
    assert.equal(req.url, '/v1/models')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ data: [{ id: 'x', context_length: 1000 }] }))
  }, async (base) => {
    const models = await fetchModels(base, { timeoutMs: 1000 })
    assert.deepEqual(models, { x: { name: 'x', limit: { context: 1000 } } })
  })
})

test('fetchModels：带 apiKey 时发 Bearer 头', async () => {
  let seen = ''
  await withServer((req, res) => {
    seen = req.headers.authorization || ''
    res.end(JSON.stringify({ data: [{ id: 'y' }] }))
  }, async (base) => {
    const models = await fetchModels(base, { timeoutMs: 1000, apiKey: 'sk-test' })
    assert.equal(seen, 'Bearer sk-test')
    assert.ok(models.y)
  })
})

test('fetchModels：401 返回 null（不抛错）', async () => {
  await withServer((req, res) => {
    res.statusCode = 401
    res.end('{"error":"unauthorized"}')
  }, async (base) => {
    assert.equal(await fetchModels(base, { timeoutMs: 1000 }), null)
  })
})

test('fetchModels：超时返回 null', async () => {
  await withServer(() => { /* 永不响应 */ }, async (base) => {
    const started = Date.now()
    const models = await fetchModels(base, { timeoutMs: 150 })
    assert.equal(models, null)
    assert.ok(Date.now() - started < 2000, '超时没有生效')
  })
})

test('resolveModels：网关不在时回退 env / none', async () => {
  const dead = 'http://127.0.0.1:1/v1'
  const fromEnv = await resolveModels(dead, { ZFR_MODELS: 'a:1000', ZFR_API_KEY: '' })
  assert.equal(fromEnv.source, 'env')
  assert.equal(fromEnv.models.a.limit.context, 1000)
  const none = await resolveModels(dead, { ZFR_MODELS: '', ZFR_API_KEY: '' })
  assert.deepEqual(none, { models: {}, source: 'none' })
})
