// 9bFlayer physics engine: prismarine-physics 1.11.1, vendored, and made to move like the vanilla client.
//
// Why: the Grim anticheat re-simulates vanilla movement for every movement packet and sets the bot back when the
// result differs by 0.001 blocks or more. So on the versions we care about (1.21+) this engine follows the vanilla
// client (as mirrored by Grim) operation by operation: float placements, the Mth sin/cos lookup table, the 1.21 step-up
// algorithm, collision epsilons, block speed and jump factors, item-use slowdown, the sprint/swim fluid rules and the
// attribute algebra. Older versions keep the original prismarine-physics code paths (marked "legacy").
//
// Version gates (mcData is bot.registry):  modern = 1.21+   tinyMove = 1.21.2+   lengthThreshold = 1.21.5+
//                                           newTrig = 1.21.11+   friction26 = 26.2+   supportingBlock = 1.20+
const Vec3 = require('vec3').Vec3
const AABB = require('./aabb')
const math = require('./math')
const features = require('./features')
const attribute = require('./attribute')

const F = Math.fround

// ---- Mth.sin / Mth.cos: vanilla looks them up in a 65536 entry float table (the table changed in 1.21.11) ------------
let sinTable = null
let sinTableNew = null
const DEG_TO_RAD = F(Math.PI / 180) // Mth.DEG_TO_RAD: (float) (Math.PI / 180)
const SIN_SCALE = F(10430.378) // 65536 / (2 PI) as a float literal
const SIN_SCALE_NEW = 10430.378350470453 // 1.21.11+: the same constant, as a double
function getSinTable () {
  if (sinTable === null) {
    sinTable = new Float32Array(65536)
    for (let i = 0; i < 65536; i++) sinTable[i] = Math.sin(i * Math.PI * 2 / 65536) // (float) Math.sin(i * PI * 2 / 65536)
  }
  return sinTable
}
function getSinTableNew () {
  if (sinTableNew === null) {
    sinTableNew = new Float32Array(65536)
    for (let i = 0; i < 65536; i++) sinTableNew[i] = Math.sin(i / SIN_SCALE_NEW) // (float) Math.sin(i / 10430.378350470453)
  }
  return sinTableNew
}
// (int) (x * 10430.378F) & 65535, all in float arithmetic
const mthSin = r => getSinTable()[(F(r * SIN_SCALE) | 0) & 0xFFFF]
const mthCos = r => getSinTable()[(F(F(r * SIN_SCALE) + 16384) | 0) & 0xFFFF]
// (int) ((long) (x * 10430.378350470453) & 65535L), in double arithmetic
const newIndex = v => ((Math.trunc(v) % 65536) + 65536) % 65536
const mthSinNew = r => getSinTableNew()[newIndex(r * SIN_SCALE_NEW)]
const mthCosNew = r => getSinTableNew()[newIndex(r * SIN_SCALE_NEW + 16384)]
// The rotation a movement packet carries is a float in degrees (Notchian yaw); mineflayer keeps yaw as PI - radians
const notchYaw = yaw => F(((Math.PI - yaw) * 180) / Math.PI)
const yawRadians = yaw => F(notchYaw(yaw) * DEG_TO_RAD) // yRot * ((float) Math.PI / 180F)

function makeSupportFeature (mcData) {
  // A version newer than the newest one listed behaves like it (the lists end at the newest version known)
  const listed = new Set(features.flatMap(f => f.versions))
  const major = mcData.version.majorVersion
  const effective = !listed.has(major) && mcData.isNewerOrEqualTo?.('26.2') ? '26.2' : major
  return feature => features.some(({ name, versions }) => name === feature && versions.includes(effective))
}

function Physics (mcData, world) {
  const supportFeature = makeSupportFeature(mcData)
  const since = (version) => mcData.isNewerOrEqualTo ? mcData.isNewerOrEqualTo(version) : false
  const blocksByName = mcData.blocksByName
  const modern = since('1.21') // the vanilla 1.21 movement pipeline (see the header)
  const hasTinyMoveRule = since('1.21.2') // vanilla 1.21.2: a collided move under ~3e-4 blocks is not applied
  const hasNewTrig = since('1.21.11')
  const hasFriction26 = since('26.2') // 26.2: friction_modifier, air_drag_modifier and bounciness attributes
  const sin = hasNewTrig ? mthSinNew : mthSin
  const cos = hasNewTrig ? mthCosNew : mthCos

  // Block Slipperiness
  // https://www.mcpk.wiki/w/index.php?title=Slipperiness
  const blockSlipperiness = {}
  const slimeBlockId = blocksByName.slime_block ? blocksByName.slime_block.id : blocksByName.slime.id
  blockSlipperiness[slimeBlockId] = 0.8
  blockSlipperiness[blocksByName.ice.id] = 0.98
  blockSlipperiness[blocksByName.packed_ice.id] = 0.98
  if (blocksByName.frosted_ice) { // 1.9+
    blockSlipperiness[blocksByName.frosted_ice.id] = 0.98
  }
  if (blocksByName.blue_ice) { // 1.13+
    blockSlipperiness[blocksByName.blue_ice.id] = 0.989
  }

  // Block ids
  const soulsandId = blocksByName.soul_sand.id
  const honeyblockId = blocksByName.honey_block ? blocksByName.honey_block.id : -1 // 1.15+
  const webId = blocksByName.cobweb ? blocksByName.cobweb.id : blocksByName.web.id
  const waterIds = [blocksByName.water.id, blocksByName.flowing_water ? blocksByName.flowing_water.id : -1]
  const lavaIds = [blocksByName.lava.id, blocksByName.flowing_lava ? blocksByName.flowing_lava.id : -1]
  const ladderId = blocksByName.ladder.id
  const vineId = blocksByName.vine.id
  const scaffoldingId = blocksByName.scaffolding ? blocksByName.scaffolding.id : -1 // 1.14+

  // Trapdoors: the original list names 12 woods; 1.21+ takes every trapdoor block (bamboo, pale oak, copper...)
  const trapdoorIds = new Set()
  if (modern) {
    for (const name of Object.keys(blocksByName)) if (name.endsWith('_trapdoor')) trapdoorIds.add(blocksByName[name].id)
  } else {
    if (blocksByName.iron_trapdoor) { trapdoorIds.add(blocksByName.iron_trapdoor.id) } // 1.8+
    if (blocksByName.acacia_trapdoor) { trapdoorIds.add(blocksByName.acacia_trapdoor.id) } // 1.13+
    if (blocksByName.birch_trapdoor) { trapdoorIds.add(blocksByName.birch_trapdoor.id) } // 1.13+
    if (blocksByName.jungle_trapdoor) { trapdoorIds.add(blocksByName.jungle_trapdoor.id) } // 1.13+
    if (blocksByName.oak_trapdoor) { trapdoorIds.add(blocksByName.oak_trapdoor.id) } // 1.13+
    if (blocksByName.dark_oak_trapdoor) { trapdoorIds.add(blocksByName.dark_oak_trapdoor.id) } // 1.13+
    if (blocksByName.spruce_trapdoor) { trapdoorIds.add(blocksByName.spruce_trapdoor.id) } // 1.13+
    if (blocksByName.crimson_trapdoor) { trapdoorIds.add(blocksByName.crimson_trapdoor.id) } // 1.16+
    if (blocksByName.warped_trapdoor) { trapdoorIds.add(blocksByName.warped_trapdoor.id) } // 1.16+
    if (blocksByName.mangrove_trapdoor) { trapdoorIds.add(blocksByName.mangrove_trapdoor.id) } // 1.19+
    if (blocksByName.cherry_trapdoor) { trapdoorIds.add(blocksByName.cherry_trapdoor.id) } // 1.20+
  }

  // #minecraft:climbable: ladder, vine, scaffolding and (1.16/1.17+) the nether and cave vines. Older versions keep
  // ladder, vine and scaffolding only.
  const climbableIds = new Set([ladderId, vineId])
  if (scaffoldingId !== -1) climbableIds.add(scaffoldingId)
  if (modern) {
    for (const name of ['weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant', 'cave_vines', 'cave_vines_plant']) {
      if (blocksByName[name]) climbableIds.add(blocksByName[name].id)
    }
  }
  const bedIds = new Set()
  for (const name of Object.keys(blocksByName)) if (name.endsWith('_bed')) bedIds.add(blocksByName[name].id)

  const waterLike = new Set()
  if (blocksByName.seagrass) waterLike.add(blocksByName.seagrass.id) // 1.13+
  if (blocksByName.tall_seagrass) waterLike.add(blocksByName.tall_seagrass.id) // 1.13+
  if (blocksByName.kelp) waterLike.add(blocksByName.kelp.id) // 1.13+
  if (blocksByName.kelp_plant) waterLike.add(blocksByName.kelp_plant.id) // 1.13+
  const bubblecolumnId = blocksByName.bubble_column ? blocksByName.bubble_column.id : -1 // 1.13+
  if (blocksByName.bubble_column) waterLike.add(bubblecolumnId)

  // Attribute resources (the key bot.entity.attributes uses: 'minecraft:movement_speed' on 1.21.2+)
  const attributeResource = (name) => mcData.attributesByName?.[name]?.resource

  const physics = {
    gravity: 0.08, // blocks/tick^2 https://minecraft.gamepedia.com/Entity#Motion_of_entities
    airdrag: Math.fround(1 - 0.02), // actually (1 - drag)
    yawSpeed: 3.0,
    pitchSpeed: 3.0,
    playerSpeed: modern ? F(0.1) : 0.1, // the attribute base is the float 0.1F
    sprintSpeed: modern ? F(0.3) : 0.3, // the sprinting modifier amount is the float 0.3F
    sneakSpeed: 0.3,
    stepHeight: 0.6, // how much height can the bot step on without jump
    negligeableVelocity: 0.003, // actually 0.005 for 1.8, but seems fine
    soulsandSpeed: 0.4,
    honeyblockSpeed: 0.4,
    honeyblockJumpSpeed: modern ? 0.5 : 0.4, // vanilla Block jumpFactor 0.5 for honey (1.15+)
    ladderMaxSpeed: 0.15,
    ladderClimbSpeed: 0.2,
    // The vanilla box is (float) 0.6 / 2 wide and (float) 1.8 high: 0.30000001192... and 1.7999999523...
    // (proven on 9b9t: walls and stairs only stay clean with it)
    playerHalfWidth: F(0.6) / 2,
    playerHeight: F(1.8),
    waterInertia: 0.8,
    lavaInertia: 0.5,
    liquidAcceleration: 0.02,
    airborneInertia: 0.91,
    airborneAcceleration: 0.02,
    defaultSlipperiness: 0.6,
    outOfLiquidImpulse: 0.3,
    autojumpCooldown: 10, // ticks (0.5s)
    bubbleColumnSurfaceDrag: {
      down: 0.03,
      maxDown: -0.9,
      up: 0.1,
      maxUp: 1.8
    },
    bubbleColumnDrag: {
      down: 0.03,
      maxDown: -0.3,
      up: 0.06,
      maxUp: 0.7
    },
    slowFalling: 0.125,
    movementSpeedAttribute: mcData.attributesByName.movementSpeed.resource,
    // The sprinting modifier of the movement speed: a UUID up to 1.20.4, the id minecraft:sprinting since 1.20.5
    sprintingUUID: '662a6b8d-da3e-4c1c-8813-96ea6097278d', // SPEED_MODIFIER_SPRINTING_UUID is from LivingEntity.java
    sprintingIds: ['662a6b8d-da3e-4c1c-8813-96ea6097278d', 'minecraft:sprinting', 'sprinting'],
    modern, // the vanilla 1.21 pipeline is on
    // Vanilla 1.21.2+: jumping keeps a higher vertical speed (max(jumpPower, vy)) instead of replacing it
    modernJump: since('1.21.2'),
    // Vanilla 1.21.5+: a player's tiny horizontal speed is zeroed by its length (vx^2 + vz^2 < 9e-6), not per axis
    modernMinMovement: since('1.21.5')
  }

  if (supportFeature('independentLiquidGravity')) {
    physics.waterGravity = 0.02
    physics.lavaGravity = 0.02
  } else if (supportFeature('proportionalLiquidGravity')) {
    physics.waterGravity = physics.gravity / 16
    physics.lavaGravity = physics.gravity / 4
  } else {
    throw new Error('No liquid gravity settings, have you made sure the liquid gravity features are up to date?')
  }

  // ---- Attributes ---------------------------------------------------------------------------------------------------
  // LivingEntity attribute value: clamp((base + sum(add)) * (1 + sum(multiply base)) * prod(1 + multiply total))
  // `skip` lists modifier ids that are not counted (the server's sprinting modifier on the movement speed: the engine
  // adds the bot's own, and counting both would sprint at 1.3 squared)
  function attrValue (entity, name, def, min = -Infinity, max = Infinity, skip = null) {
    const resource = attributeResource(name)
    const prop = resource !== undefined ? entity.attributes?.[resource] : undefined
    if (!prop) return def
    const modifiers = skip && prop.modifiers ? prop.modifiers.filter(m => !skip.includes(m.uuid ?? m.id)) : (prop.modifiers ?? [])
    return Math.min(max, Math.max(min, attribute.getAttributeValue({ value: prop.value, modifiers })))
  }

  // LivingEntity.getSpeed(): the movement speed attribute as a float, with the sprinting boost when sprinting
  // (Grim: movementSpeed += movementSpeed * 0.3F; (float))
  function getMovementSpeed (entity) {
    let speed = attrValue(entity, 'movementSpeed', physics.playerSpeed, 0, 1024, physics.sprintingIds)
    if (entity.control.sprint) speed += speed * F(0.3)
    return F(speed)
  }

  function getPlayerBB (pos) {
    const w = physics.playerHalfWidth
    return new AABB(-w, 0, -w, w, physics.playerHeight, w).offset(pos.x, pos.y, pos.z)
  }

  function setPositionToBB (bb, pos) {
    pos.x = bb.minX + physics.playerHalfWidth
    pos.y = bb.minY
    pos.z = bb.minZ + physics.playerHalfWidth
  }

  function getSurroundingBBs (world, queryBB) {
    const surroundingBBs = []
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(queryBB.minY) - 1; cursor.y <= Math.floor(queryBB.maxY); cursor.y++) {
      for (cursor.z = Math.floor(queryBB.minZ); cursor.z <= Math.floor(queryBB.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(queryBB.minX); cursor.x <= Math.floor(queryBB.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          if (block) {
            const blockPos = block.position
            for (const shape of block.shapes) {
              const blockBB = new AABB(shape[0], shape[1], shape[2], shape[3], shape[4], shape[5])
              blockBB.offset(blockPos.x, blockPos.y, blockPos.z)
              surroundingBBs.push(blockBB)
            }
          }
        }
      }
    }
    return surroundingBBs
  }

  physics.adjustPositionHeight = (pos) => {
    const playerBB = getPlayerBB(pos)
    const queryBB = playerBB.clone().extend(0, -1, 0)
    const surroundingBBs = getSurroundingBBs(world, queryBB)

    let dy = -1
    for (const blockBB of surroundingBBs) {
      dy = blockBB.computeOffsetY(playerBB, dy)
    }
    pos.y += dy
  }

  // ---- Vanilla 1.21 Entity.move / Entity.collide ---------------------------------------------------------------------
  const E7 = 1.0E-7 // Shapes.collide epsilon (Grim: SimpleCollisionBox.COLLISION_EPSILON)
  // How far `s` (a block shape) lets `o` (the player) move along an axis: a shape counts as ahead of the box if it
  // is not penetrated by more than 1e-7, and the overlap in the other two axes has to exceed 1e-7
  const collideX = (s, o, d) => {
    if (d !== 0 && o.minY - s.maxY < -E7 && o.maxY - s.minY > E7 && o.minZ - s.maxZ < -E7 && o.maxZ - s.minZ > E7) {
      if (d >= 0) { const m = s.minX - o.maxX; return m < -E7 ? d : Math.min(m, d) }
      const m = s.maxX - o.minX; return m > E7 ? d : Math.max(m, d)
    }
    return d
  }
  const collideY = (s, o, d) => {
    if (d !== 0 && o.minX - s.maxX < -E7 && o.maxX - s.minX > E7 && o.minZ - s.maxZ < -E7 && o.maxZ - s.minZ > E7) {
      if (d >= 0) { const m = s.minY - o.maxY; return m < -E7 ? d : Math.min(m, d) }
      const m = s.maxY - o.minY; return m > E7 ? d : Math.max(m, d)
    }
    return d
  }
  const collideZ = (s, o, d) => {
    if (d !== 0 && o.minX - s.maxX < -E7 && o.maxX - s.minX > E7 && o.minY - s.maxY < -E7 && o.maxY - s.minY > E7) {
      if (d >= 0) { const m = s.minZ - o.maxZ; return m < -E7 ? d : Math.min(m, d) }
      const m = s.maxZ - o.minZ; return m > E7 ? d : Math.max(m, d)
    }
    return d
  }
  // Shapes.collide(axis, box, shapes, d): gives up (0) as soon as |d| < 1e-7 in front of a shape
  const sweep = (fn, bb, boxes, d) => { for (const s of boxes) { if (Math.abs(d) < E7) return 0; d = fn(s, bb, d) } return d }

  // Entity.collideWithShapes: Y first, then the axis with the larger |movement| first
  function collideWithShapes (x, y, z, bb, boxes) {
    if (boxes.length === 0) return [x, y, z]
    const b = bb.clone()
    if (y !== 0) { y = sweep(collideY, b, boxes, y); if (y !== 0) b.offset(0, y, 0) }
    const zFirst = Math.abs(x) < Math.abs(z)
    if (zFirst && z !== 0) { z = sweep(collideZ, b, boxes, z); if (z !== 0) b.offset(0, 0, z) }
    if (x !== 0) { x = sweep(collideX, b, boxes, x); if (x !== 0) b.offset(x, 0, 0) }
    if (!zFirst && z !== 0) z = sweep(collideZ, b, boxes, z)
    return [x, y, z]
  }

  // the block shapes that strictly intersect `box` (BlockCollisions)
  function collidersIn (world, box) {
    return getSurroundingBBs(world, box).filter(s => s.intersects(box))
  }

  // Entity.collide(Vec3) of 1.21+: the step-up candidates are the float Y breakpoints of the colliders
  function collideVanilla (world, bb, mx, my, mz, onGround) {
    const step = F(physics.stepHeight)
    const r = (mx === 0 && my === 0 && mz === 0) ? [mx, my, mz] : collideWithShapes(mx, my, mz, bb, collidersIn(world, bb.clone().extend(mx, my, mz)))
    const hitX = mx !== r[0]
    const hitY = my !== r[1]
    const hitZ = mz !== r[2]
    const landing = hitY && my < 0
    if (step > 0 && (landing || onGround) && (hitX || hitZ)) {
      // a landing step starts from the box that has already fallen; otherwise 1e-5 below, to find a floor to step from
      const bb1 = landing ? bb.clone().offset(0, r[1], 0) : bb.clone()
      const bb2 = bb1.clone().extend(mx, step, mz)
      if (!landing) bb2.extend(0, -F(1.0E-5), 0)
      const list = collidersIn(world, bb2)
      const f = F(r[1])
      const heights = new Set()
      for (const s of list) {
        for (const y of [s.minY, s.maxY]) { // VoxelShape.getCoords(Y): the shape's Y breakpoints, ascending
          const h = F(y - bb1.minY)
          if (!(h < 0) && h !== f) { if (h > step) break; heights.add(h) }
        }
      }
      for (const h of [...heights].sort((a, b) => a - b)) {
        const c = collideWithShapes(mx, h, mz, bb1, list)
        if (c[0] * c[0] + c[2] * c[2] > r[0] * r[0] + r[2] * r[2]) {
          return [c[0], c[1] - (bb.minY - bb1.minY), c[2]] // vec.add(0, -(box.minY - stepBox.minY), 0)
        }
      }
    }
    return r
  }

  // Entity.isHorizontalCollisionMinor (1.21.2+): sliding along a wall within ~8 degrees of the pressed direction
  // does not stop sprinting. xxa / zza are the impulses after the 0.98F, sneak and item factors (+xxa is left).
  function isHorizontalCollisionMinor (entity, cx, cz) {
    const lenSq = cx * cx + cz * cz
    if (lenSq < F(1.0E-5)) return false
    const rad = yawRadians(entity.yaw)
    const s = sin(rad)
    const c = cos(rad)
    const xxa = entity.xxa || 0
    const zza = entity.zza || 0
    const g = xxa * c - zza * s
    const h = zza * c + xxa * s
    const i = g * g + h * h
    return i >= F(1.0E-5) && Math.acos((g * cx + h * cz) / Math.sqrt(i * lenSq)) < F(0.13962634)
  }

  // ---- The supporting block (Entity.checkSupportingBlock / mainSupportingBlockPos) ---------------------------------
  // Vanilla 1.20+ (Grim: everything newer than 1.19.4) takes the block for friction, the block speed / jump factor and
  // the bounce from the block that SUPPORTS the box, not from the block under the centre: with the centre past an
  // edge but the box still on the block (ice, slime, soul sand, honey), the block is still the one stood on.
  // Older versions look under the centre (Grim: floor(x), floor(y - 0.5000001), floor(z)).
  const hasSupportingBlock = since('1.20')
  const nameEndsWith = (block, suffix) => !!block && typeof block.name === 'string' && block.name.endsWith(suffix)

  // BlockGetter.findSupportingBlock(entity, box): of the blocks whose collision shape strictly intersects `box`, the one
  // whose centre is closest to the entity position. Equal distances are broken as Grim does
  // (MainSupportingBlockPosFinder.firstHasPriorityOverSecond, ported as it is). Blocks are visited Y, Z, X ascending.
  function findSupportingBlock (world, box, pos) {
    let best = null
    let bestDistance = Infinity
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(box.minY) - 1; cursor.y <= Math.floor(box.maxY); cursor.y++) {
      for (cursor.z = Math.floor(box.minZ); cursor.z <= Math.floor(box.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(box.minX); cursor.x <= Math.floor(box.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          if (!block || !block.shapes) continue
          const hit = block.shapes.some(s => new AABB(s[0], s[1], s[2], s[3], s[4], s[5]).offset(cursor.x, cursor.y, cursor.z).intersects(box))
          if (!hit) continue
          const dx = cursor.x + 0.5 - pos.x
          const dy = cursor.y + 0.5 - pos.y
          const dz = cursor.z + 0.5 - pos.z
          const distance = dx * dx + dy * dy + dz * dz
          if (distance < bestDistance || (distance === bestDistance && best && firstHasPriority(cursor, best))) {
            best = { x: cursor.x, y: cursor.y, z: cursor.z }
            bestDistance = distance
          }
        }
      }
    }
    return best
  }

  function firstHasPriority (first, second) {
    if (first.y < second.y) return true
    const sumX = second.x - first.x
    const sumZ = second.z - first.z
    const total = sumX + sumZ
    if (total === 0) return sumX < 0
    return total < 0
  }

  // Entity.checkSupportingBlock(onGround, movement), run at the end of every move with the collided movement.
  // In the air the supporting block is cleared. On the ground it is searched in the 1e-6 slab under the box; when the
  // slab holds nothing (the box hangs over an edge by less than the step the physics took) and the last tick did find
  // a block, the slab is searched again where the box was before the move. "On the ground with no block" is
  // remembered, so that a second such tick does not search again: the position is then taken from the centre.
  function checkSupportingBlock (entity, world, movementX, movementZ) {
    if (!hasSupportingBlock) return
    if (!entity.onGround) {
      entity.supportingBlock = null
      entity.supportNoBlocks = false
      return
    }
    const bb = getPlayerBB(entity.pos)
    const slab = new AABB(bb.minX, bb.minY - 1.0E-6, bb.minZ, bb.maxX, bb.minY, bb.maxZ)
    let found = findSupportingBlock(world, slab, entity.pos)
    if (!found && !entity.supportNoBlocks) found = findSupportingBlock(world, slab.offset(-movementX, 0, -movementZ), entity.pos)
    entity.supportingBlock = found
    entity.supportNoBlocks = !found
  }

  // Entity.getOnPos(yOffset): the supporting block's x / z with y = floor(pos.y - yOffset), except that walls and fence
  // gates (and fences, for offsets up to 0.5) are used as they are, their collision box being taller than the block.
  // Without a supporting block: the block under the centre. Before 1.20: always the latter.
  function onPos (entity, world, yOffset) {
    const s = hasSupportingBlock ? entity.supportingBlock : null
    const y = Math.floor(entity.pos.y - yOffset)
    if (!s) return new Vec3(Math.floor(entity.pos.x), y, Math.floor(entity.pos.z))
    const block = world.getBlock(new Vec3(s.x, s.y, s.z))
    const asIs = (yOffset <= 0.5 && nameEndsWith(block, '_fence')) || nameEndsWith(block, '_wall') || nameEndsWith(block, '_fence_gate')
    return new Vec3(s.x, asIs ? s.y : y, s.z)
  }

  // Entity.getBlockPosBelowThatAffectsMyMovement() = getOnPos(0.500001F): friction, block speed factor, jump factor.
  // (Grim: BlockProperties.getFriction / getBlockSpeedFactor / onHoneyBlock. Bounces use getOnPos(0.2F), see below.)
  function blockBelowThatAffectsMovement (world, entity) {
    return world.getBlock(onPos(entity, world, F(0.500001)))
  }
  function blockSpeedFactorOf (b) { return (b && (b.type === soulsandId || b.type === honeyblockId)) ? F(0.4) : 1 }
  function blockJumpFactorOf (b) { return (b && b.type === honeyblockId) ? F(0.5) : 1 }
  // Entity.getBlockSpeedFactor: the block at the feet decides, otherwise (unless that is water or a bubble column) the
  // block below that affects movement
  function blockSpeedFactor (world, entity) {
    const feet = world.getBlock(entity.pos)
    const f = blockSpeedFactorOf(feet)
    if (f !== 1 || (feet && (waterIds.includes(feet.type) || feet.type === bubblecolumnId))) return f
    return blockSpeedFactorOf(blockBelowThatAffectsMovement(world, entity))
  }
  // Entity.getBlockJumpFactor: the block at the feet, if it has a factor, else the block below that affects movement
  function blockJumpFactor (world, entity) {
    const f = blockJumpFactorOf(world.getBlock(entity.pos))
    return f !== 1 ? f : blockJumpFactorOf(blockBelowThatAffectsMovement(world, entity))
  }

  // Block.updateEntityMovementAfterFallOn: what a vertical collision does to the vertical speed. Slime and beds bounce
  // (not while sneaking), everything else stops. 26.2 changed bouncing (restitution with gravity compensation).
  function velocityAfterVerticalCollision (entity, world, vy, movementY) {
    const blockAtFeet = world.getBlock(onPos(entity, world, F(0.2))) // Entity.getOnPosLegacy()
    let restitution = 0
    if (blockAtFeet) {
      if (blockAtFeet.type === slimeBlockId) restitution = 1
      else if (bedIds.has(blockAtFeet.type)) restitution = hasFriction26 ? 0.75 : 0.66
    }
    const bounciness = hasFriction26 ? attrValue(entity, 'bounciness', 0, 0, 1) : 0
    if (restitution <= 0 && bounciness <= 0) return 0
    if (entity.control.sneak) return 0
    if (vy >= 0) return vy // only a falling body bounces
    if (!hasFriction26) return -vy * restitution
    restitution = Math.max(restitution, bounciness)
    const gravity = attrValue(entity, 'gravity', physics.gravity, -1, 1)
    if (-vy < gravity || restitution <= 0) return 0
    const portion = vy === 0 ? 0 : movementY / vy
    const drag = 1 + portion * (airDrag(entity, 0.98) - 1)
    return (portion * gravity - vy) * drag * restitution
  }

  // Player.isAboveGround: on the ground, or having fallen less than a step onto a floor within a step
  function isAboveGround (entity, world, step) {
    if (entity.onGround) return true
    const fall = entity.fallDistance || 0
    return fall < step && collidersIn(world, getPlayerBB(entity.pos).offset(0, fall - step, 0)).length > 0
  }

  // Entity.move for 1.21+
  function moveEntityVanilla (entity, world, dx, dy, dz) {
    const vel = entity.vel
    const pos = entity.pos

    if (entity.isInWeb) {
      dx *= 0.25
      dy *= 0.05
      dz *= 0.25
      vel.x = 0
      vel.y = 0
      vel.z = 0
      entity.isInWeb = false
    }

    const playerBB = getPlayerBB(pos)

    // Player.maybeBackOffFromEdge (as mirrored by Grim): while sneaking above ground the horizontal move shrinks in
    // 0.05 steps until the box, shifted down by the step height, touches a floor. The key is this tick's.
    if (entity.control.sneak && isAboveGround(entity, world, F(physics.stepHeight))) {
      const down = -F(physics.stepHeight)
      const empty = (ox, oz) => collidersIn(world, playerBB.clone().offset(ox, down, oz)).length === 0
      const shrink = v => (v < 0.05 && v >= -0.05) ? 0 : (v > 0 ? v - 0.05 : v + 0.05)
      while (dx !== 0 && empty(dx, 0)) dx = shrink(dx)
      while (dz !== 0 && empty(0, dz)) dz = shrink(dz)
      while (dx !== 0 && dz !== 0 && empty(dx, dz)) { dx = shrink(dx); dz = shrink(dz) }
    }
    const inX = dx
    const inY = dy
    const inZ = dz

    const [cx, cy, cz] = collideVanilla(world, playerBB, dx, dy, dz, entity.onGround)

    // The move is applied, unless it is a sliver (under ~3e-4 blocks) that does not simply press into a wall.
    // 1.21.2 added the second condition; before it any such sliver was dropped.
    const lenSq = cx * cx + cy * cy + cz * cz
    if (lenSq > 1.0E-7 || (hasTinyMoveRule && inX * inX + inY * inY + inZ * inZ - lenSq < 1.0E-7)) {
      pos.x += cx
      pos.y += cy
      pos.z += cz
    }

    // Flags: horizontal contact uses Mth.equal (1e-5 as a float), vertical is exact
    const equalLimit = F(1.0E-5)
    const hitX = Math.abs(inX - cx) >= equalLimit
    const hitZ = Math.abs(inZ - cz) >= equalLimit
    entity.isCollidedHorizontally = hitX || hitZ
    entity.minorHorizontalCollision = entity.isCollidedHorizontally && isHorizontalCollisionMinor(entity, cx, cz)
    entity.isCollidedVertically = inY !== cy
    entity.onGround = entity.isCollidedVertically && inY < 0
    checkSupportingBlock(entity, world, cx, cz)
    // Entity.checkFallDamage: the distance fallen since the last time on the ground
    if (entity.onGround) entity.fallDistance = 0
    else if (cy < 0) entity.fallDistance = (entity.fallDistance || 0) - cy

    // Horizontal contact stops the speed (26.2: it bounces by the bounciness attribute, 0 by default)
    const bounce = hasFriction26 ? attrValue(entity, 'bounciness', 0, 0, 1) : 0
    if (hitX) vel.x = bounce > 0 && !entity.control.sneak ? -vel.x * bounce : 0
    if (hitZ) vel.z = bounce > 0 && !entity.control.sneak ? -vel.z * bounce : 0
    if (inY !== cy) vel.y = velocityAfterVerticalCollision(entity, world, vel.y, cy)

    // Finally, apply block collisions (web, bubble columns)
    const inside = getPlayerBB(pos).contract(0.001, 0.001, 0.001)
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(inside.minY); cursor.y <= Math.floor(inside.maxY); cursor.y++) {
      for (cursor.z = Math.floor(inside.minZ); cursor.z <= Math.floor(inside.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(inside.minX); cursor.x <= Math.floor(inside.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          if (block) {
            if (block.type === webId) {
              entity.isInWeb = true
            } else if (block.type === bubblecolumnId) {
              const down = !block.metadata
              const aboveBlock = world.getBlock(cursor.offset(0, 1, 0))
              const bubbleDrag = (aboveBlock && aboveBlock.type === 0 /* air */) ? physics.bubbleColumnSurfaceDrag : physics.bubbleColumnDrag
              if (down) {
                vel.y = Math.max(bubbleDrag.maxDown, vel.y - bubbleDrag.down)
              } else {
                vel.y = Math.min(bubbleDrag.maxUp, vel.y + bubbleDrag.up)
              }
            }
          }
        }
      }
    }

    // Entity.move ends with the block speed factor (soul sand, honey: 0.4F), lerped by the movement_efficiency
    // attribute (soul speed boots), on the horizontal speed
    let factor = blockSpeedFactor(world, entity)
    if (factor !== 1) {
      const efficiency = attrValue(entity, 'movementEfficiency', 0, 0, 1)
      if (efficiency > 0) factor = F(factor + F(efficiency) * (1 - factor))
      vel.x *= factor
      vel.z *= factor
    }
  }

  // ---- The original prismarine-physics Entity.move (versions before 1.21) -------------------------------------------
  function moveEntityLegacy (entity, world, dx, dy, dz) {
    const vel = entity.vel
    const pos = entity.pos

    if (entity.isInWeb) {
      dx *= 0.25
      dy *= 0.05
      dz *= 0.25
      vel.x = 0
      vel.y = 0
      vel.z = 0
      entity.isInWeb = false
    }

    let oldVelX = dx
    const oldVelY = dy
    let oldVelZ = dz

    if (entity.control.sneak && entity.onGround) {
      const step = 0.05

      // In the 3 loops bellow, y offset should be -1, but that doesnt reproduce vanilla behavior.
      for (; dx !== 0 && getSurroundingBBs(world, getPlayerBB(pos).offset(dx, 0, 0)).length === 0; oldVelX = dx) {
        if (dx < step && dx >= -step) dx = 0
        else if (dx > 0) dx -= step
        else dx += step
      }

      for (; dz !== 0 && getSurroundingBBs(world, getPlayerBB(pos).offset(0, 0, dz)).length === 0; oldVelZ = dz) {
        if (dz < step && dz >= -step) dz = 0
        else if (dz > 0) dz -= step
        else dz += step
      }

      while (dx !== 0 && dz !== 0 && getSurroundingBBs(world, getPlayerBB(pos).offset(dx, 0, dz)).length === 0) {
        if (dx < step && dx >= -step) dx = 0
        else if (dx > 0) dx -= step
        else dx += step

        if (dz < step && dz >= -step) dz = 0
        else if (dz > 0) dz -= step
        else dz += step

        oldVelX = dx
        oldVelZ = dz
      }
    }

    let playerBB = getPlayerBB(pos)
    const queryBB = playerBB.clone().extend(dx, dy, dz)
    const surroundingBBs = getSurroundingBBs(world, queryBB)
    const oldBB = playerBB.clone()

    for (const blockBB of surroundingBBs) {
      dy = blockBB.computeOffsetY(playerBB, dy)
    }
    playerBB.offset(0, dy, 0)

    for (const blockBB of surroundingBBs) {
      dx = blockBB.computeOffsetX(playerBB, dx)
    }
    playerBB.offset(dx, 0, 0)

    for (const blockBB of surroundingBBs) {
      dz = blockBB.computeOffsetZ(playerBB, dz)
    }
    playerBB.offset(0, 0, dz)

    // Step on block if height < stepHeight
    if (physics.stepHeight > 0 &&
      (entity.onGround || (dy !== oldVelY && oldVelY < 0)) &&
      (dx !== oldVelX || dz !== oldVelZ)) {
      const oldVelXCol = dx
      const oldVelYCol = dy
      const oldVelZCol = dz
      const oldBBCol = playerBB.clone()

      dy = physics.stepHeight
      const queryBB = oldBB.clone().extend(oldVelX, dy, oldVelZ)
      const surroundingBBs = getSurroundingBBs(world, queryBB)

      const BB1 = oldBB.clone()
      const BB2 = oldBB.clone()
      const BB_XZ = BB1.clone().extend(dx, 0, dz)

      let dy1 = dy
      let dy2 = dy
      for (const blockBB of surroundingBBs) {
        dy1 = blockBB.computeOffsetY(BB_XZ, dy1)
        dy2 = blockBB.computeOffsetY(BB2, dy2)
      }
      BB1.offset(0, dy1, 0)
      BB2.offset(0, dy2, 0)

      let dx1 = oldVelX
      let dx2 = oldVelX
      for (const blockBB of surroundingBBs) {
        dx1 = blockBB.computeOffsetX(BB1, dx1)
        dx2 = blockBB.computeOffsetX(BB2, dx2)
      }
      BB1.offset(dx1, 0, 0)
      BB2.offset(dx2, 0, 0)

      let dz1 = oldVelZ
      let dz2 = oldVelZ
      for (const blockBB of surroundingBBs) {
        dz1 = blockBB.computeOffsetZ(BB1, dz1)
        dz2 = blockBB.computeOffsetZ(BB2, dz2)
      }
      BB1.offset(0, 0, dz1)
      BB2.offset(0, 0, dz2)

      const norm1 = dx1 * dx1 + dz1 * dz1
      const norm2 = dx2 * dx2 + dz2 * dz2

      if (norm1 > norm2) {
        dx = dx1
        dy = -dy1
        dz = dz1
        playerBB = BB1
      } else {
        dx = dx2
        dy = -dy2
        dz = dz2
        playerBB = BB2
      }

      for (const blockBB of surroundingBBs) {
        dy = blockBB.computeOffsetY(playerBB, dy)
      }
      playerBB.offset(0, dy, 0)

      if (oldVelXCol * oldVelXCol + oldVelZCol * oldVelZCol >= dx * dx + dz * dz) {
        dx = oldVelXCol
        dy = oldVelYCol
        dz = oldVelZCol
        playerBB = oldBBCol
      }
    }

    // Update flags
    setPositionToBB(playerBB, pos)
    entity.isCollidedHorizontally = dx !== oldVelX || dz !== oldVelZ
    entity.isCollidedVertically = dy !== oldVelY
    entity.onGround = entity.isCollidedVertically && oldVelY < 0
    checkSupportingBlock(entity, world, dx, dz)

    const blockAtFeet = world.getBlock(hasSupportingBlock ? onPos(entity, world, 0.2) : pos.offset(0, -0.2, 0))

    if (dx !== oldVelX) vel.x = 0
    if (dz !== oldVelZ) vel.z = 0
    if (dy !== oldVelY) {
      if (blockAtFeet && blockAtFeet.type === slimeBlockId && !entity.control.sneak) {
        vel.y = -vel.y
      } else {
        vel.y = 0
      }
    }

    // Finally, apply block collisions (web, soulsand...)
    playerBB.contract(0.001, 0.001, 0.001)
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(playerBB.minY); cursor.y <= Math.floor(playerBB.maxY); cursor.y++) {
      for (cursor.z = Math.floor(playerBB.minZ); cursor.z <= Math.floor(playerBB.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(playerBB.minX); cursor.x <= Math.floor(playerBB.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          if (block) {
            if (supportFeature('velocityBlocksOnCollision')) {
              if (block.type === soulsandId) {
                vel.x *= physics.soulsandSpeed
                vel.z *= physics.soulsandSpeed
              } else if (block.type === honeyblockId) {
                vel.x *= physics.honeyblockSpeed
                vel.z *= physics.honeyblockSpeed
              }
            }
            if (block.type === webId) {
              entity.isInWeb = true
            } else if (block.type === bubblecolumnId) {
              const down = !block.metadata
              const aboveBlock = world.getBlock(cursor.offset(0, 1, 0))
              const bubbleDrag = (aboveBlock && aboveBlock.type === 0 /* air */) ? physics.bubbleColumnSurfaceDrag : physics.bubbleColumnDrag
              if (down) {
                vel.y = Math.max(bubbleDrag.maxDown, vel.y - bubbleDrag.down)
              } else {
                vel.y = Math.min(bubbleDrag.maxUp, vel.y + bubbleDrag.up)
              }
            }
          }
        }
      }
    }
    if (supportFeature('velocityBlocksOnTop')) {
      // 1.15-1.20: the block at the feet, else the one half a block below them (the original looked a whole block
      // too low, so soul sand under the feet never slowed the bot)
      const blockAt = world.getBlock(entity.pos)
      let factorBlock = blockAt && (blockAt.type === soulsandId || blockAt.type === honeyblockId) ? blockAt : null
      if (!factorBlock && !(blockAt && (waterIds.includes(blockAt.type) || blockAt.type === bubblecolumnId))) {
        const below = hasSupportingBlock ? blockBelowThatAffectsMovement(world, entity) : world.getBlock(entity.pos.offset(0, -0.5000001, 0))
        if (below && (below.type === soulsandId || below.type === honeyblockId)) factorBlock = below
      }
      if (factorBlock) {
        const f = factorBlock.type === soulsandId ? physics.soulsandSpeed : physics.honeyblockSpeed
        vel.x *= f
        vel.z *= f
      }
    }
  }

  function moveEntity (entity, world, dx, dy, dz) {
    return modern ? moveEntityVanilla(entity, world, dx, dy, dz) : moveEntityLegacy(entity, world, dx, dy, dz)
  }

  function getLookingVector (entity) {
    // given a yaw pitch, we need the looking vector

    // yaw is right handed rotation about y (up) starting from -z (north)
    // pitch is -90 looking down, 90 looking up, 0 looking at horizon
    // lets get its coordinate system.
    // let x' = -z (north)
    // let y' = -x (west)
    // let z' = y (up)

    // the non normalized looking vector in x', y', z' space is
    // x' is cos(yaw)
    // y' is sin(yaw)
    // z' is tan(pitch)

    // substituting back in x, y, z, we get the looking vector in the normal x, y, z space
    // -z = cos(yaw) => z = -cos(yaw)
    // -x = sin(yaw) => x = -sin(yaw)
    // y = tan(pitch)

    // normalizing the vectors, we divide each by |sqrt(x*x + y*y + z*z)|
    // x*x + z*z = sin^2 + cos^2 = 1
    // so |sqrt(xx+yy+zz)| = |sqrt(1+tan^2(pitch))|
    //     = |sqrt(1+sin^2(pitch)/cos^2(pitch))|
    //     = |sqrt((cos^2+sin^2)/cos^2(pitch))|
    //     = |sqrt(1/cos^2(pitch))|
    //     = |+/- 1/cos(pitch)|
    //     = 1/cos(pitch) since pitch in [-90, 90]

    // the looking vector is therefore
    // x = -sin(yaw) * cos(pitch)
    // y = tan(pitch) * cos(pitch) = sin(pitch)
    // z = -cos(yaw) * cos(pitch)

    const yaw = entity.yaw
    const pitch = entity.pitch
    const sinYaw = Math.sin(yaw)
    const cosYaw = Math.cos(yaw)
    const sinPitch = Math.sin(pitch)
    const cosPitch = Math.cos(pitch)
    const lookX = -sinYaw * cosPitch
    const lookY = sinPitch
    const lookZ = -cosYaw * cosPitch
    const lookDir = new Vec3(lookX, lookY, lookZ)
    return {
      yaw,
      pitch,
      sinYaw,
      cosYaw,
      sinPitch,
      cosPitch,
      lookX,
      lookY,
      lookZ,
      lookDir
    }
  }

  function applyHeading (entity, strafe, forward, multiplier) {
    let speed = Math.sqrt(strafe * strafe + forward * forward)
    if (speed < 0.01) return new Vec3(0, 0, 0)

    speed = multiplier / Math.max(speed, 1)

    strafe *= speed
    forward *= speed

    const yaw = Math.PI - entity.yaw
    const sin = Math.sin(yaw)
    const cos = Math.cos(yaw)

    const vel = entity.vel
    vel.x -= strafe * cos + forward * sin
    vel.z += forward * cos - strafe * sin
  }

  // Entity.moveRelative + Entity.getInputVector (1.21+). `strafe` is mineflayer's (right - left) and `forward`, both
  // floats already scaled by 0.98F and the sneak / item factors; `speed` is a float. The yaw is the float the movement
  // packet carries, and sin / cos come from Mth's lookup table.
  function moveRelative (entity, strafe, forward, speed) {
    let x = -strafe // vanilla's leftImpulse is positive to the left
    let z = forward
    const lengthSqr = x * x + z * z
    if (lengthSqr < 1.0E-7) return
    if (lengthSqr > 1.0) { const length = Math.sqrt(lengthSqr); x /= length; z /= length } // Vec3.normalize
    x *= speed
    z *= speed
    const rad = yawRadians(entity.yaw)
    const s = sin(rad)
    const c = cos(rad)
    entity.vel.x += x * c - z * s
    entity.vel.z += z * c + x * s
  }

  const climbableTrapdoorFeature = supportFeature('climbableTrapdoor')
  function isOnLadder (world, pos) {
    const block = world.getBlock(pos)
    if (!block) { return false }
    if (climbableIds.has(block.type)) { return true }

    // Since 1.9, when a trapdoor satisfies the following conditions, it also becomes climbable:
    //  1. The trapdoor is placed directly above a ladder.
    //  2. The trapdoor is opened.
    //  3. The trapdoor and the ladder directly below it face the same direction.
    if (climbableTrapdoorFeature && trapdoorIds.has(block.type)) {
      const blockBelow = world.getBlock(pos.offset(0, -1, 0))
      if (!blockBelow || blockBelow.type !== ladderId) { return false } // condition 1.
      const blockProperties = block._properties
      if (!blockProperties?.open) { return false } // condition 2.
      if (blockProperties.facing !== blockBelow.getProperties().facing) { return false } // condition 3
      return true
    }

    return false
  }

  function doesNotCollide (world, pos) {
    const pBB = getPlayerBB(pos)
    return !getSurroundingBBs(world, pBB).some(x => pBB.intersects(x)) && getWaterInBB(world, pBB).length === 0
  }

  // 26.2: friction_modifier and air_drag_modifier scale (1 - friction); both default to 1 (no change)
  function airDrag (entity, base) {
    if (!hasFriction26) return F(base)
    return Math.min(1, Math.max(0, F(1 - F(1 - F(base)) * F(attrValue(entity, 'airDragModifier', 1)))))
  }
  function blockFriction (entity, friction) {
    if (!hasFriction26) return friction
    return Math.min(1, Math.max(0, F(1 - F(1 - friction) * F(attrValue(entity, 'frictionModifier', 1)))))
  }

  function moveEntityWithHeading (entity, world, strafe, forward) {
    const vel = entity.vel
    const pos = entity.pos

    const gravityAttribute = modern ? attrValue(entity, 'gravity', physics.gravity, -1, 1) : physics.gravity
    // slow falling: gravity is at most 0.01 while the bot is not rising
    const slowFalling = vel.y <= 0 && entity.slowFalling > 0
    const gravityMultiplier = slowFalling ? physics.slowFalling : 1
    const gravity = modern ? (slowFalling ? Math.min(gravityAttribute, 0.01) : gravityAttribute) : physics.gravity * gravityMultiplier

    if (entity.isInWater || entity.isInLava) {
      // Water / Lava movement
      const lastY = pos.y
      let acceleration = physics.liquidAcceleration
      const inertia = entity.isInWater ? physics.waterInertia : physics.lavaInertia
      let horizontalInertia = inertia
      const falling = vel.y <= 0 // travelInWater's isFalling, at the start of the travel
      const swimming = modern && entity.isInWater // LivingEntity.travelInWater (lava keeps the original code)

      if (swimming) {
        // Sprint-swimming glides further (friction 0.9F instead of 0.8F); the water movement efficiency attribute
        // (depth strider, 1.21+) pulls the friction towards the ground's and speeds up the swimming
        horizontalInertia = entity.control.sprint ? F(0.9) : F(0.8)
        acceleration = F(0.02)
        let efficiency = F(attrValue(entity, 'waterMovementEfficiency', 0, 0, 1))
        if (!entity.onGround) efficiency = F(efficiency * F(0.5))
        if (efficiency > 0) {
          horizontalInertia = F(horizontalInertia + F(F(F(0.54600006) - horizontalInertia) * efficiency))
          acceleration = F(acceleration + F(F(getMovementSpeed(entity) - acceleration) * efficiency))
        }
        if (entity.dolphinsGrace > 0) horizontalInertia = F(0.96)
      } else if (entity.isInWater) {
        let strider = Math.min(entity.depthStrider, 3)
        if (!entity.onGround) {
          strider *= 0.5
        }
        if (strider > 0) {
          horizontalInertia += (0.546 - horizontalInertia) * strider / 3
          acceleration += (0.7 - acceleration) * strider / 3
        }

        if (entity.dolphinsGrace > 0) horizontalInertia = 0.96
      }

      if (modern) moveRelative(entity, strafe, forward, F(acceleration))
      else applyHeading(entity, strafe, forward, acceleration)
      moveEntity(entity, world, vel.x, vel.y, vel.z)
      if (swimming) {
        // a bot against a wall in a climbable block climbs, in water too (1.14+)
        if (entity.isCollidedHorizontally && isOnLadder(world, pos)) vel.y = physics.ladderClimbSpeed
        vel.x *= horizontalInertia
        vel.y *= F(0.8)
        vel.z *= horizontalInertia
        // FluidFallingAdjustedMovement: gravity / 16 sinks the bot in water, except while sprint-swimming
        if (!entity.control.sprint) {
          const g = gravity / 16
          vel.y = (falling && Math.abs(vel.y - 0.005) >= 0.003 && Math.abs(vel.y - g) < 0.003) ? -0.003 : vel.y - g
        }
      } else {
        vel.y *= inertia
        vel.y -= (entity.isInWater ? physics.waterGravity : physics.lavaGravity) * gravityMultiplier
        vel.x *= horizontalInertia
        vel.z *= horizontalInertia
      }

      if (entity.isCollidedHorizontally && doesNotCollide(world, pos.offset(vel.x, vel.y + 0.6 - pos.y + lastY, vel.z))) {
        vel.y = physics.outOfLiquidImpulse // jump out of liquid
      }
    } else if (entity.elytraFlying) {
      const {
        pitch,
        sinPitch,
        cosPitch,
        lookDir
      } = getLookingVector(entity)
      const horizontalSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z)
      const cosPitchSquared = cosPitch * cosPitch
      vel.y += physics.gravity * gravityMultiplier * (-1.0 + cosPitchSquared * 0.75)
      // cosPitch is in [0, 1], so cosPitch > 0.0 is just to protect against
      // divide by zero errors
      if (vel.y < 0.0 && cosPitch > 0.0) {
        const movingDownSpeedModifier = vel.y * (-0.1) * cosPitchSquared
        vel.x += lookDir.x * movingDownSpeedModifier / cosPitch
        vel.y += movingDownSpeedModifier
        vel.z += lookDir.z * movingDownSpeedModifier / cosPitch
      }

      if (pitch > 0.0 && cosPitch > 0.0) {
        const lookDownSpeedModifier = horizontalSpeed * sinPitch * 0.04
        vel.x += -lookDir.x * lookDownSpeedModifier / cosPitch
        vel.y += lookDownSpeedModifier * 3.2
        vel.z += -lookDir.z * lookDownSpeedModifier / cosPitch
      }

      if (cosPitch > 0.0) {
        vel.x += (lookDir.x / cosPitch * horizontalSpeed - vel.x) * 0.1
        vel.z += (lookDir.z / cosPitch * horizontalSpeed - vel.z) * 0.1
      }

      vel.x *= 0.99
      vel.y *= 0.98
      vel.z *= 0.99
      moveEntity(entity, world, vel.x, vel.y, vel.z)

      if (entity.onGround) {
        entity.elytraFlying = false
      }
    } else if (modern) {
      // LivingEntity.travelInAir (vanilla 1.21+), with the float placements of the original
      const blockUnder = blockBelowThatAffectsMovement(world, entity)
      let acceleration
      let inertia
      const drag = airDrag(entity, 0.91)
      if (entity.onGround && blockUnder) {
        // Block friction (a float: 0.6F, 0.98F, 0.8F, 0.989F), or the ground's 1.0F on a non-slippery block
        const slip = blockFriction(entity, F(blockSlipperiness[blockUnder.type] || physics.defaultSlipperiness))
        inertia = F(slip * drag)
        const speed = getMovementSpeed(entity)
        // Entity.getFrictionInfluencedSpeed: speed * (0.21600002F / (friction^3)); 26.2 uses the plain speed up to 0.6F
        acceleration = (hasFriction26 && slip <= F(0.6)) ? speed : F(speed * F(F(0.21600002) / F(F(slip * slip) * slip)))
        if (acceleration < 0) acceleration = 0 // acceleration should not be negative
      } else {
        acceleration = entity.control.sprint ? F(0.025999999) : F(0.02) // Player.getFlyingSpeed
        inertia = drag
      }

      moveRelative(entity, strafe, forward, acceleration)

      if (isOnLadder(world, pos)) {
        // LivingEntity.handleOnClimbable: horizontal speed is capped at 0.15F, sinking too; sneaking holds on
        // (except on scaffolding, where sneaking climbs down)
        const max = F(physics.ladderMaxSpeed)
        vel.x = math.clamp(-max, vel.x, max)
        vel.z = math.clamp(-max, vel.z, max)
        vel.y = Math.max(vel.y, -max)
        const atFeet = world.getBlock(pos)
        if (vel.y < 0 && entity.control.sneak && !(atFeet && atFeet.type === scaffoldingId)) vel.y = 0
      }

      moveEntity(entity, world, vel.x, vel.y, vel.z)

      if (isOnLadder(world, pos) && (entity.isCollidedHorizontally ||
        (supportFeature('climbUsingJump') && entity.control.jump))) {
        vel.y = physics.ladderClimbSpeed // climb ladder
      }

      // Apply gravity, then friction (the vertical drag is 0.98F)
      if (entity.levitation > 0) {
        vel.y += (0.05 * entity.levitation - vel.y) * 0.2
      } else {
        vel.y -= gravity
      }
      vel.y *= airDrag(entity, 0.98)
      vel.x *= inertia
      vel.z *= inertia
    } else {
      // Normal movement
      let acceleration = 0.0
      let inertia = 0.0
      const blockUnder = hasSupportingBlock ? blockBelowThatAffectsMovement(world, entity) : world.getBlock(pos.offset(0, -1, 0))
      if (entity.onGround && blockUnder) {
        let playerSpeedAttribute
        if (entity.attributes && entity.attributes[physics.movementSpeedAttribute]) {
          // Use server-side player attributes
          playerSpeedAttribute = entity.attributes[physics.movementSpeedAttribute]
        } else {
          // Create an attribute if the player does not have it
          playerSpeedAttribute = attribute.createAttributeValue(physics.playerSpeed)
        }
        // Client-side sprinting (don't rely on server-side sprinting)
        // setSprinting in LivingEntity.java
        playerSpeedAttribute = attribute.deleteAttributeModifier(playerSpeedAttribute, physics.sprintingUUID) // always delete sprinting (if it exists)
        if (entity.control.sprint) {
          if (!attribute.checkAttributeModifier(playerSpeedAttribute, physics.sprintingUUID)) {
            playerSpeedAttribute = attribute.addAttributeModifier(playerSpeedAttribute, {
              uuid: physics.sprintingUUID,
              amount: physics.sprintSpeed,
              operation: 2
            })
          }
        }
        // Calculate what the speed is (0.1 if no modification)
        const attributeSpeed = attribute.getAttributeValue(playerSpeedAttribute)
        inertia = (blockSlipperiness[blockUnder.type] || physics.defaultSlipperiness) * 0.91
        acceleration = attributeSpeed * (0.1627714 / (inertia * inertia * inertia))
        if (acceleration < 0) acceleration = 0 // acceleration should not be negative
      } else {
        acceleration = physics.airborneAcceleration
        inertia = physics.airborneInertia

        if (entity.control.sprint) {
          const airSprintFactor = physics.airborneAcceleration * 0.3
          acceleration += airSprintFactor
        }
      }

      applyHeading(entity, strafe, forward, acceleration)

      if (isOnLadder(world, pos)) {
        vel.x = math.clamp(-physics.ladderMaxSpeed, vel.x, physics.ladderMaxSpeed)
        vel.z = math.clamp(-physics.ladderMaxSpeed, vel.z, physics.ladderMaxSpeed)
        vel.y = Math.max(vel.y, entity.control.sneak ? 0 : -physics.ladderMaxSpeed)
      }

      moveEntity(entity, world, vel.x, vel.y, vel.z)

      if (isOnLadder(world, pos) && (entity.isCollidedHorizontally ||
        (supportFeature('climbUsingJump') && entity.control.jump))) {
        vel.y = physics.ladderClimbSpeed // climb ladder
      }

      // Apply friction and gravity
      if (entity.levitation > 0) {
        vel.y += (0.05 * entity.levitation - vel.y) * 0.2
      } else {
        vel.y -= physics.gravity * gravityMultiplier
      }
      vel.y *= physics.airdrag
      vel.x *= inertia
      vel.z *= inertia
    }
  }

  function isMaterialInBB (world, queryBB, types) {
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(queryBB.minY); cursor.y <= Math.floor(queryBB.maxY); cursor.y++) {
      for (cursor.z = Math.floor(queryBB.minZ); cursor.z <= Math.floor(queryBB.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(queryBB.minX); cursor.x <= Math.floor(queryBB.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          if (block && types.includes(block.type)) return true
        }
      }
    }
    return false
  }

  function getLiquidHeightPcent (block) {
    return (getRenderedDepth(block) + 1) / 9
  }

  function getRenderedDepth (block) {
    if (!block) return -1
    if (waterLike.has(block.type)) return 0
    if (block.isWaterlogged) return 0
    if (!waterIds.includes(block.type)) return -1
    const meta = block.metadata
    return meta >= 8 ? 0 : meta
  }

  function getFlow (world, block) {
    const curlevel = getRenderedDepth(block)
    const flow = new Vec3(0, 0, 0)
    for (const [dx, dz] of [[0, 1], [-1, 0], [0, -1], [1, 0]]) {
      const adjBlock = world.getBlock(block.position.offset(dx, 0, dz))
      const adjLevel = getRenderedDepth(adjBlock)
      if (adjLevel < 0) {
        if (adjBlock && adjBlock.boundingBox !== 'empty') {
          const adjLevel = getRenderedDepth(world.getBlock(block.position.offset(dx, -1, dz)))
          if (adjLevel >= 0) {
            const f = adjLevel - (curlevel - 8)
            flow.x += dx * f
            flow.z += dz * f
          }
        }
      } else {
        const f = adjLevel - curlevel
        flow.x += dx * f
        flow.z += dz * f
      }
    }

    // falling water (1.13+: only the water block itself, whose level is its metadata; a waterlogged stair is not falling)
    if (block.metadata >= 8 && (!modern || waterIds.includes(block.type))) {
      for (const [dx, dz] of [[0, 1], [-1, 0], [0, -1], [1, 0]]) {
        const adjBlock = world.getBlock(block.position.offset(dx, 0, dz))
        const adjUpBlock = world.getBlock(block.position.offset(dx, 1, dz))
        if ((adjBlock && adjBlock.boundingBox !== 'empty') || (adjUpBlock && adjUpBlock.boundingBox !== 'empty')) {
          flow.normalize().translate(0, -6, 0)
          if (modern) break // FluidTypeFlowing.getFlow stops at the first solid face (the original repeated it per face)
        }
      }
    }

    return flow.normalize()
  }

  function getWaterInBB (world, bb) {
    const waterBlocks = []
    const cursor = new Vec3(0, 0, 0)
    for (cursor.y = Math.floor(bb.minY); cursor.y <= Math.floor(bb.maxY); cursor.y++) {
      for (cursor.z = Math.floor(bb.minZ); cursor.z <= Math.floor(bb.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(bb.minX); cursor.x <= Math.floor(bb.maxX); cursor.x++) {
          const block = world.getBlock(cursor)
          if (block && (waterIds.includes(block.type) || waterLike.has(block.type) || block.isWaterlogged)) {
            const waterLevel = cursor.y + 1 - getLiquidHeightPcent(block)
            if (Math.ceil(bb.maxY) >= waterLevel) waterBlocks.push(block)
          }
        }
      }
    }
    return waterBlocks
  }

  function isInWaterApplyCurrent (world, bb, vel) {
    const acceleration = new Vec3(0, 0, 0)
    const waterBlocks = getWaterInBB(world, bb)
    const isInWater = waterBlocks.length > 0
    for (const block of waterBlocks) {
      const flow = getFlow(world, block)
      acceleration.add(flow)
    }

    const len = acceleration.norm()
    if (len > 0) {
      vel.x += acceleration.x / len * 0.014
      vel.y += acceleration.y / len * 0.014
      vel.z += acceleration.z / len * 0.014
    }
    return isInWater
  }

  // The height of the water in a cell (CompensatedWorld.getWaterFluidLevelAt): 1 with water above, 8/9 for a source
  // or falling water, (8 - level) / 9 flowing, 8/9 for waterlogged blocks and plants that hold water
  function waterHeightAt (world, x, y, z) {
    const block = world.getBlock(new Vec3(x, y, z))
    const isWater = (b) => !!b && (waterIds.includes(b.type) || waterLike.has(b.type) || !!b.isWaterlogged)
    if (!isWater(block)) return 0
    if (isWater(world.getBlock(new Vec3(x, y + 1, z)))) return 1
    if (waterIds.includes(block.type)) return (block.metadata & 8) ? 8 / 9 : (8 - block.metadata) / 9
    return 8 / 9
  }

  // PlayerBaseTick.updateFluidHeightAndDoFluidPushing (1.13+): the box shrunk by 0.001 on every side touches water,
  // each touched cell pushes along its flow (scaled down in shallow water), the pushes are averaged and scaled by
  // 0.014; a bot at rest still gets pushed at least 0.0045. Returns whether the bot touches water.
  function updateWaterState (entity, world) {
    const bb = getPlayerBB(entity.pos).contract(0.001, 0.001, 0.001)
    let touched = false
    let depth = 0
    let count = 0
    const push = new Vec3(0, 0, 0)
    for (let y = Math.floor(bb.minY); y < Math.ceil(bb.maxY); y++) {
      for (let z = Math.floor(bb.minZ); z < Math.ceil(bb.maxZ); z++) {
        for (let x = Math.floor(bb.minX); x < Math.ceil(bb.maxX); x++) {
          const h = waterHeightAt(world, x, y, z)
          if (h === 0 || y + h < bb.minY) continue
          touched = true
          depth = Math.max(y + h - bb.minY, depth)
          const block = world.getBlock(new Vec3(x, y, z))
          let flow = getFlow(world, block)
          if (depth < 0.4) flow = flow.scaled(depth)
          push.add(flow)
          count++
        }
      }
    }
    if (push.x !== 0 || push.y !== 0 || push.z !== 0) {
      push.scale(1 / count)
      push.scale(0.014)
      if (Math.abs(entity.vel.x) < 0.003 && Math.abs(entity.vel.z) < 0.003 && push.norm() < 0.0045000000000000005) {
        const n = push.norm()
        if (n > 0) push.scale(0.0045000000000000005 / n)
      }
      entity.vel.add(push)
    }
    entity.waterHeight = touched ? depth : 0
    return touched
  }

  physics.simulatePlayer = (entity, world) => {
    const vel = entity.vel
    const pos = entity.pos

    if (modern) {
      entity.isInWater = updateWaterState(entity, world)
      if (entity.isInWater) entity.fallDistance = 0
    } else {
      const waterBB = getPlayerBB(pos).contract(0.001, 0.401, 0.001)
      entity.isInWater = isInWaterApplyCurrent(world, waterBB, vel)
    }
    const lavaBB = getPlayerBB(pos).contract(0.1, 0.4, 0.1)
    entity.isInLava = isMaterialInBB(world, lavaBB, lavaIds)

    // Reset velocity component if it falls under the threshold (LivingEntity.aiStep)
    if (physics.modernMinMovement) { // 1.21.5+: a player's horizontal speed is zeroed by its length, not per axis
      if (vel.x * vel.x + vel.z * vel.z < 9.0E-6) { vel.x = 0; vel.z = 0 }
    } else {
      if (Math.abs(vel.x) < physics.negligeableVelocity) vel.x = 0
      if (Math.abs(vel.z) < physics.negligeableVelocity) vel.z = 0
    }
    if (Math.abs(vel.y) < physics.negligeableVelocity) vel.y = 0

    // Handle inputs
    if (entity.control.jump || entity.jumpQueued) {
      if (entity.jumpTicks > 0) entity.jumpTicks--
      if (modern) {
        // LivingEntity.aiStep: in water deeper than 0.4 (or in the air above it) a jump swims up; in shallow water
        // on the ground, or hopping out of shallow water, it is a normal jump
        const waterDepth = entity.isInWater ? (entity.waterHeight ?? 1) : 0
        const inWater = entity.isInWater && waterDepth > 0
        const depth = entity.isInLava && !inWater ? 1 : waterDepth
        const swim = (inWater || entity.isInLava) && (!entity.onGround || depth > 0.4)
        if (swim) {
          vel.y += 0.04 // jumpInLiquid
        } else if ((entity.onGround || (inWater && depth <= 0.4)) && entity.jumpTicks === 0) {
          // Entity.getBlockJumpFactor() (honey 0.5F); jump power = (float) jump_strength * factor + 0.1F * (jump boost
          // level), nothing happens at or below 1e-5
          let jumpPower = F(F(attrValue(entity, 'jumpStrength', F(0.42), 0, 32)) * blockJumpFactor(world, entity))
          if (entity.jumpBoost > 0) jumpPower = F(jumpPower + F(F(0.1) * entity.jumpBoost))
          if (jumpPower > F(1.0E-5)) {
            vel.y = physics.modernJump ? Math.max(jumpPower, vel.y) : jumpPower // 1.21.2+: max(jumpPower, vy)
            if (entity.control.sprint) {
              // sprint-jump boost: 0.2 along the (float) yaw, by the table's sin / cos
              const rad = yawRadians(entity.yaw)
              vel.x += -sin(rad) * 0.2
              vel.z += cos(rad) * 0.2
            }
          }
          entity.jumpTicks = physics.autojumpCooldown
        }
      } else if (entity.isInWater || entity.isInLava) {
        vel.y += 0.04
      } else if (entity.onGround && entity.jumpTicks === 0) {
        const blockBelow = world.getBlock(entity.pos.floored().offset(0, -0.5, 0))
        vel.y = Math.fround(0.42) * ((blockBelow && blockBelow.type === honeyblockId) ? physics.honeyblockJumpSpeed : 1)
        if (entity.jumpBoost > 0) {
          vel.y += 0.1 * entity.jumpBoost
        }
        if (entity.control.sprint) {
          const yaw = Math.PI - entity.yaw
          vel.x -= Math.sin(yaw) * 0.2
          vel.z += Math.cos(yaw) * 0.2
        }
        entity.jumpTicks = physics.autojumpCooldown
      }
    } else {
      entity.jumpTicks = 0 // reset autojump cooldown
    }
    entity.jumpQueued = false

    let strafe
    let forward
    if (modern) {
      // KeyboardInput impulses (+-1) -> sneaking speed (sneaking_speed attribute, 0.3F; follows the crouch pose, which
      // a driver reports one tick behind the key in entity.slowMovement) -> item use (0.2F, or the item's
      // use_effects speed_multiplier) -> LivingEntity.aiStep's 0.98F, every product rounded to a float
      strafe = F(entity.control.right - entity.control.left)
      forward = F(entity.control.forward - entity.control.back)
      if (entity.slowMovement ?? entity.control.sneak) {
        const sneaking = F(attrValue(entity, 'sneakingSpeed', F(physics.sneakSpeed), 0, 1))
        strafe = F(strafe * sneaking)
        forward = F(forward * sneaking)
      }
      if (entity.usingItem) {
        const item = F(entity.useSpeedMultiplier ?? 0.2)
        strafe = F(strafe * item)
        forward = F(forward * item)
      }
      strafe = F(strafe * F(0.98))
      forward = F(forward * F(0.98))
      entity.xxa = -strafe // vanilla's xxa (+left) and zza, read by isHorizontalCollisionMinor
      entity.zza = forward
    } else {
      strafe = (entity.control.right - entity.control.left) * 0.98
      forward = (entity.control.forward - entity.control.back) * 0.98

      if (entity.control.sneak) {
        strafe *= physics.sneakSpeed
        forward *= physics.sneakSpeed
      }
    }

    entity.elytraFlying = entity.elytraFlying && entity.elytraEquipped && !entity.onGround && !entity.levitation

    if (entity.fireworkRocketDuration > 0) {
      if (!entity.elytraFlying) {
        entity.fireworkRocketDuration = 0
      } else {
        const { lookDir } = getLookingVector(entity)
        vel.x += lookDir.x * 0.1 + (lookDir.x * 1.5 - vel.x) * 0.5
        vel.y += lookDir.y * 0.1 + (lookDir.y * 1.5 - vel.y) * 0.5
        vel.z += lookDir.z * 0.1 + (lookDir.z * 1.5 - vel.z) * 0.5
        --entity.fireworkRocketDuration
      }
    }

    moveEntityWithHeading(entity, world, strafe, forward)

    return entity
  }

  return physics
}

function getEffectLevel (mcData, effectName, effects) {
  const effectDescriptor = mcData.effectsByName[effectName]
  if (!effectDescriptor) {
    return 0
  }
  const effectInfo = effects[effectDescriptor.id]
  if (!effectInfo) {
    return 0
  }
  return effectInfo.amplifier + 1
}

function getEnchantmentLevel (mcData, enchantmentName, enchantments) {
  const enchantmentDescriptor = mcData.enchantmentsByName[enchantmentName]
  if (!enchantmentDescriptor) {
    return 0
  }

  for (const enchInfo of enchantments) {
    if (typeof enchInfo.id === 'string') {
      if (enchInfo.id.includes(enchantmentName)) {
        return enchInfo.lvl
      }
    } else if (enchInfo.id === enchantmentDescriptor.id) {
      return enchInfo.lvl
    }
  }
  return 0
}

// The multiplier the item in use puts on the walking input: 0.2F, or (1.21.11+) the speed_multiplier of the item's
// use_effects component. The hand is bot.itemInUse.hand when the driver reports it, else the held item that has one.
function getUseSpeedMultiplier (bot, mcData) {
  if (!mcData.isNewerOrEqualTo?.('1.21.11')) return 0.2
  const hand = bot.itemInUse && typeof bot.itemInUse === 'object' ? bot.itemInUse.hand : bot.itemInUseHand
  const held = bot.heldItem
  const offhand = bot.inventory?.slots?.[45]
  const items = hand === 1 ? [offhand] : hand === 0 ? [held] : [held, offhand]
  for (const item of items) {
    const multiplier = item?.componentMap?.get('use_effects')?.data?.speed_multiplier
    if (typeof multiplier === 'number') return multiplier
  }
  return 0.2
}

class PlayerState {
  constructor (bot, control) {
    const mcData = require('minecraft-data')(bot.version)
    const nbt = require('prismarine-nbt')

    // Input / Outputs
    this.pos = bot.entity.position.clone()
    this.vel = bot.entity.velocity.clone()
    this.onGround = bot.entity.onGround
    this.isInWater = bot.entity.isInWater
    this.isInLava = bot.entity.isInLava
    this.isInWeb = bot.entity.isInWeb
    this.isCollidedHorizontally = bot.entity.isCollidedHorizontally
    this.isCollidedVertically = bot.entity.isCollidedVertically
    this.minorHorizontalCollision = !!bot.entity.minorHorizontalCollision
    this.fallDistance = bot.entity.fallDistance || 0
    this.elytraFlying = bot.entity.elytraFlying
    this.jumpTicks = bot.jumpTicks
    this.jumpQueued = bot.jumpQueued
    this.fireworkRocketDuration = bot.fireworkRocketDuration
    // Entity.mainSupportingBlockPos / onGroundNoBlocks (1.20+): kept on the entity between ticks
    this.supportingBlock = bot.entity.supportingBlock ?? null
    this.supportNoBlocks = !!bot.entity.supportNoBlocks

    // Input only (not modified)
    this.attributes = bot.entity.attributes
    this.yaw = bot.entity.yaw
    this.pitch = bot.entity.pitch
    this.control = control
    // The sneaking speed follows the crouch pose, which lags the shift key by a tick (the driver exposes bot.crouching,
    // and may set state.slowMovement itself). Undefined: use the key of this tick.
    this.slowMovement = typeof bot.crouching === 'boolean' ? bot.crouching : undefined
    // Using an item (eating, drinking, blocking...) slows the walking input to 20 %
    this.usingItem = !!bot.itemInUse
    this.useSpeedMultiplier = this.usingItem ? getUseSpeedMultiplier(bot, mcData) : 0.2

    // effects
    const effects = bot.entity.effects

    this.jumpBoost = getEffectLevel(mcData, 'JumpBoost', effects)
    this.speed = getEffectLevel(mcData, 'Speed', effects)
    this.slowness = getEffectLevel(mcData, 'Slowness', effects)

    this.dolphinsGrace = getEffectLevel(mcData, 'DolphinsGrace', effects)
    this.slowFalling = getEffectLevel(mcData, 'SlowFalling', effects)
    this.levitation = getEffectLevel(mcData, 'Levitation', effects)

    // armour enchantments (before 1.20.5; later versions send depth strider as the water_movement_efficiency attribute)
    const boots = bot.inventory.slots[8]
    if (boots && boots.nbt) {
      const simplifiedNbt = nbt.simplify(boots.nbt)
      const enchantments = simplifiedNbt.Enchantments ?? simplifiedNbt.ench ?? []
      this.depthStrider = getEnchantmentLevel(mcData, 'depth_strider', enchantments)
    } else {
      this.depthStrider = 0
    }

    // extra elytra requirements
    const item = bot.inventory.slots[6]
    this.elytraEquipped = item != null && item.name === 'elytra'
  }

  apply (bot) {
    bot.entity.position = this.pos
    bot.entity.velocity = this.vel
    bot.entity.onGround = this.onGround
    bot.entity.isInWater = this.isInWater
    bot.entity.isInLava = this.isInLava
    bot.entity.isInWeb = this.isInWeb
    bot.entity.isCollidedHorizontally = this.isCollidedHorizontally
    bot.entity.isCollidedVertically = this.isCollidedVertically
    bot.entity.minorHorizontalCollision = this.minorHorizontalCollision
    bot.entity.fallDistance = this.fallDistance
    bot.entity.elytraFlying = this.elytraFlying
    bot.jumpTicks = this.jumpTicks
    bot.jumpQueued = this.jumpQueued
    bot.fireworkRocketDuration = this.fireworkRocketDuration
    bot.entity.supportingBlock = this.supportingBlock
    bot.entity.supportNoBlocks = this.supportNoBlocks
  }
}

module.exports = { Physics, PlayerState }
