const nbt = require('prismarine-nbt')
const { sleep } = require('../promise_utils')
const { CONTAINER_BLOCKS, CHESTS, isShulkerBox, matchWindowType } = require('../container_blocks')

module.exports = inject

// What is inside containers, for stash tools:
//   bot.containerItems(item)            the items a shulker box item holds, with their slot numbers
//   bot.vanilla.shulkerContents(item)   the same
//   bot.vanilla.scanContainers(radius)  open every container around the bot one by one and list what each holds
//
// A shulker box item carries its contents as the `container` data component (1.20.5+: a list indexed by slot,
// a gap is an empty slot) or as BlockEntityTag.Items in its NBT (before). The two component layouts differ:
// 1.20.5 - 1.21.x lists slots, 26.1+ lists optional ItemStackTemplates.
function inject (bot) {
  const Item = require('prismarine-item')(bot.registry)

  // { slot, name, count, components? } for one item; `components` are the data components it carries (1.20.5+)
  function describe (item, slot) {
    const out = { slot, name: item.name, count: item.count }
    const components = (item.components ?? []).filter(c => c.type !== 'container')
    if (components.length) out.components = components
    return out
  }

  function fromComponent (data) {
    const items = []
    ;(data?.contents ?? []).forEach((entry, slot) => {
      const item = entry ? Item.fromNotch(entry) : null // empty slots are null (26.1+) or have a count of 0
      if (item) items.push(describe(item, slot))
    })
    return items
  }

  function fromNbt (item) {
    let entries
    try { entries = nbt.simplify(item.nbt)?.BlockEntityTag?.Items } catch { /* malformed */ }
    const items = []
    for (const entry of Array.isArray(entries) ? entries : []) {
      const id = entry.id
      const info = typeof id === 'string' ? bot.registry.itemsByName[id.replace(/^minecraft:/, '')] : bot.registry.items[id]
      if (!info) continue
      const count = entry.Count ?? entry.count ?? 1
      items.push(describe(new Item(info.id, count, entry.Damage, entry.tag ? nbt.comp(entry.tag) : null), entry.Slot ?? items.length))
    }
    return items
  }

  function containerItems (item) {
    if (!item) return []
    const component = item.componentMap?.get('container') ?? (item.components ?? []).find(c => c.type === 'container')
    if (component) return fromComponent(component.data)
    return item.nbt ? fromNbt(item) : []
  }

  // An index entry for one stack in a container window; shulker boxes get what is inside them
  function indexItem (item) {
    const out = describe(item, item.slot)
    if (isShulkerBox(item.name)) out.shulkerItems = containerItems(item)
    return out
  }

  // The blocks within radius that open a container. A double chest is one entry: its half nearer to `from`.
  function findContainerBlocks (center, radius, from, skip) {
    const ids = CONTAINER_BLOCKS.map(name => bot.registry.blocksByName[name]?.id).filter(id => id !== undefined)
    const positions = bot.findBlocks({ point: center, matching: ids, maxDistance: radius, count: 1024 })
    const seen = new Set()
    const key = p => `${p.x},${p.y},${p.z}`
    const blocks = []
    for (const position of positions) {
      if (seen.has(key(position))) continue
      const block = bot.blockAt(position)
      if (!block || !CONTAINER_BLOCKS.includes(block.name)) continue
      seen.add(key(position))
      let chosen = block
      let other = null
      const type = CHESTS.includes(block.name) ? block.getProperties?.().type : null
      if (type === 'left' || type === 'right') {
        const facing = block.getProperties().facing
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const next = bot.blockAt(position.offset(dx, 0, dz))
          const props = next?.name === block.name ? next.getProperties() : null
          if (props && props.facing === facing && props.type !== 'single' && props.type !== type) other = next
        }
        if (other) {
          seen.add(key(other.position))
          if (other.position.distanceTo(from) < block.position.distanceTo(from)) [chosen, other] = [other, chosen]
        }
      }
      if (skip(chosen) || (other && skip(other))) continue
      blocks.push({ block: chosen, double: other?.position.clone() })
    }
    return blocks
  }

  function asSkip (skip) {
    if (typeof skip === 'function') return skip
    const keys = new Set((skip ?? []).map(p => `${p.x},${p.y},${p.z}`))
    return block => keys.has(`${block.position.x},${block.position.y},${block.position.z}`)
  }

  // Open every container within `radius` blocks of `center` (default: the bot), nearest first, one at a time through
  // bot.vanilla.openContainer (which keeps its spacing between opens), and close each before the next.
  // options:
  //   center    Vec3 to search around (default: where the bot stands)
  //   skip      Vec3[] of container positions, or (block) => boolean, to leave alone (e.g. a delivery chest)
  //   approach  async (block) => {} called before each open to walk into reach; without it, a container the bot
  //             cannot click from where it stands is reported with error 'too-far' or 'no-sight'
  //   settleMs  wait after the window opens before reading it (default 250)
  //   open      options passed to openContainer (reach, containerSpacingMs, openTimeoutMs...)
  //   onVisit   (entry) => {} after each container, so a caller can save progress
  // Returns [{ position, blockName, items: [{ slot, name, count, components?, shulkerItems? }], double?, error? }];
  // `double` is the other half's position of a double chest, `error` why a container could not be read.
  async function scanContainers (radius = 8, options = {}) {
    const center = options.center ?? bot.entity.position
    const settleMs = options.settleMs ?? 250
    const todo = findContainerBlocks(center, radius, bot.entity.position, asSkip(options.skip))
    const index = []
    while (todo.length) {
      const at = bot.entity.position
      todo.sort((a, b) => a.block.position.distanceTo(at) - b.block.position.distanceTo(at))
      const { block, double } = todo.shift()
      const entry = { position: block.position.clone(), blockName: block.name, items: [] }
      if (double) entry.double = double
      try {
        if (options.approach) await options.approach(block)
        const window = await bot.vanilla.openContainer(block, options.open)
        try {
          await sleep(settleMs)
          if (!matchWindowType(window)) throw new Error(`unexpected window ${window.type}`)
          entry.items = window.containerItems().map(indexItem)
        } finally {
          await bot.vanilla.closeAnyWindow()
        }
      } catch (err) {
        entry.error = err.code ?? err.message
        entry.message = err.message
      }
      index.push(entry)
      if (options.onVisit) await options.onVisit(entry)
    }
    return index
  }

  bot.containerItems = containerItems
  bot.vanilla = bot.vanilla ?? {}
  Object.assign(bot.vanilla, { shulkerContents: containerItems, scanContainers })
}
