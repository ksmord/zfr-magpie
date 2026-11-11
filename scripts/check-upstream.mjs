#!/usr/bin/env node
/**
 * 检查上游 zfr-core 是否更新。
 * 用法：node scripts/check-upstream.mjs [--json]
 * 退出码：0 = 无变化，1 = 有变化，2 = 出错
 *
 * 可选环境变量 GITHUB_TOKEN：有就用认证请求（5000/h），没有就走 60/h 匿名额度。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const STATE = join(ROOT, '.upstream.json')
const DEFAULT_REPO = 'wayne091106-hash/zfr-core'
const DEFAULT_BRANCH = 'main'

function loadState() {
  if (!existsSync(STATE)) return { repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, sha: null }
  try {
    return { repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, ...JSON.parse(readFileSync(STATE, 'utf8')) }
  } catch {
    return { repo: DEFAULT_REPO, branch: DEFAULT_BRANCH, sha: null }
  }
}

async function gh(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'zfr-magpie-upstream-check',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    // 防止 CI 在 GitHub API 半挂时卡死
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText} for ${path}`)
  return res.json()
}

const state = loadState()
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''

try {
  const commit = await gh(`/repos/${state.repo}/commits/${state.branch}`, token)
  const sha = commit.sha
  const date = commit.commit?.committer?.date || ''
  const msg = (commit.commit?.message || '').split('\n')[0]

  const changed = state.sha && state.sha !== sha
  const firstRun = !state.sha

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ repo: state.repo, branch: state.branch, pinned: state.sha, latest: sha, date, message: msg, changed, firstRun }, null, 2))
  } else {
    console.log(`上游   ${state.repo}@${state.branch}`)
    console.log(`记录值 ${state.sha || '(未记录)'}`)
    console.log(`最新值 ${sha}  ${date}`)
    console.log(`提交   ${msg}`)
    if (firstRun) console.log('\n首次运行：把 sha 写进 .upstream.json 即建立基线。')
    else if (changed) console.log('\n上游有更新，需要看 diff 决定要不要适配。')
    else console.log('\n无变化。')
  }

  // --write 只在建立基线或手动确认适配完成时用
  if (process.argv.includes('--write')) {
    writeFileSync(STATE, JSON.stringify({ repo: state.repo, branch: state.branch, sha, checkedAt: new Date().toISOString() }, null, 2) + '\n')
    console.log(`\n已写入 ${STATE}`)
  }

  process.exit(changed ? 1 : 0)
} catch (err) {
  console.error('检查失败:', err.message)
  process.exit(2)
}
