import { randomBytes } from 'node:crypto'

/**
 * `YYYY-MM-DD_HHMM_<chain>_<4 hex>` in local time, for example
 * `2026-10-28_0912_tdd-review_7f3a`. Ids sort by start time to the
 * minute; the random suffix keeps runs started in the same minute apart.
 */
export function newRunId(chain: string, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`
  return `${date}_${time}_${chain}_${randomBytes(2).toString('hex')}`
}
