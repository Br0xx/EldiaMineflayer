const { login, idle, look } = require('./basic')
const { walk, sprint, jump, sprintjump, sneak, stairs, step, water } = require('./movement')
const { container, inventory, dig, place } = require('./interact')
const { pathfinder, reconnect, soak } = require('./lifecycle')

// In the order they run by default. soak only runs when asked for.
const DEFAULT_ORDER = ['login', 'idle', 'look', 'walk', 'sprint', 'jump', 'sprintjump', 'sneak', 'stairs', 'step', 'water', 'container', 'inventory', 'dig', 'place', 'pathfinder', 'reconnect']

const scenarios = [login, idle, look, walk, sprint, jump, sprintjump, sneak, stairs, step, water, container, inventory, dig, place, pathfinder, reconnect, soak]

module.exports = { scenarios, DEFAULT_ORDER }
