// dsh-mem-stars — 记忆星图（host 半）
//
// 融合三样东西（2026-11-11）：
//   ① 记忆海（asdfd3/3d-memory-sea）的 Canvas 2D 三维渲染 —— 轻、零依赖
//   ② 「记忆神经元」那套「每条边必须答得出凭什么连」—— 边带 why
//   ③ 星汐（Yuuyuko-uu/dsh-xingxi）的形态：做成 DSH 侧栏面板
// 加上我们自己的一层：
//   ④ **数据直连 meow-memory 的 SQLite** —— 不再需要先跑导出脚本（`lib/db.mjs`）
//   ⑤ **两个工具，让我自己能查这张星图** —— `mem_stars_search` / `mem_stars_linked`
//
// 路由：
//   GET  /dsh-mem-stars/view     → 返回渲染页（public/sea.html）
//   GET  /dsh-mem-stars/scene    → 返回场景 JSON
//   POST /dsh-mem-stars/rebuild  → 强制重算场景
//
// 安全边界：只读，永不写记忆库；路由必须过 ctx.connection 的信任栅栏。

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createSceneService } from './sea/scene-service.mjs'
import { loadData, primaryProject, DEFAULT_PATHS } from './db.mjs'
import { DatabaseSync } from 'node:sqlite'
import { pointId } from './sea/mind-sea.js'

export const name = 'mem-stars'
export const inject = ['webServer', 'connection', 'tools']

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const HTML_PATH = path.join(ROOT, 'public', 'sea.html')
// 兜底数据放在插件自己目录里 —— 原先指向 3d-memory-sea 的导出文件，
  // 那样等于让这个插件依赖一个已归档的旧插件。
  const FALLBACK_JSON = path.join(ROOT, 'data', 'fallback-my.json')
const EXPORT_SCRIPT = '导出记忆海.py'   // 放在插件目录下即可；没有就跳过导出那一路

const R_VIEW = '/dsh-mem-stars/view'
const R_SCENE = '/dsh-mem-stars/scene'
const R_REBUILD = '/dsh-mem-stars/rebuild'
// 全文搜索：在数据库里查（不受场景文本截断到 160 字的限制），
// 再用 pointId 把结果映射回星图上的点。
const R_SEARCH = '/dsh-mem-stars/search'
const SEARCH_LAYERS = ['core', 'project', 'branch', 'detail']

export function apply(ctx, config = {}) {
  const debugFile = typeof config.debugFile === 'string' ? config.debugFile : ''
  const memPath = typeof config.memPath === 'string' && config.memPath ? config.memPath : DEFAULT_PATHS.mem
  const arcPath = typeof config.arcPath === 'string' && config.arcPath ? config.arcPath : DEFAULT_PATHS.arc
  const ttlMs = Number(config.ttlMs) > 0 ? Number(config.ttlMs) : 60_000

  let cache = null        // { at, body, scene }
  let lastEntries = []    // 给工具用的原始条目

  const log = (msg) => {
    ctx.logger?.info?.(`[mem-stars] ${msg}`)
    if (!debugFile) return
    try {
      fs.appendFileSync(debugFile, `${new Date().toISOString()} ${msg}\n`)
    } catch {}
  }

  // 记忆海的 server.mjs 中间有一层转换：原始 {longTerm,messages,diaries} → {points,edges,clusters}。
  // 少了这层，前端拿到的 points 是空的，会显示"读不到场景"。
  const buildOnce = () => {
    const t0 = Date.now()
    const { data, entries } = loadData({ memPath, arcPath })
    const svc = createSceneService({ data })
    svc.rebuild()
    const scene = svc.scene()
    const body = JSON.stringify(scene)
    lastEntries = entries
    const pts = scene.points || []
    log(`scene built (sqlite 直连 ${entries.length} 条 / ${Date.now() - t0}ms): `
      + `点 ${pts.length} / 边 ${(scene.edges || []).length} / ${(body.length / 1024).toFixed(0)} KB`)
    return { body, scene, entries }
  }

  // 兜底：SQLite 这条路出问题时，退回老的 my.json（保证面板不白屏）
  const buildFromJson = () => {
    const raw = fs.readFileSync(FALLBACK_JSON, 'utf8')
    const data = JSON.parse(raw)
    const svc = createSceneService({ data })
    svc.rebuild()
    const scene = svc.scene()
    const body = JSON.stringify(scene)
    log(`scene built (my.json 兜底): 点 ${(scene.points || []).length} / 边 ${(scene.edges || []).length}`)
    return { body, scene, entries: [] }
  }

  const readScene = (force = false) => {
    const now = Date.now()
    if (!force && cache && now - cache.at < ttlMs) return cache.body
    try {
      const r = buildOnce()
      cache = { at: now, body: r.body, scene: r.scene }
      return r.body
    } catch (e) {
      log(`sqlite 直连失败，退回 my.json：${e && e.message}`)
    }
    try {
      const r = buildFromJson()
      cache = { at: now, body: r.body, scene: r.scene }
      return r.body
    } catch (e) {
      log(`read scene FAILED: ${e && e.message}`)
      return null
    }
  }

  const runRebuild = () =>
    new Promise((resolve) => {
      execFile(
        'python',
        [EXPORT_SCRIPT],
        { timeout: 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
        (err, stdout, stderr) => {
          cache = null
          resolve({ ok: !err, out: String(stdout || '') + (err ? String(stderr || '') : '') })
        },
      )
    })

  const handler = (req, res) => {
    // 只放行本机回环。原来用 ctx.connection.requestRejection —— 它要求 DSH
    // 客户端自己的凭证，连同一台机器的浏览器直连都会 401，星图只能在宿主里开。
    try {
      const host = String(req.headers?.host ?? '')
      const ip = String(req.socket?.remoteAddress ?? '')
      const localHost = !host || /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)
      const localIp = !ip || /^(::1|::ffff:127\.|127\.)/.test(ip)
      if (!localHost || !localIp) {
        res.statusCode = 403
        res.end()
        return
      }
    } catch {
      res.statusCode = 403
      res.end()
      return
    }

    let pathname = '/'
    try {
      pathname = new URL(String(req.url || '/'), 'http://localhost').pathname
    } catch {
      res.statusCode = 400
      res.end()
      return
    }

    if (pathname === R_VIEW) {
      try {
        const html = fs.readFileSync(HTML_PATH, 'utf8')
        res.statusCode = 200
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(html)
      } catch (e) {
        res.statusCode = 500
        res.end(`sea.html 读不到：${e && e.message}`)
      }
      return
    }

    if (pathname === R_SCENE) {
      const body = readScene()
      if (body === null) {
        res.statusCode = 503
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: '场景读不到（SQLite 和 my.json 都失败）', points: [], edges: [], clusters: [] }))
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(body)
      return
    }

    if (pathname === R_REBUILD) {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.setHeader('allow', 'POST')
        res.end()
        return
      }
      cache = null
      const body = readScene(true)
      res.statusCode = body === null ? 500 : 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: body !== null }))
      return
    }

    // 全文搜索：直接查库，不受场景「文本截断到 160 字」的限制。
    // 返回的 pid 用 pointId(截断后的 text, created_at) 算，跟场景里的点对得上。
    if (pathname === R_SEARCH) {
      let q = ''
      try {
        q = String(new URL(String(req.url || '/'), 'http://localhost').searchParams.get('q') || '').trim()
      } catch {}
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      if (!q) {
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, count: 0, hits: [] }))
        return
      }
      try {
        const db = new DatabaseSync(DEFAULT_PATHS.mem, { readOnly: true })
        const like = '%' + q + '%'
        const hits = []
        for (const lv of SEARCH_LAYERS) {
          let rows = []
          try {
            rows = db
              .prepare(
                `SELECT id, content, keywords, created_at FROM ${lv} ` +
                  `WHERE status = 'active' AND (content LIKE ? OR keywords LIKE ?)`
              )
              .all(like, like)
          } catch {
            continue
          }
          for (const r of rows) {
            const text = String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 160)
            hits.push({
              pid: pointId(text, r.created_at),
              dbId: String(r.id || ''),
              level: lv,
              snippet: text.slice(0, 90),
            })
          }
        }
        db.close()
        res.statusCode = 200
        res.end(JSON.stringify({ ok: true, count: hits.length, hits }))
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e), hits: [] }))
      }
      return
    }

    res.statusCode = 404
    res.end()
  }

  const register = () => {
    const offs = [
      ctx.webServer.register({ kind: 'exact', path: R_VIEW, handler }),
      ctx.webServer.register({ kind: 'exact', path: R_SCENE, handler }),
      ctx.webServer.register({ kind: 'exact', path: R_REBUILD, handler }),
      ctx.webServer.register({ kind: 'exact', path: R_SEARCH, handler }),
    ]
    return () => {
      for (const off of offs) {
        try { if (typeof off === 'function') off() } catch {}
      }
    }
  }

  // ── 工具：让我自己能查这张星图 ──────────────────────────────────────
  // 星汐有 `xingxi_read`，这里给对应的两个出口。数据走内存里的 lastEntries（读库 144ms，缓存一份）。

  const ensureEntries = () => {
    if (lastEntries.length) return lastEntries
    readScene()
    if (!lastEntries.length) lastEntries = loadData({ memPath, arcPath }).entries
    return lastEntries
  }

  const fmtEntry = (e, i) => {
    const when = e.updatedAt ? new Date(e.updatedAt).toISOString().slice(0, 10) : '?'
    const hit = e.hitCount > 0 ? `调用${e.hitCount}次` : '未调用'
    return `${i + 1}. [${primaryProject(e.project)}｜${e.layer}] ${when} · ${hit}\n   ${e.content.replace(/\s+/g, ' ').slice(0, 220)}`
  }

  // DSH 要求工具声明 output（schema + render），只给 name/description/parameters 会被拒
  const toolShape = (toolName) => ({
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: String(v?.text || '') }],
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ card: 'generic', title: toolName, kind: 'read', rawInput: args }),
  })

  const toolSearch = {
    name: 'mem_stars_search',
    description: '查记忆星图里的条目（按项目/层/关键词过滤，按调用次数排序）。用于"我在某个项目上记过什么""哪几条被反复用过"。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '正文里包含的字，可空' },
        project: { type: 'string', description: '项目名，如 项目A / 项目B' },
        layer: { type: 'string', description: '层：fact/lesson/project/rules/topic/user/soul' },
        hot: { type: 'boolean', description: '只看被调用过的' },
        limit: { type: 'number', description: '返回几条，默认 12' },
      },
      additionalProperties: false,
    },
    execute: async (args = {}) => {
      const limit = Number(args.limit) > 0 ? Math.min(50, Number(args.limit)) : 12
      const q = String(args.query || '').trim().toLowerCase()
      const proj = String(args.project || '').trim()
      const layer = String(args.layer || '').trim()
      let rows = ensureEntries()
      if (proj) rows = rows.filter((e) => primaryProject(e.project).includes(proj))
      if (layer) rows = rows.filter((e) => e.layer === layer)
      if (args.hot) rows = rows.filter((e) => e.hitCount > 0)
      if (q) rows = rows.filter((e) => e.content.toLowerCase().includes(q))
      rows = rows.slice().sort((a, b) => (b.hitCount - a.hitCount) || (b.updatedAt - a.updatedAt))
      if (!rows.length) return { text: '没查到符合条件的记忆。' }
      return {
        text: `命中 ${rows.length} 条，按调用次数排序（前 ${Math.min(limit, rows.length)} 条）：\n\n`
          + rows.slice(0, limit).map(fmtEntry).join('\n\n'),
      }
    },
    ...toolShape('mem_stars_search'),
  }

  const toolLinked = {
    name: 'mem_stars_linked',
    description: '查一条记忆在星图里跟谁连着、凭什么连（每条边都有 why）。用于"这事跟什么有关""顺着线还能找到什么"。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '找哪条记忆（正文片段）' },
        limit: { type: 'number', description: '返回几个邻居，默认 8' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (args = {}) => {
      const q = String(args.query || '').trim()
      if (!q) return { text: '要给我一个 query（正文片段）。' }
      const limit = Number(args.limit) > 0 ? Math.min(30, Number(args.limit)) : 8
      const body = readScene()
      if (body === null) return { text: '场景读不到，星图数据这一层没起来。' }
      const scene = cache?.scene || JSON.parse(body)
      const points = scene.points || []
      const lower = q.toLowerCase()
      const hitPts = points.filter((p) => String(p.text || '').toLowerCase().includes(lower))
      if (!hitPts.length) return { text: `星图里没找到含「${q}」的点。` }
      const byId = new Map(points.map((p) => [p.id, p]))
      const lines = []
      for (const p of hitPts.slice(0, 2)) {
        const edges = (scene.edges || []).filter((e) => e.a === p.id || e.b === p.id)
        lines.push(`【${p.topic}】${String(p.text).replace(/\s+/g, ' ').slice(0, 120)}`)
        if (p.hitCount) lines.push(`  被调用 ${p.hitCount} 次`)
        if (!edges.length) { lines.push('  没有连线。'); continue }
        const sorted = edges.slice().sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit)
        for (const e of sorted) {
          const other = byId.get(e.a === p.id ? e.b : e.a)
          if (!other) continue
          lines.push(`  ↳ ${String(other.text).replace(/\s+/g, ' ').slice(0, 90)}`
            + `\n     为什么连：${e.why || '（没记原因）'}`)
        }
        lines.push('')
      }
      return { text: lines.join('\n') }
    },
    ...toolShape('mem_stars_linked'),
  }

  for (const t of [toolSearch, toolLinked]) {
    try {
      ctx.tools?.register?.(t)
      log(`registered ${t.name}`)
    } catch (e) {
      log(`register ${t.name} FAILED: ${e && e.message}`)
    }
  }

  try {
    ctx.effect(register, 'mem-stars: routes')
    log(`routes ready: ${R_VIEW} · ${R_SCENE} · ${R_REBUILD}`)
  } catch (e) {
    log(`route registration FAILED: ${e && e.message}`)
  }
}
