const { Vec3 } = require('vec3')
const conv = require('../conversions')
const { getAttributeValue } = require('../physics/attribute')

module.exports = inject

// Aiming the way a vanilla client does it, shared by the plugins that click, dig, place and attack. A vanilla player
// has no way to name a face or a point: they turn the head, the crosshair ray (from the eyes, along the rotation the
// movement packet carries) hits whatever it hits, and the packet reports that. So every action here
//   1. picks a point of the target that the eyes can see within reach,
//   2. turns to it and gives the rotation time to reach the server (lookSettled),
//   3. at the moment the packet is written, in the input phase of a tick, ray-casts again with that tick's
//      rotation and reports the face / point the ray really hits (blockHit / entityHit).

// prismarine-world BlockFace order (BOTTOM, TOP, NORTH, SOUTH, WEST, EAST) -> outward direction
const FACE_DIRS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]
// the face a ray enters a box through, per axis, when it travels in the positive / negative direction
const ENTER_FACE = [[4, 5], [0, 1], [2, 3]] // [axis][0: moving towards +, 1: moving towards -]

// Attribute keys per version generation (the registry names them minecraft:... from 1.21.2, player.... before)
const BLOCK_REACH_KEYS = ['minecraft:block_interaction_range', 'minecraft:player.block_interaction_range', 'player.block_interaction_range', 'generic.block_interaction_range']
const ENTITY_REACH_KEYS = ['minecraft:entity_interaction_range', 'minecraft:player.entity_interaction_range', 'player.entity_interaction_range', 'generic.entity_interaction_range']

// Blocks a client can not break or click (Grim: AirLiquidBreak / AirLiquidPlace)
const LIQUIDS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava', 'bubble_column'])

// A ray (origin o, direction d) against a box. Returns { t, face, point } for the point where it enters the box
// (t = 0 when o is inside), or null. face is a BlockFace index, -1 when o is inside.
function rayBox (o, d, min, max) {
  const origin = [o.x, o.y, o.z]
  const dir = [d.x, d.y, d.z]
  const lo = [min.x, min.y, min.z]
  const hi = [max.x, max.y, max.z]
  let tmin = -Infinity
  let tmax = Infinity
  let face = -1
  for (let i = 0; i < 3; i++) {
    if (dir[i] === 0) {
      if (origin[i] < lo[i] || origin[i] > hi[i]) return null
      continue
    }
    let t1 = (lo[i] - origin[i]) / dir[i]
    let t2 = (hi[i] - origin[i]) / dir[i]
    if (t1 > t2) [t1, t2] = [t2, t1]
    if (t1 > tmin) {
      tmin = t1
      face = ENTER_FACE[i][dir[i] > 0 ? 0 : 1]
    }
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return null
  }
  if (tmax < 0) return null
  if (tmin < 0) return { t: 0, face: -1, point: new Vec3(o.x, o.y, o.z) }
  return { t: tmin, face, point: new Vec3(o.x + d.x * tmin, o.y + d.y * tmin, o.z + d.z * tmin) }
}

// Distance from a point to the closest point of a box
function distanceToBox (p, min, max) {
  const dx = Math.max(min.x - p.x, 0, p.x - max.x)
  const dy = Math.max(min.y - p.y, 0, p.y - max.y)
  const dz = Math.max(min.z - p.z, 0, p.z - max.z)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function inject (bot) {
  bot.vanilla = bot.vanilla ?? {}

  const eyePosition = () => bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const settleTicksOption = () => bot.vanilla.options?.settleTicks ?? 2

  function attribute (keys) {
    const attributes = bot.entity?.attributes
    if (!attributes) return undefined
    for (const key of keys) {
      if (!attributes[key]) continue
      const value = getAttributeValue({ value: attributes[key].value, modifiers: attributes[key].modifiers ?? [] })
      if (Number.isFinite(value)) return value
    }
    return undefined
  }

  // How far the server lets this player reach: 1.20.5+ has attributes (the creative bonus is a modifier on them),
  // older versions have fixed numbers
  const hasReachAttributes = bot.registry.version['>=']('1.20.5')
  const creative = () => bot.game?.gameMode === 'creative'
  const blockReach = () => attribute(BLOCK_REACH_KEYS) ?? (creative() ? 5 : 4.5)
  const entityReach = () => attribute(ENTITY_REACH_KEYS) ?? (creative() ? (hasReachAttributes ? 5 : 6) : 3)

  // The unit vector a rotation points at; rot is { yaw, pitch } in degrees as a movement packet holds them
  function rotationDirection (rot) {
    const yaw = conv.toRadians(rot.yaw)
    const pitch = conv.toRadians(rot.pitch)
    return new Vec3(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
  }

  // The rotation the bot has now (not yet sent, perhaps), in the same shape
  function currentRotation () {
    return { yaw: conv.toNotchianYaw(bot.entity.yaw), pitch: conv.toNotchianPitch(bot.entity.pitch) }
  }

  // Resolves after n ticks have gone by (whether or not the bot is simulated)
  async function ticks (n) {
    for (let i = 0; i < n; i++) await bot._input.nextTick()
  }

  // Release a used item (eating, drawing a bow...) and let the tick go by: a vanilla client can not click while its
  // hands are busy, and the release is its own action of the tick (Grim: PacketOrderI, MultiActionsA/B/E)
  async function releaseItem () {
    if (!bot.usingHeldItem) return
    await bot.deactivateItem()
    await ticks(1)
  }

  // Wait (up to maxTicks) until the bot stands on the ground without horizontal speed. True if it does.
  async function standStill (maxTicks = 20) {
    for (let i = 0; i < maxTicks; i++) {
      const v = bot.entity.velocity
      if (bot.entity.onGround && Math.abs(v.x) < 0.003 && Math.abs(v.z) < 0.003) return true
      await bot.waitForTicks(1)
    }
    return false
  }

  // Turn to a point and give the rotation settleTicks ticks to reach the server.
  async function lookSettled (point, settleTicks = settleTicksOption()) {
    await bot.lookAt(point, true)
    await ticks(settleTicks)
  }

  // --- Blocks ---------------------------------------------------------------------------------------------------

  function isBreakable (block) {
    return !!block && block.type !== 0 && !LIQUIDS.has(block.name)
  }

  // Where the ray (origin, unit direction) hits the block at `position` within reach: { position, face, intersect },
  // or null when something else is in the way or it misses. A block without a collision shape (grass, flowers)
  // has an outline a vanilla crosshair still picks; it is taken as the whole block.
  function blockHit (position, origin, dir, reach) {
    const hit = bot.world.raycast(origin, dir, reach)
    if (hit && hit.position.equals(position)) return hit
    const target = bot.blockAt(position)
    if (isBreakable(target) && target.shapes?.length === 0) {
      const box = rayBox(origin, dir, position, position.offset(1, 1, 1))
      if (box && box.face >= 0 && box.t <= reach && (!hit || origin.distanceTo(hit.intersect) >= box.t)) {
        return { position, face: box.face, intersect: box.point }
      }
    }
    return null
  }

  // The same for the rotation of a movement packet
  function blockHitAt (position, rot, reach = blockReach()) {
    return blockHit(position, eyePosition(), rotationDirection(rot), reach)
  }

  // The first block the bot's current rotation points at within reach
  // (bot.blockAtCursor starts at the entity height instead, 0.18 above the eyes)
  function blockAtLook (reach) {
    const { yaw, pitch } = bot.entity
    const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
    return bot.world.raycast(eyePosition(), dir, reach)
  }

  // Distance from the eyes to the closest point of the block's cell
  function distanceToBlock (position) {
    return distanceToBox(eyePosition(), position, position.offset(1, 1, 1))
  }

  // A point on the block that the bot's eyes can see within reach: the centre, else the centres of the faces
  // turned towards the eyes (a little inside, so the ray lands on that face). Null if none is visible.
  function visiblePoint (block, reach = bot.vanilla.options?.reach ?? 3) {
    const eye = eyePosition()
    const p = block.position
    const candidates = [p.offset(0.5, 0.5, 0.5)]
    for (const [x, y, z] of FACE_DIRS) {
      const face = p.offset(0.5 + x * 0.45, 0.5 + y * 0.45, 0.5 + z * 0.45)
      // Only faces turned towards the eyes can be hit
      if ((eye.x - face.x) * x + (eye.y - face.y) * y + (eye.z - face.z) * z > 0) candidates.push(face)
    }
    for (const c of candidates) {
      if (eye.distanceTo(c) > reach) continue
      const hit = blockHit(p, eye, c.minus(eye).normalize(), reach)
      if (hit) return c
    }
    return null
  }

  // A point on one face of the block (face: the outward direction as a Vec3) that the eyes see within reach, picked
  // at random in the middle of the face so that repeated clicks do not repeat the same rotation to the bit
  // (Grim: DuplicateRotPlace). `half` ('top' | 'bottom') shifts the aim on a side face to the upper / lower half,
  // `delta` names the point (relative to the block corner) outright.
  // Returns { ok: true, point } or { ok: false, reason: 'too-far' | 'no-sight' }.
  function facePoint (block, face, { reach = blockReach(), half, delta, jitter = 0.3 } = {}) {
    const p = block.position
    const eye = eyePosition()
    const faceIndex = FACE_DIRS.findIndex(([x, y, z]) => x === face.x && y === face.y && z === face.z)
    if (faceIndex < 0) return { ok: false, reason: 'no-sight' }
    const candidates = []
    if (delta) {
      candidates.push(p.plus(delta))
    } else {
      const centre = [0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5]
      if (face.y === 0) {
        if (half === 'top') centre[1] += 0.25
        else if (half === 'bottom') centre[1] -= 0.25
      }
      const spread = [face.x === 0 ? jitter : 0, face.y === 0 ? (half ? Math.min(jitter, 0.15) : jitter) : 0, face.z === 0 ? jitter : 0]
      for (let i = 0; i < 4; i++) {
        candidates.push(p.offset(...centre.map((c, axis) => c + (Math.random() * 2 - 1) * spread[axis])))
      }
      candidates.push(p.offset(...centre))
    }
    let inReach = false
    let facing = false
    for (const c of candidates) {
      // the eyes must be on the outer side of the face (Grim: PositionPlace / PositionBreakA)
      if ((eye.x - c.x) * face.x + (eye.y - c.y) * face.y + (eye.z - c.z) * face.z <= 0) continue
      facing = true
      if (eye.distanceTo(c) > reach) continue
      inReach = true
      const hit = blockHit(p, eye, c.minus(eye).normalize(), reach)
      if (hit && hit.face === faceIndex) return { ok: true, point: hit.intersect }
    }
    return { ok: false, reason: inReach || !facing ? 'no-sight' : 'too-far' }
  }

  // The face of the block that looks at the eyes the most, for callers that look on their own
  function faceTowardsEyes (position) {
    const eye = eyePosition()
    const c = position.offset(0.5, 0.5, 0.5)
    let best = 1
    let bestDot = -Infinity
    FACE_DIRS.forEach(([x, y, z], i) => {
      const dot = (eye.x - c.x) * x + (eye.y - c.y) * y + (eye.z - c.z) * z
      if (dot > bestDot) { bestDot = dot; best = i }
    })
    return best
  }

  // `action` ('dig', 'place'...) also reports the refusal as the bot's 'actionRejected' event
  function blockError (reason, action, pos) {
    const err = new Error(reason === 'too-far' ? 'block is out of reach' : 'block is not visible within reach')
    err.code = reason
    if (action) bot._input.rejected(action, reason, pos ? `${err.message} (${pos.x} ${pos.y} ${pos.z})` : err.message)
    return err
  }

  // --- Entities -------------------------------------------------------------------------------------------------

  // The hitbox of an entity (as the bot knows it): { min, max }
  function entityBox (entity) {
    const width = entity.width > 0 ? entity.width : 0.6
    const height = entity.height > 0 ? entity.height : 1.8
    const p = entity.position
    return { min: new Vec3(p.x - width / 2, p.y, p.z - width / 2), max: new Vec3(p.x + width / 2, p.y + height, p.z + width / 2) }
  }

  // Where the ray (origin, unit direction) hits the entity's box within reach, with no block in front of it:
  // { point, distance } or null
  function entityRay (box, origin, dir, reach) {
    const hit = rayBox(origin, dir, box.min, box.max)
    if (!hit || hit.t > reach) return null
    if (hit.t > 0) {
      const block = bot.world.raycast(origin, dir, hit.t)
      if (block && origin.distanceTo(block.intersect) < hit.t - 1e-6) return null
    }
    return { point: hit.point, distance: hit.t }
  }

  // The same for the rotation of a movement packet
  function entityHit (entity, rot, reach = entityReach()) {
    return entityRay(entityBox(entity), eyePosition(), rotationDirection(rot), reach)
  }

  // A point of the entity's box the eyes can see within reach: { ok: true, point } or { ok: false, reason: 'too-far' |
  // 'no-sight' }. `near` is a point the caller wants to aim at (it is clamped into the box).
  function entityPoint (entity, { reach = entityReach(), near } = {}) {
    const box = entityBox(entity)
    const eye = eyePosition()
    const height = box.max.y - box.min.y
    const centre = new Vec3((box.min.x + box.max.x) / 2, box.min.y + height * 0.5, (box.min.z + box.max.z) / 2)
    const candidates = []
    if (near) candidates.push(new Vec3(Math.min(box.max.x, Math.max(box.min.x, near.x)), Math.min(box.max.y, Math.max(box.min.y, near.y)), Math.min(box.max.z, Math.max(box.min.z, near.z))))
    candidates.push(centre)
    const spreadX = (box.max.x - box.min.x) * 0.3
    for (let i = 0; i < 4; i++) {
      candidates.push(new Vec3(centre.x + (Math.random() * 2 - 1) * spreadX, box.min.y + height * (0.3 + Math.random() * 0.5), centre.z + (Math.random() * 2 - 1) * spreadX))
    }
    // the closest point of the box, pulled a little inwards, for a target at the edge of the reach
    const closest = new Vec3(Math.min(box.max.x, Math.max(box.min.x, eye.x)), Math.min(box.max.y, Math.max(box.min.y, eye.y)), Math.min(box.max.z, Math.max(box.min.z, eye.z)))
    candidates.push(closest.plus(centre.minus(closest).scaled(0.1)))
    for (const c of candidates) {
      const dir = c.minus(eye)
      if (dir.norm() === 0) return { ok: true, point: c }
      const hit = entityRay(box, eye, dir.normalize(), reach)
      if (hit) return { ok: true, point: hit.point }
    }
    return { ok: false, reason: distanceToBox(eye, box.min, box.max) > reach ? 'too-far' : 'no-sight' }
  }

  function entityError (reason, action, entity) {
    const messages = { gone: 'the entity is gone', 'too-far': 'the entity is out of reach', 'no-sight': 'the entity is not in view within reach', moved: 'the entity moved while aiming' }
    const err = new Error(messages[reason] ?? reason)
    err.code = reason
    if (action) bot._input.rejected(action, reason, entity ? `${err.message} (entity ${entity.id})` : err.message)
    return err
  }

  bot._aim = {
    FACE_DIRS,
    rayBox,
    distanceToBox,
    eyePosition,
    blockReach,
    entityReach,
    rotationDirection,
    currentRotation,
    ticks,
    releaseItem,
    standStill,
    lookSettled,
    isBreakable,
    blockHit,
    blockHitAt,
    blockAtLook,
    distanceToBlock,
    visiblePoint,
    facePoint,
    faceTowardsEyes,
    blockError,
    entityBox,
    entityRay,
    entityHit,
    entityPoint,
    entityError
  }
}

module.exports.rayBox = rayBox
module.exports.distanceToBox = distanceToBox
