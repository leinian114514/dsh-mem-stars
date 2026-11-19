// dsh-mem-stars · 直连 meow-memory 的 SQLite
//
// 原需求（2026-11-11 用户）：「把他们融合了，得了呗。有好东西，全拿进来,弄成适合我们的」
// 五项目标里的最后一项：**数据源直连 meow-memory，省掉导出这一步**。
// 之前是「跑 导出记忆海.py → 读 my.json」，多一层文件、多一次手动。
//
// 逻辑从 `导出记忆海.py` 移植过来（那边还会继续留着当离线备份/调试用），
// 分层规则、截断参数、tier 编号必须与它保持一致，否则星图和脚本会画出两张不同的图。
//
// 只读，绝不写库。

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const LAYERS = ['core', 'project', 'branch', 'detail']

// 记忆海认的 kind（按 category 取，不再按层取 —— 四层里一层含多种分类）
const KIND = {
  // 核心层
  identity: 'feeling',
  preference: 'agreement',
  principle: 'agreement',
  rule: 'agreement',
  // 项目层 / 分支层
  overview: 'experience',
  structure: 'experience',
  decision: 'experience',
  ops: 'experience',
  todo: 'experience',
  quote: 'feeling',
  // 细节层
  fact: 'fact',
  lesson: 'conclusion',
  topic: 'experience',
  procedure: 'experience',
}

const CORE_PROJECTS = new Set(['', '全局'])
const PER_PROJECT = 220   // 单个项目的星环最多挂多少颗（单个项目可能有几百条）
const MAX_MSG = 600
const MAX_LT = 2600

export const DEFAULT_PATHS = {
  // 默认指向当前工作区下的记忆库；库装在别处就在 cordis.patch.yml 里写 memPath / arcPath 覆盖。
  mem: path.join(process.cwd(), '.dsh-memory', 'memory.db'),
  arc: path.join(process.cwd(), '.dsh-memory', 'sessions.db'),
}

/** 「项目A,全局」这种多归属，归到第一个具体项目；全是全局就算全局 */
export function primaryProject(proj) {
  const parts = String(proj || '').split(',').map((s) => s.trim()).filter(Boolean)
  for (const p of parts) if (!CORE_PROJECTS.has(p)) return p
  return '全局'
}

function columnsOf(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name))
  } catch {
    return new Set()
  }
}

/**
 * 读库里全部 active 条目。
 * 返回结构对齐 python 版 `export_long_term()` 里的 raw 列表。
 */
export function readEntries(memPath = DEFAULT_PATHS.mem) {
  const db = new DatabaseSync(memPath, { readOnly: true })
  const out = []
  try {
    for (const lvl of LAYERS) {
      const cols = columnsOf(db, lvl)
      if (!cols.size) continue
      const col = (name, dflt) => (cols.has(name) ? name : `${dflt} AS ${name}`)
      const sql = `SELECT id, title, content, ${col('project', "''")}, `
        + `${col('category', "''")}, ${col('importance', '1')}, ${col('hit_count', '0')}, `
        + `${col('last_accessed_at', '0')}, ${col('updated_at', '0')}, created_at `
        + `FROM ${lvl} WHERE status = 'active'`
      for (const r of db.prepare(sql).all()) {
        const content = String(r.content || '').trim()
        if (!content) continue
        out.push({
          id: String(r.id),
          title: r.title || '',
          content,
          project: String(r.project || ''),
          category: String(r.category || ''),
          importance: Number(r.importance) || 1,
          hitCount: Number(r.hit_count) || 0,
          lastAccessAt: Number(r.last_accessed_at) || 0,
          updatedAt: Number(r.updated_at) || 0,
          createdAt: Number(r.created_at) || 0,
          layer: lvl,
        })
      }
    }
  } finally {
    db.close()
  }
  return out
}

function readMessages(arcPath, maxMsg) {
  if (!fs.existsSync(arcPath)) return []
  const db = new DatabaseSync(arcPath, { readOnly: true })
  const rows = []
  try {
    const lim = maxMsg * 3
    for (const r of db.prepare(
      "SELECT sid, seq, role, text FROM raw WHERE role IN ('user','assistant') "
      + 'ORDER BY sid DESC, seq DESC LIMIT ?',
    ).all(lim)) rows.push(r)
  } catch {
    return []
  } finally {
    db.close()
  }
  const base = Date.now() - rows.length * 60_000
  const out = []
  rows.slice().reverse().forEach((r, i) => {
    const text = String(r.text || '').trim()
    if (!text || text.length < 4 || text.length > 500) return
    const isOwner = r.role === 'user'
    out.push({
      sender: isOwner ? 'owner' : 'her',
      isOwner,
      isSelf: !isOwner,
      text: text.slice(0, 300),
      at: base + i * 60_000,
      // 原始消息是最外围的尘埃带：不属于任何项目，只是发生过
      tier: 4,
      parentId: 'dust',
      ring: 'dust',
      sizeHint: 1.6,
    })
  })
  return out.slice(-maxMsg)
}

/** 条目列表 → 记忆海认识的 { longTerm, messages, diaries }，顺便把太阳系分层算好 */
export function buildData(entries, opts = {}) {
  const perProject = Number(opts.perProject) > 0 ? Number(opts.perProject) : PER_PROJECT
  const maxMsg = Number(opts.maxMsg) > 0 ? Number(opts.maxMsg) : MAX_MSG
  const arcPath = opts.arcPath || DEFAULT_PATHS.arc

  const core = []
  const byProject = new Map()
  for (const e of entries) {
    const proj = primaryProject(e.project)
    const item = {
      id: e.id,
      text: e.content.slice(0, 400),
      topic: proj,
      kind: KIND[e.category] || 'experience',
      confirmed: true,
      createdAt: e.createdAt,
      lastMentionAt: e.lastAccessAt || e.createdAt,
      updatedAt: e.updatedAt || e.createdAt,
      lastAccessAt: e.lastAccessAt,
      layer: e.layer,
      category: e.category,
      importance: e.importance,
      hitCount: e.hitCount,
      _proj: proj,
      _sub: e.category,
      _imp: e.importance,
      _hit: e.hitCount,
    }
    const isCoreLayer = e.layer === 'core'
    if (isCoreLayer || CORE_PROJECTS.has(proj)) {
      item.tier = 1
      item.parentId = 'sun'
      item.ring = isCoreLayer ? e.layer : `core:${e.layer}`
      core.push(item)
    } else {
      if (!byProject.has(proj)) byProject.set(proj, [])
      byProject.get(proj).push(item)
    }
  }

  // 单个项目太多就按「重要性 + 命中次数 + 新旧」挑
  const longTerm = core.slice()
  for (const [proj, members] of byProject) {
    members.sort((a, b) => (b._imp - a._imp) || (b._hit - a._hit) || (b.updatedAt - a.updatedAt))
    for (const it of members.slice(0, perProject)) {
      it.tier = 3
      it.parentId = `planet:${proj}`
      it.ring = it._sub || it.layer
      longTerm.push(it)
    }
  }

  // 行星本身：一颗合成的点
  for (const [proj, members] of byProject) {
    const mass = members.length
    const newest = members.reduce((m, x) => Math.max(m, x.updatedAt), 0)
    const hitSum = members.reduce((s, x) => s + x._hit, 0)
    const layers = {}
    for (const m of members) layers[m.layer] = (layers[m.layer] || 0) + 1
    const top = Object.entries(layers)
      .sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, v]) => `${k} ${v}`).join(' / ')
    longTerm.push({
      id: `planet:${proj}`,
      text: `${proj} · ${mass} 条记忆（${top}）`,
      topic: proj,
      kind: 'experience',
      confirmed: true,
      createdAt: newest,
      lastMentionAt: newest,
      updatedAt: newest,
      lastAccessAt: newest,
      layer: 'planet',
      category: '',
      importance: 4,
      hitCount: hitSum,
      mass,
      tier: 2,
      parentId: 'sun',
      ring: 'planet',
      sizeHint: Math.round((2 + Math.log10(Math.max(1, mass))) * 100) / 100,
      _proj: proj,
      _sub: '',
      _imp: 4,
      _hit: hitSum,
    })
  }

  // 点画多大：行星按质量（上面已给），其余按重要性 + 命中
  for (const it of longTerm) {
    if (typeof it.sizeHint === 'number') continue
    it.sizeHint = Math.round(Math.min(6, 1.6 + it._imp * 0.9 + Math.min(1.2, it._hit * 0.15)) * 100) / 100
  }

  longTerm.sort((a, b) => b.createdAt - a.createdAt)
  return {
    longTerm: longTerm.slice(0, MAX_LT),
    messages: readMessages(arcPath, maxMsg),
    diaries: [],
  }
}

/** 一步到位：读库 + 分好层 */
export function loadData(opts = {}) {
  const entries = readEntries(opts.memPath || DEFAULT_PATHS.mem)
  return { data: buildData(entries, opts), entries }
}
