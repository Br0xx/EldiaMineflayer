// The packet ring of a session and the text of a trace. Records are plain objects:
//   { seq, t (ms since the session started), tick, dir: 'out' | 'in', name, info, noise }
const { round } = require('./util')

// Incoming packets that say nothing about a setback: kept in the ring (cheap) but left out of trace windows
const NOISE_IN = new Set([
  'map_chunk', 'chunk_batch_start', 'chunk_batch_finished', 'update_light', 'update_time', 'world_particles', 'sound_effect',
  'named_sound_effect', 'rel_entity_move', 'entity_move_look', 'entity_look', 'entity_head_rotation', 'entity_teleport',
  'sync_entity_position', 'move_minecart', 'entity_metadata', 'entity_update_attributes', 'entity_equipment', 'spawn_entity',
  'entity_destroy', 'entity_status', 'animation', 'entity_velocity', 'update_view_position', 'unload_chunk', 'block_change',
  'multi_block_change', 'tile_entity_data', 'block_action', 'world_event', 'player_info', 'playerlist_header', 'tags',
  'declare_commands', 'recipe_book_add', 'advancements', 'update_view_distance', 'set_ticking_state', 'tick_step',
  'set_cooldown', 'damage_event', 'hurt_animation', 'entity_effect', 'remove_entity_effect', 'collect', 'attach_entity',
  'bundle_delimiter', 'level_chunk_with_light', 'forget_level_chunk', 'chunks_biomes', 'initialize_world_border',
  'world_border_center', 'world_border_size', 'world_border_lerp_size', 'world_border_warning_delay',
  'world_border_warning_reach', 'ticking_state', 'ticking_step', 'sound_effect_entity', 'stop_sound', 'rain', 'weather'
])

const f = (n) => round(n, 3)
const flagsText = (p) => {
  const fl = p.flags
  if (fl && typeof fl === 'object') return `g=${fl.onGround ? 1 : 0} w=${fl.hasHorizontalCollision ? 1 : 0}`
  return p.onGround !== undefined ? `g=${p.onGround ? 1 : 0}` : ''
}

// A one-line summary of the packets that matter; the others show their name only
function brief (dir, name, p, shift = (x, y, z) => [x, y, z]) {
  if (!p || typeof p !== 'object') return ''
  const at = (x, y, z) => shift(x, y, z).map(f).join(' ')
  try {
    switch (name) {
      case 'position':
      case 'position_look':
      case 'look':
      case 'flying':
        if (dir === 'in' && name === 'position') {
          const rel = p.flags && typeof p.flags === 'object' ? Object.keys(p.flags).filter(k => p.flags[k]).join('+') : p.flags
          return `xyz ${rel && /x|y|z/.test(String(rel)) ? [p.x, p.y, p.z].map(f).join(' ') : at(p.x, p.y, p.z)} rot ${f(p.yaw)} ${f(p.pitch)} id ${p.teleportId}${rel ? ' rel ' + rel : ''}`
        }
        return [p.x !== undefined ? `xyz ${at(p.x, p.y, p.z)}` : '', p.yaw !== undefined ? `rot ${f(p.yaw)} ${f(p.pitch)}` : '', flagsText(p)].filter(Boolean).join(' ')
      case 'player_rotation':
        return `rot ${f(p.yaw)} ${f(p.pitch)}`
      case 'player_input':
        return Object.keys(p.inputs ?? {}).filter(k => p.inputs[k]).join('+') || 'none'
      case 'entity_action':
        return String(p.actionId)
      case 'block_dig':
        return `status ${p.status} at ${p.location ? at(p.location.x, p.location.y, p.location.z) : '?'} face ${p.face} seq ${p.sequence}`
      case 'block_place':
        return `at ${at(p.location.x, p.location.y, p.location.z)} dir ${p.direction} cursor ${f(p.cursorX)} ${f(p.cursorY)} ${f(p.cursorZ)} seq ${p.sequence}`
      case 'use_item':
        return `seq ${p.sequence}`
      case 'held_item_slot':
        return `slot ${p.slotId}`
      case 'teleport_confirm':
        return `id ${p.teleportId}`
      case 'pong':
        return `id ${p.id}`
      case 'window_click':
        return `win ${p.windowId} slot ${p.slot} btn ${p.mouseButton} mode ${p.mode}`
      case 'update_health':
        return `hp ${f(p.health)} food ${p.food}`
      case 'open_window':
        return `win ${p.windowId} type ${p.inventoryType}`
      case 'close_window':
        return `win ${p.windowId}`
      case 'acknowledge_player_digging':
        return `seq ${p.sequenceId}`
      case 'entity_velocity':
        return `id ${p.entityId} v ${f(p.velocityX / 8000)} ${f(p.velocityY / 8000)} ${f(p.velocityZ / 8000)}`
      case 'kick_disconnect':
      case 'disconnect':
        return String(JSON.stringify(p.reason ?? p).slice(0, 120))
      case 'respawn':
        return `dim ${p.dimension ?? p.worldState?.dimension ?? ''}`
      default:
        return ''
    }
  } catch {
    return ''
  }
}

function formatRecord (r, t0 = 0) {
  const t = ((r.t - t0) / 1000).toFixed(3).padStart(8)
  const mark = r.marker ? '!!' : r.dir === 'out' ? '>>' : '<<'
  return `tick ${String(r.tick).padStart(5)} ${t}s ${mark} ${r.name}${r.info ? '  ' + r.info : ''}`
}

// The trace of an incident: the last `before` outgoing and incoming packets up to seq (noise left out), then what
// followed
function window (ring, seq, { before = 40, afterTicks = 5, afterMax = 40, tick } = {}) {
  const shown = (r) => !r.noise || r.marker
  const upto = ring.filter(r => r.seq <= seq && shown(r))
  const out = upto.filter(r => r.dir === 'out').slice(-before)
  const inc = upto.filter(r => r.dir === 'in').slice(-before)
  const marks = upto.filter(r => r.marker).slice(-10)
  const first = Math.min(out[0]?.seq ?? Infinity, inc[0]?.seq ?? Infinity)
  const head = [...new Set([...out, ...inc, ...marks.filter(m => m.seq >= first)])].sort((a, b) => a.seq - b.seq)
  const tail = ring.filter(r => r.seq > seq && shown(r) && r.tick <= tick + afterTicks).slice(0, afterMax)
  return { head, tail }
}

module.exports = { NOISE_IN, brief, formatRecord, window }
