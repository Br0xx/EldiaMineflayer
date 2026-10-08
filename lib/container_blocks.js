// Which blocks open a container window the bot can read, and which window types those are.
// Window types are menu names (prismarine-windows keys): chests, barrels, ender chests, copper chests,
// dispensers and droppers are minecraft:generic_9xN / generic_3x3, hoppers and shulker boxes have their own, the
// crafter (1.20.3+) is minecraft:crafter_3x3.
const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const COPPER = ['copper_chest', 'exposed_copper_chest', 'weathered_copper_chest', 'oxidized_copper_chest']

const SHULKER_BOXES = ['shulker_box', ...COLORS.map(c => c + '_shulker_box')]
// Chests that join into a double chest (block property type: single | left | right)
const CHESTS = ['chest', 'trapped_chest', ...COPPER, ...COPPER.map(n => 'waxed_' + n)]
const CONTAINER_BLOCKS = [...CHESTS, 'ender_chest', 'barrel', 'hopper', 'dispenser', 'dropper', 'crafter', ...SHULKER_BOXES]

const WINDOW_TYPES = ['minecraft:generic', 'minecraft:chest', 'minecraft:dispenser', 'minecraft:ender_chest', 'minecraft:hopper', 'minecraft:container', 'minecraft:dropper', 'minecraft:trapped_chest', 'minecraft:barrel', 'minecraft:crafter', 'minecraft:shulker_box', ...COLORS.map(c => `minecraft:${c}_shulker_box`)]

const isShulkerBox = name => /^(\w+_)?shulker_box$/.test(name)
const matchWindowType = window => WINDOW_TYPES.some(type => String(window.type).startsWith(type))

module.exports = { CONTAINER_BLOCKS, CHESTS, SHULKER_BOXES, WINDOW_TYPES, isShulkerBox, matchWindowType }
