const { CONTAINER_BLOCKS, matchWindowType } = require('../container_blocks')

module.exports = inject

function inject (bot) {
  async function openContainer (containerToOpen, direction, cursorPos) {
    // Left undefined unless given: openBlock then clicks the way a vanilla client does
    let chest
    if (containerToOpen.constructor.name === 'Block' && CONTAINER_BLOCKS.includes(containerToOpen.name)) {
      chest = await bot.openBlock(containerToOpen, direction, cursorPos)
    } else if (containerToOpen.constructor.name === 'Entity') {
      chest = await bot.openEntity(containerToOpen)
    } else {
      throw new Error('containerToOpen is neither a block nor an entity')
    }

    if (!matchWindowType(chest)) { throw new Error('Non-container window used as a container: ' + JSON.stringify(chest)) }
    return chest
  }

  bot.openContainer = openContainer
  bot.openChest = openContainer
  bot.openDispenser = openContainer
}
