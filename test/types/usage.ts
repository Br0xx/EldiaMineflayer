// Compile check for index.d.ts:  npx tsc --noEmit --skipLibCheck --strictNullChecks --module commonjs --target es2020 --moduleResolution node test/types/usage.ts
import * as mineflayer from '../..'
import { Vec3 } from 'vec3'

const bot = mineflayer.createBot({ host: 'localhost', username: 'x' })
const pose: 'standing' | 'crouching' | 'swimming' | 'crawling' | 'gliding' = bot.pose
const flags: boolean[] = [bot.crouching, bot.sprinting, bot.itemInUse, bot.isAlive]
const n: number = bot.tickCount + bot._input.stats.droppedTicks + (bot._input.stats.rejected['too-far'] ?? 0)
const why: string | null = bot.kickReason
const brand: string | null = bot.serverBrand ?? bot.serverVersion
bot.on('windowClosedForMovement', (w) => { w.slots.length })
bot.on('teleport', (t) => {
  const p: Vec3 = t.position
  const v: Vec3 = t.velocity
  const r: boolean = t.requested
  console.log(t.id + t.yaw + t.pitch, p, v, r, t.flags)
})
bot.on('tick', ({ n, packets }) => { const names: string[] = packets; console.log(n, names) })
bot.on('playerLoaded', () => {})
bot.on('actionRejected', ({ action, code, detail }) => { console.log(action, code.toUpperCase(), detail) })
bot.on('blockPlaced', (a, b) => { a.name + b.name })
bot.on('entityPlaced', (e) => { e.id })
bot.on('weatherUpdate', () => {})
bot.on('title_times', (a: number, b: number, c: number) => {})
bot.on('title_clear', () => {})
const eyes: number | undefined = bot.entity.eyeHeight
const swimming: boolean | undefined = bot.entity.isSwimming
const rided = bot.vehicle?.id
const fp = bot.findPlayer('a')
bot.bossBars.map(b => b.title)
bot.parseBedMetadata(bot.blockAt(new Vec3(0, 0, 0))!).headOffset
void [pose, flags, n, why, brand, eyes, swimming, rided, fp]
const part = new mineflayer.Particle(1, new Vec3(0, 0, 0), new Vec3(0, 0, 0))
part.maxSpeed?.x
// @ts-expect-error pose is read-only text union
const bad: 'flying' = bot.pose
