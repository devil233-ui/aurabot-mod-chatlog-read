/** @type {import('../aurabot').AurabotModule} */
/**
 * 给 DSH 会话（尤其「工作间」/自主唤醒）一个带说话人的流水读口。
 *
 * 为什么需要它：工作间不是聊天会话，拿不到 qq_* 工具，只能 bash 直读
 * chatlog/*.jsonl；她一再按 `user/sender/name` 猜字段（实测 30 次猜错、1 次用对），
 * 说话人整列读空，写消息时把主语补成「你」，于是把自己 17:28 说的话记到主人头上。
 * 这个工具只做一件事：按天读流水，逐行带 who。
 *
 * 只读，不写任何文件；days 默认 0 = 全部（27 天约 4 MB），也可指定最近几天。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.AURABOT_CHATLOG_DIR || '/root/.dsh/plugins-data/aurabot/chatlog'
const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function dayList() {
  try {
    return readdirSync(DIR)
      .filter((name) => DAY_FILE.test(name))
      .map((name) => name.slice(0, 10))
      .sort()
  } catch {
    return []
  }
}

function stamp(t) {
  const ms = Number(t)
  if (!Number.isFinite(ms) || ms <= 0) return '??:??'
  const d = new Date(ms > 1e11 ? ms : ms * 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function readDay(day) {
  try {
    return readFileSync(join(DIR, `${day}.jsonl`), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

function search(args = {}) {
  const query = String(args.query ?? '').trim()
  const words = query === '' ? [] : query.split(/\s+/).filter(Boolean)
  const wanted = String(args.chat ?? '').trim()
  const limit = Math.min(Math.max(Number(args.limit) || 60, 1), 200)
  const all = dayList()
  if (all.length === 0) return { ok: true, message: `流水目录里没有文件：${DIR}` }

  const date = String(args.date ?? '').trim()
  let days = all
  if (date !== '') {
    if (!DATE_RE.test(date)) return { ok: false, message: 'date 要填 YYYY-MM-DD，例如 2026-11-25' }
    days = all.filter((d) => d === date)
    if (days.length === 0) return { ok: true, message: `流水里没有 ${date} 这天。` }
  } else {
    const raw = args.days === undefined || args.days === null || args.days === '' ? 0 : Number(args.days)
    const back = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 0), 365) : 0
    days = back === 0 ? all : all.slice(-back)
  }

  const hits = []
  for (const day of days) {
    for (const row of readDay(day)) {
      if (row.forgottenAt) continue
      if (wanted !== '' && String(row.chatId ?? '') !== wanted) continue
      const text = String(row.text ?? '').replace(/\s+/g, ' ').trim()
      if (words.length > 0 && !words.every((w) => text.includes(w))) continue
      const who = String(row.who ?? '?')
      const where = String(row.chatId ?? '')
      hits.push(`${stamp(row.t)} [${where}] ${who}：${text.slice(0, 200)}`)
    }
  }
  if (hits.length === 0) {
    const scope = date !== '' ? date : `最近 ${days.length} 天`
    return { ok: true, message: `${scope}的流水里没找到「${query || '（空）'}」${wanted === '' ? '' : `（chat=${wanted}）`}。` }
  }
  const tail = hits.slice(-limit)
  const head = `命中 ${hits.length} 条，下面是最近 ${tail.length} 条（who=bot 就是她自己的话，不是主人说的）：`
  return { ok: true, message: `${head}\n${tail.join('\n')}` }
}

export default {
  id: 'chatlog-read',
  name: '查流水',
  version: '0.1.0',
  api: 1,
  description: '给 DSH 会话一个带说话人的本地流水读口（工作间/唤醒回合用）',
  setup(api) {
    const allowed = (exec) => {
      const sid = String(exec?.sessionId ?? '')
      const hub = api.core?.hub
      if (sid === '' || typeof hub?.turnSendersAllOwner !== 'function') return true
      return hub.turnSendersAllOwner(sid) === true
    }
    api.dshTool(
      api.defineTool({
        name: 'qq_chatlog_read',
        description:
          '读本地 QQ 聊天流水（只读，按天翻）。每一行都带说话人：who=bot 是她自己发出去的话，who=devil 是主人，其余是群友昵称。' +
          '工作间（自主唤醒）没有聊天上下文、也用不了 qq_* 工具，要确认「这句话是谁说的」只走这个口，不要用 bash/read/grep 直接翻 chatlog 的 jsonl 猜字段（那份流水的字段是 t/who/uid/chatId/text，猜错了说话人整列会空）。',
        properties: {
          query: { type: 'string', description: '关键词，空格分隔表示每个词都要出现；不填就是整段流水' },
          date: { type: 'string', description: '只看这一天，填 2026-11-25 这种格式；填了就忽略 days' },
          days: { type: 'integer', description: '往回翻几天，默认 0 表示全部；填正整数就只看最近几天，最多 365' },
          chat: { type: 'string', description: '只看某个聊天，填 private:1250226509 或 group:1034185861；不填就是全部' },
          limit: { type: 'integer', description: '最多回多少行，默认 60，上限 200' },
        },
        required: [],
        execute: async (args, exec) => {
          // 跨聊天读流水等于把主人的私聊翻给别人看：只放行「这一轮说话的全是主人」的回合
          // （主人私聊、主人自己开的会话、自主唤醒的回合都算；群里别人问她时不算）。
          if (!allowed(exec)) return { ok: false, message: '这条流水只在主人开口的回合里能读。' }
          return search(args)
        },
      }),
    )
  },
}
