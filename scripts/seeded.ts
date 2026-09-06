/** Fixed seed for reproducible noise fixtures. */
let seed = 0x5eed1234
export function random(): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 0x100000000
}
