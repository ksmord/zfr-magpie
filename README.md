# zfr-magpie

<img src="./assets/icon.png" width="112" align="right" alt="zfr-magpie" />

把本地 [zfr-core](https://github.com/wayne091106-hash/zfr-core) 网关接进 [Magpie](https://usemagpie.ai) / OpenCode 的 provider 插件。

Magpie 里多一个叫 **ZFR Core (local)** 的 provider，模型列表从你本机的 zfr 网关实时拉。

```sh
magpie plugin add zfr-magpie      # 发布后
magpie plugin add ./              # 本地开发
zfr serve --bind 127.0.0.1:18788  # 先起网关
```


---

## 和已有的 `opencode-zen-free` 有什么不一样

Magpie 插件市场按**渠道**判重，不按包形态判重（见 [registry 规则](https://github.com/magpie-community/plugins#one-channel-already-listed)）。`opencode-zen-free` 已经占了 OpenCode Zen 这个渠道，所以这个包必须在说明里讲清区别，否则不会被合并：

| | `opencode-zen-free` | **zfr-magpie** |
|---|---|---|
| 凭证 | 插件内直连 Zen 公共凭证 | 由本机 zfr-core 持有，插件不碰上游凭证 |
| 出口 IP | 单出口 | **多出口轮换**（IPv6 / IPv4 / SOCKS5 / HTTP / relay） |
| 拓扑 | 浏览器 → Zen | 浏览器 → 本机 zfr 网关 → Zen / Kilo |
| 额外能力 | 无 | 限流、重试、egress 池、`zfr service` 常驻 |
| 依赖 | 无 | 需要本机跑 `zfr serve` |

一句话：**它不是又一个 Zen 直连，而是把 zfr 的路由层接进 Magpie**。渠道不同、部署形态不同、可观测性不同。

## 安装

```sh
# 从本地目录（开发时）
magpie plugin add /path/to/zfr-magpie

# 或从 npm（发布后）
magpie plugin add zfr-magpie
```

然后先起网关：

```sh
zfr serve --bind 127.0.0.1:18788
# 需要 egress 轮换：
zfr serve --egress ipv6,ipv4,socks5://127.0.0.1:1080#pool
# 需要鉴权：
zfr serve --api-key <your-key>
```

Magpie 里 provider 选 **ZFR Core (local)**，模型列表会自动出现。

## 配置

| 环境变量 | 默认 | 用途 |
|---|---|---|
| `ZFR_BASE_URL` | `http://127.0.0.1:18788/v1` | 网关地址（换端口就改这个） |
| `ZFR_MODELS` | 空 | 网关拉不到模型时手动钉表，格式 `id1,id2:65536`（冒号后是 context 长度） |

`zfr serve --api-key` 开了鉴权的话，在 Magpie 的 provider 登录里粘贴同一个 key。

## 模型发现

优先级：**网关 `/v1/models` 实时发现 → `ZFR_MODELS` 环境变量 → 空表**。

- 实时发现：每次 `models` hook 调用前探一次，3 秒超时，失败走缓存。
- 空表时 Magpie 能正常启动，只是没有可用模型，日志里会打一条警告告诉你 `zfr serve` 没起。
- 插件**不硬编码任何模型名**——上游 zfr 改模型列表，这边不用跟着改。

## 上游同步

`zfr-core` 更新后需要适配的点，基本都收敛在两个文件：

- `models.mjs` —— 如果 zfr 改了 `/v1/models` 的返回字段（现在读 `data[].id` / `context_length` / `max_output_tokens` / `reasoning` / `tool_call`）。
- `provider.mjs` —— 如果 zfr 改了鉴权方式（现在是可选 `--api-key`，走 `Authorization: Bearer`）或改默认端口。

仓库带了自动巡检：

- `.github/workflows/upstream-watch.yml` 每天跑一次，比对上游 `main` 的 commit sha 和 `.upstream.json` 里记的值，变了就开 issue。
- 手动跑：`npm run upstream`。

适配完成后把新的 sha 写回 `.upstream.json` 并提交，issue 关掉。

## 被 Magpie 市场搜到，需要三步

1. **包能独立安装**：`magpie plugin add <包名>` 之后 provider 能出现在列表里（本地先自测，`magpie plugin` 看状态）。
2. **发布到 npm**：`npm publish`，包名 `zfr-magpie`（不走 `@magpie-community/*` scope，走的独立维护模式，参考 `magpie-search-mix`）。
3. **向 `magpie-community/plugins` 提 PR，往 `registry.json` 加一条**：

```json
{
  "package": "zfr-magpie",
  "name": "ZFR Core (local)",
  "icon": "https://raw.githubusercontent.com/ksmord/zfr-magpie/main/assets/icon.png",
  "providers": ["zfr"],
  "community": true,
  "summary": {
    "en": "Local zfr-core gateway as a Magpie provider: multi-egress IP rotation, retry and rate-limit layer in front of OpenCode Zen / Kilo free models. Requires `zfr serve`.",
    "zh": "把本机 zfr-core 网关接成 Magpie provider：在 OpenCode Zen / Kilo 免费模型前面加多出口 IP 轮换、重试与限流层。需要本机先跑 `zfr serve`。"
  }
}
```

`registry-entry.json` 里已经按这个格式写好了，直接抄。

**关键点**：`summary` 里必须写明和 `opencode-zen-free` 的差异（上面表格那几条），否则按渠道判重会被拒。PR 描述里也重复一遍。

## 自检

```sh
npm run check        # 语法检查
node -e "import('./models.mjs').then(m=>m.probeGateway().then(console.log))"
```

## 许可证

MIT，见 [LICENSE](./LICENSE)。上游归属见 [NOTICE](./NOTICE)。
