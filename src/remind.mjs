// 开售提醒：每 10 分钟看一次状态库，40 分钟内要开售、还没提醒过的场次推一条。不联网抓取。
// 逐条发的通道一场一条；按条数计费的通道（Server酱）把同一次要提醒的几场合成一条。
// 一场只要有一种通道发出去了就算提醒过。

import { digestMessage, reminderCard } from './notify/format.mjs'

export const REMIND_WINDOW_MS = 40 * 60_000

export async function runReminders({ store, notifier, now = Date.now, log = console.log }) {
  const t = now()
  const due = store.dueReminders(t, REMIND_WINDOW_MS)
  if (!due.length) return 0
  const cards = due.map((show) => reminderCard(show, store.listingsOfShow(show.id)))
  const done = new Set()
  const failed = (path) => (err) => log(`开售提醒${path}这次没发出去：${err.message}`)
  if (notifier.single) {
    for (const [i, card] of cards.entries()) {
      try {
        await notifier.send(card)
      } catch (err) {
        failed('逐条推送')(err)
        break
      }
      done.add(i)
    }
  }
  if (notifier.batch) {
    try {
      await notifier.sendDigest(digestMessage(cards))
      cards.forEach((_, i) => done.add(i))
    } catch (err) {
      failed('合成的那条')(err)
    }
  }
  for (const i of done) store.markReminded(due[i].id, due[i].nextSaleAt, t)
  if (done.size < due.length) log(`还有 ${due.length - done.size} 场的开售提醒一个通道都没发出去，10 分钟后再试`)
  return done.size
}
