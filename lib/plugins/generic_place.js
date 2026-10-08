const assert = require('assert')
module.exports = inject

function inject (bot) {
  const { Vec3 } = require('vec3')
  /**
   * Place against a face of a block, the way a vanilla client does: look at a visible point of the face, give the
   * rotation a tick to reach the server and write the click with the face and the point that a ray from the eyes
   * along the rotation of that tick really hits. A face that is not in view, a block that is gone and a block out
   * of reach are refused (Grim: PositionPlace, AirLiquidPlace, FarPlace). forceLook: 'ignore' skips all of it: the
   * caller aims and the packet carries the face and point asked for.
   *
   * @param {import('prismarine-block').Block} referenceBlock
   * @param {import('vec3').Vec3} faceVector
   * @param {{half?: 'top'|'bottom', delta?: import('vec3').Vec3, forceLook?: boolean | 'ignore', offhand?: boolean, swingArm?: 'right' | 'left', showHand?: boolean, _afterPlace?: (rot: {yaw: number, pitch: number}) => void}} options
   */
  async function _genericPlace (referenceBlock, faceVector, options) {
    let handToPlaceWith = 0
    if (options.offhand) {
      if (!bot.inventory.slots[45]) {
        throw new Error('must be holding an item in the off-hand to place')
      }
      handToPlaceWith = 1
    } else if (!bot.heldItem) {
      throw new Error('must be holding an item to place')
    }

    const pos = referenceBlock.position
    const direction = vectorToDirection(faceVector)
    const aimed = options.forceLook !== 'ignore'
    // The point asked for on the face, for a caller that aims on its own
    let dx = 0.5 + faceVector.x * 0.5
    let dy = 0.5 + faceVector.y * 0.5
    let dz = 0.5 + faceVector.z * 0.5
    if (dy === 0.5) {
      if (options.half === 'top') dy += 0.25
      else if (options.half === 'bottom') dy -= 0.25
    }
    if (options.delta) {
      dx = options.delta.x
      dy = options.delta.y
      dz = options.delta.z
    }

    if (aimed) {
      await bot._aim.releaseItem() // hands busy with an item: no click
      const found = bot._aim.facePoint(referenceBlock, faceVector, { half: options.half, delta: options.delta })
      if (!found.ok) throw bot._aim.blockError(found.reason, 'place', referenceBlock.position)
      await bot.lookAt(found.point, options.forceLook)
      await bot._aim.ticks(1) // the rotation is on the server before the click
    }

    // Written in the input phase of a tick, the swing right behind it (use_item_on is followed by the swing)
    await bot._input.enqueue('use', (rot) => {
      // TODO: tell the server that we are sneaking while doing this
      let cursor = new Vec3(dx, dy, dz)
      if (aimed) {
        // the block must still be there and the ray of this tick's rotation must hit it on this face within reach
        if (!bot._aim.isBreakable(bot.blockAt(pos))) throw new Error(`There is no block to place against at ${pos}`)
        const hit = bot._aim.blockHitAt(pos, rot)
        if (!hit || hit.face !== direction) {
          throw bot._aim.blockError(bot._aim.distanceToBlock(pos) > bot._aim.blockReach() ? 'too-far' : 'no-sight', 'place', pos)
        }
        cursor = hit.intersect.minus(pos)
      }
      bot._writeBlockPlace(pos, direction, cursor, handToPlaceWith)

      // The swing must follow use_item_on
      if (options.swingArm) {
        bot._writeSwing(options.swingArm, options.showHand)
      }

      // What the same click goes on with in the same tick (placing an entity: the use_item that follows)
      if (options._afterPlace) options._afterPlace(rot)
    })

    return pos
  }
  bot._genericPlace = _genericPlace
}

function vectorToDirection (v) {
  if (v.y < 0) {
    return 0
  } else if (v.y > 0) {
    return 1
  } else if (v.z < 0) {
    return 2
  } else if (v.z > 0) {
    return 3
  } else if (v.x < 0) {
    return 4
  } else if (v.x > 0) {
    return 5
  }
  assert.ok(false, `invalid direction vector ${v}`)
}
