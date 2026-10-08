/**
 * Loads the installed mineflayer-pathfinder with fullStop() replaced by `bot.clearControlStates()`, so the bot
 * coasts to a stop instead of snapping onto the block centre. Throws if the pathfinder has no fullStop() as expected.
 * @param fromRequire a require function, or a file/directory/file: URL to resolve mineflayer-pathfinder from
 *   (default: the main script, else the working directory)
 */
export function loadPathfinder (fromRequire?: NodeRequire | string): any
