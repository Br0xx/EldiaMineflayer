const { Vec3 } = require('vec3')

module.exports = loader

function loader (registry) {
  class Particle {
    constructor (id, position, offset, count = 1, movementSpeed = 0, longDistanceRender = false) {
      this.id = id
      Object.assign(this, registry.particles[id] || registry.particlesByName[id])
      this.position = position
      this.offset = offset
      this.count = count
      this.movementSpeed = movementSpeed
      this.longDistanceRender = longDistanceRender
    }

    static fromNetwork (packet) {
      if (registry.supportFeature('updatedParticlesPacket')) {
        // TODO: We add extra data that's inside packet.particle.data that varies by the particle's .type
        // 26.3 replaced the single velocityOffset with a speed per axis (xMaxSpeed...) and a randomization type
        const perAxis = packet.xMaxSpeed !== undefined
        const particle = new Particle(
          packet.particle.type,
          new Vec3(packet.x, packet.y, packet.z),
          new Vec3(packet.offsetX, packet.offsetY, packet.offsetZ),
          packet.amount,
          packet.velocityOffset ?? (perAxis ? Math.max(packet.xMaxSpeed, packet.yMaxSpeed, packet.zMaxSpeed) : undefined),
          packet.longDistance
        )
        if (perAxis) {
          particle.maxSpeed = new Vec3(packet.xMaxSpeed, packet.yMaxSpeed, packet.zMaxSpeed)
          particle.randomizationType = packet.randomizationType
        }
        return particle
      } else {
        return new Particle(
          packet.particleId,
          new Vec3(packet.x, packet.y, packet.z),
          new Vec3(packet.offsetX, packet.offsetY, packet.offsetZ),
          packet.particles,
          packet.particleData,
          packet.longDistance
        )
      }
    }
  }

  return Particle
}
