// ServerboundPlayerActionPacket (block_dig) status ids by meaning. 26.3 inserted CHANGE_DESTROY_DIRECTION at 1,
// which moves every id after it up by one (abort digging 2, finish 3, drop stack 4, drop item 5, release use
// item 6, swap hands 7), so a fixed number is wrong on one side of 26.3.
const IDS = {
  start_digging: 0,
  abort_digging: 1,
  finish_digging: 2,
  drop_stack: 3,
  drop_item: 4,
  release_use_item: 5,
  swap_hands: 6
}

module.exports = function playerActionId (registry, action) {
  if (!(action in IDS)) throw new Error(`unknown player action ${action}`)
  return IDS[action] + (registry.version['>=']('26.3') && IDS[action] > 0 ? 1 : 0)
}
