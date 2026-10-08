// entity_action ids by meaning. The protocol data decides the encoding: an id mapper (names) since
// 1.21.x, a plain varint before. Mojang renumbered the actions in 1.21.6 (sneaking moved to
// player_input) and renamed some in 26.2, so a fixed number or name is wrong on some version:
// sprint sent as 3 is start_riding_jump on 1.21.6+.

// Pre-1.21.6 numbering, used when the packet has no mapper.
const LEGACY_IDS = {
  start_sneaking: 0,
  stop_sneaking: 1,
  leave_bed: 2,
  start_sprinting: 3,
  stop_sprinting: 4,
  start_riding_jump: 5,
  stop_riding_jump: 6,
  open_inventory: 7,
  start_elytra_flying: 8
}

// Names the same action has had across versions.
const ALIASES = {
  leave_bed: ['leave_bed', 'stop_sleeping'],
  start_elytra_flying: ['start_elytra_flying', 'start_fall_flying'],
  start_riding_jump: ['start_riding_jump', 'start_horse_jump'],
  stop_riding_jump: ['stop_riding_jump', 'stop_horse_jump'],
  open_inventory: ['open_inventory', 'open_vehicle_inventory']
}

function actionMappings (registry) {
  const packet = registry.protocol?.play?.toServer?.types?.packet_entity_action
  const fields = Array.isArray(packet) && packet[0] === 'container' ? packet[1] : []
  const type = fields.find(f => f.name === 'actionId')?.type
  if (Array.isArray(type) && type[0] === 'mapper') return Object.values(type[1].mappings)
  return null
}

module.exports = function entityActionId (registry, action) {
  if (!registry.__entityActionNames) {
    Object.defineProperty(registry, '__entityActionNames', { value: actionMappings(registry) ?? false })
  }
  const names = registry.__entityActionNames
  if (!names) {
    if (!(action in LEGACY_IDS)) throw new Error(`entity_action ${action} does not exist in ${registry.version.minecraftVersion}`)
    return LEGACY_IDS[action]
  }
  const name = (ALIASES[action] ?? [action]).find(n => names.includes(n))
  if (name === undefined) throw new Error(`entity_action ${action} does not exist in ${registry.version.minecraftVersion}`)
  return name
}
