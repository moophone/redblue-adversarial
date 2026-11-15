const words = ['致命','严重','一般','优化','已消除','残留','挂账']
const cls = new Set([...Buffer.from('（'), 0x28])
const hex = b => b.toString(16).padStart(2, '0')
console.log('全角（ UTF-8 =', [...Buffer.from('（')].map(hex).join(' '), '  半角( = 28')
console.log('字节类 = {', [...cls].map(hex).join(', '), '}')
console.log('')
for (const w of words) {
  const buf = Buffer.from(w)
  let hit = -1
  for (let i = 0; i < buf.length; i++) if (cls.has(buf[i])) { hit = i; break }
  const kept = hit < 0 ? w : buf.subarray(0, hit).toString('utf8')
  const status = hit < 0 ? '不受影响' : `从字节${hit}截断 → 剩 [${kept}]+坏字节`
  console.log(w.padEnd(4, '　'), buf.length + '字节', [...buf].map(hex).join(' '), '|', status)
}