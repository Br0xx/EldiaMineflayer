import { EventEmitter } from 'events'
import TypedEmitter from 'typed-emitter'
import { Client, ClientOptions } from 'minecraft-protocol'
import { Vec3 } from 'vec3'
import { Item } from 'prismarine-item'
import { Window } from 'prismarine-windows'
import { Recipe } from 'prismarine-recipe'
import { Block } from 'prismarine-block'
import { Entity } from 'prismarine-entity'
import { ChatMessage } from 'prismarine-chat'
import { world } from 'prismarine-world'
import { Registry } from 'prismarine-registry'
import { IndexedData } from 'minecraft-data'

export function createBot (options: { client: Client } & Partial<BotOptions>): Bot
export function createBot (options: BotOptions): Bot

export interface BotOptions extends ClientOptions {
  logErrors?: boolean
  hideErrors?: boolean
  loadInternalPlugins?: boolean
  plugins?: PluginOptions
  chat?: ChatLevel
  colorsEnabled?: boolean
  viewDistance?: ViewDistance
  mainHand?: MainHands
  difficulty?: number
  chatLengthLimit?: number
  physicsEnabled?: boolean
  /** @default 4 */
  maxCatchupTicks?: number
  client?: Client
  brand?: string
  defaultChatPatterns?: boolean
  respawn?: boolean
  /** Settings of the vanilla-client behaviour */
  vanilla?: VanillaOptions
  /**
   * Skip packets protodef cannot decode (9b9t's ViaBackwards sends some) instead of dropping the bot.
   * The count is `protodefSkipped()`.
   * @default true
   */
  skipUndecodablePackets?: boolean
  /**
   * Turn off the socket idle timeout after login (queue lag can exceed it); keep-alives are the health check.
   * @default true
   */
  socketTimeoutAfterLogin?: boolean
  /**
   * Milliseconds without a keep-alive after which the connection is dropped.
   * @default 60000
   */
  checkTimeoutInterval?: number
  /**
   * Ends a connection that has gone silent without erroring (reason 'watchdog'); `false` turns it off.
   * Starts at 'login'. Keep `silenceMs` above `checkTimeoutInterval`.
   * @default { enabled: true, silenceMs: 90000 }
   */
  watchdog?: boolean | WatchdogOptions
}

export interface WatchdogOptions {
  /** @default true */
  enabled?: boolean
  /** Milliseconds without any packet after which the connection is ended @default 90000 */
  silenceMs?: number
  /** The same while the client is in the configuration phase @default 2 * silenceMs */
  configurationSilenceMs?: number
  /** How often to check @default min(5000, silenceMs / 4) */
  checkIntervalMs?: number
}

export interface VanillaOptions {
  /** Overrides for `bot.vanilla.options` */
  interact?: Partial<VanillaInteractOptions>
}

export interface VanillaInteractOptions {
  /** Max distance from the eyes to the clicked point (vanilla allows 4.5) @default 3 */
  reach: number
  /** Ticks to wait after turning before clicking, so the rotation has reached the server @default 2 */
  settleTicks: number
  /** Minimum time between two container opens @default 1500 */
  containerSpacingMs: number
  /** How long to wait for a container window @default 8000 */
  openTimeoutMs: number
  /** Pause between two inventory clicks @default 150 */
  clickGapMs: number
}

export type VanillaClickResult =
  | { ok: true, face: number, cursor: Vec3 }
  | { ok: false, reason: 'too-far' | 'no-sight' }

/** One stack in a container: `slot` is the container slot (the position in a shulker's `container` component) */
export interface ContainerItem {
  slot: number
  name: string
  count: number
  /** Data components the stack carries (1.20.5+), without the `container` one */
  components?: Array<{ type: string, data?: any }>
  /** Shulker boxes: what is inside */
  shulkerItems?: ContainerItem[]
}

/** What `bot.vanilla.scanContainers` found at one container block */
export interface ContainerIndexEntry {
  /** The block that was opened (the nearer half of a double chest) */
  position: Vec3
  blockName: string
  items: ContainerItem[]
  /** Double chest: the position of the other half */
  double?: Vec3
  /** Set when the container could not be read: 'too-far' | 'no-sight' | 'timeout' or the error message */
  error?: string
  message?: string
}

export interface ScanContainersOptions {
  /** Search around this point @default the bot's position */
  center?: Vec3
  /** Containers to leave alone: their positions, or a test */
  skip?: Vec3[] | ((block: Block) => boolean)
  /** Walk into reach of the block before it is opened; without it, containers out of reach are reported with an error */
  approach?: (block: Block) => Promise<void> | void
  /** Wait after the window opens before reading it @default 250 */
  settleMs?: number
  /** Options for `bot.vanilla.openContainer` */
  open?: Partial<VanillaInteractOptions>
  /** Called after each container, e.g. to save progress */
  onVisit?: (entry: ContainerIndexEntry) => Promise<void> | void
}

/** Block and inventory interactions the way a vanilla client makes them (`bot.vanilla`) */
export interface VanillaInteract {
  options: VanillaInteractOptions
  /**
   * Right-click a block: stand still, look at a visible point, wait `settleTicks`, ray-cast and send the
   * face and cursor the ray hits. Resolves with `ok: false` if the block is out of reach or not visible.
   */
  clickBlock: (block: Block, options?: Partial<VanillaInteractOptions>) => Promise<VanillaClickResult>
  /** The error `activateBlock`/`openContainer` throw for a refused click (`code`: 'too-far' or 'no-sight') */
  clickError: (result: { ok: false, reason: 'too-far' | 'no-sight' }) => Error & { code: string }
  /**
   * Open a container block. Keeps `containerSpacingMs` between opens, closes a window that comes late, and
   * rejects (`code: 'timeout'`) listing what the server answered. Concurrent calls queue up.
   */
  openContainer: (block: Block, options?: Partial<VanillaInteractOptions>) => Promise<Window>
  /** Close the open window, if any (do this before walking) */
  closeAnyWindow: () => Promise<void>
  /** Wait until the bot stands on the ground without horizontal speed; resolves false after `maxTicks` @default 20 */
  standStill: (maxTicks?: number) => Promise<boolean>
  /** Look at a point and wait for the rotation to reach the server */
  lookSettled: (point: Vec3, ticks?: number) => Promise<void>
  /** Aim at the entity's hitbox, settle, attack and swing; a result instead of an error */
  attackEntity: (entity: Entity, options?: EntityActionOptions) => Promise<{ ok: true } | { ok: false, reason: 'gone' | 'too-far' | 'no-sight' | 'moved' }>
  /** Aim at the entity's hitbox, settle, right-click it (INTERACT_AT and INTERACT); a result instead of an error */
  interactEntity: (entity: Entity, options?: EntityActionOptions) => Promise<{ ok: true } | { ok: false, reason: 'gone' | 'too-far' | 'no-sight' | 'moved' }>
  /** A point on the block the eyes can see within reach, or null */
  visiblePoint: (block: Block, reach?: number) => Vec3 | null
  /** One inventory click followed by a `clickGapMs` pause */
  windowClick: (slot: number, mouseButton: number, mode: number, options?: Partial<VanillaInteractOptions>) => Promise<void>
  shiftClick: (slot: number, options?: Partial<VanillaInteractOptions>) => Promise<void>
  /** The swap-hands key (block_dig SWAP_ITEM_WITH_OFFHAND: status 6, 7 on 26.3; sequence 0) */
  swapHands: () => Promise<void>
  /** Move a matching hotbar item to the offhand with swap-hands; false if none is in the hotbar */
  offhandFromHotbar: (match: (item: Item) => boolean) => Promise<boolean>
  /** Move a matching main-inventory item to the hotbar with a number-key click; resolves with the hotbar index or -1 */
  toHotbar: (match: (item: Item) => boolean, options?: Partial<VanillaInteractOptions>) => Promise<number>
  /**
   * Keep a totem of undying in the offhand: swap one in from the hotbar, else (`fromInventory`) bring one to the
   * hotbar first (standing still unless health <= 10). Waits up to 20 ticks for the server's slot update and
   * resolves whether the offhand holds a totem. Use it on the pop: `bot.on('totemUsed', () => bot.vanilla.ensureOffhandTotem())`
   */
  ensureOffhandTotem: (options?: { fromInventory?: boolean }) => Promise<boolean>
  /** The items inside a shulker box item, with their slots (same as `bot.containerItems`) */
  shulkerContents: (item: Item) => ContainerItem[]
  /**
   * Open every container within `radius` blocks (chests, trapped and copper chests, barrels, ender chests, shulker
   * boxes, hoppers, dispensers, droppers, crafters; a double chest once), nearest first, one at a time through
   * `openContainer`, and list what each holds, shulker contents included.
   */
  scanContainers: (radius?: number, options?: ScanContainersOptions) => Promise<ContainerIndexEntry[]>
}

export type ChatLevel = 'enabled' | 'commandsOnly' | 'disabled'
export type ViewDistance = 'far' | 'normal' | 'short' | 'tiny' | number
export type MainHands = 'left' | 'right'

export interface PluginOptions {
  [plugin: string]: boolean | Plugin
}

export type Plugin = (bot: Bot, options: BotOptions) => void

export interface BotEvents {
  chat: (
    username: string,
    message: string,
    translate: string | null,
    jsonMsg: ChatMessage,
    matches: string[] | null
  ) => Promise<void> | void
  whisper: (
    username: string,
    message: string,
    translate: string | null,
    jsonMsg: ChatMessage,
    matches: string[] | null
  ) => Promise<void> | void
  actionBar: (jsonMsg: ChatMessage) => Promise<void> | void
  error: (err: Error) => Promise<void> | void
  message: (jsonMsg: ChatMessage, position: string) => Promise<void> | void
  messagestr: (message: string, position: string, jsonMsg: ChatMessage) => Promise<void> | void
  unmatchedMessage: (stringMsg: string, jsonMsg: ChatMessage) => Promise<void> | void
  inject_allowed: () => Promise<void> | void
  login: () => Promise<void> | void
  /** When `respawn` option is disabled, you can call this method manually to respawn. */
  spawn: () => Promise<void> | void
  respawn: () => Promise<void> | void
  /** A totem of undying popped (entity_status 35 for the bot) */
  totemUsed: () => Promise<void> | void
  game: () => Promise<void> | void
  title: (text: string, type: "subtitle" | "title") => Promise<void> | void
  rain: () => Promise<void> | void
  time: () => Promise<void> | void
  kicked: (reason: string, loggedIn: boolean) => Promise<void> | void
  /** The watchdog is ending the connection after `silentMs` without a packet; 'end' follows with reason 'watchdog' */
  watchdog: (silentMs: number) => Promise<void> | void
  end: (reason: string) => Promise<void> | void
  spawnReset: () => Promise<void> | void
  death: () => Promise<void> | void
  health: () => Promise<void> | void
  breath: () => Promise<void> | void
  abilities: (abilities: Abilities) => Promise<void> | void
  entitySwingArm: (entity: Entity) => Promise<void> | void
  entityHurt: (entity: Entity, source: Entity) => Promise<void> | void
  entityDead: (entity: Entity) => Promise<void> | void
  entityTaming: (entity: Entity) => Promise<void> | void
  entityTamed: (entity: Entity) => Promise<void> | void
  entityShakingOffWater: (entity: Entity) => Promise<void> | void
  entityEatingGrass: (entity: Entity) => Promise<void> | void
  entityHandSwap: (entity: Entity) => Promise<void> | void
  entityWake: (entity: Entity) => Promise<void> | void
  entityEat: (entity: Entity) => Promise<void> | void
  entityCriticalEffect: (entity: Entity) => Promise<void> | void
  entityMagicCriticalEffect: (entity: Entity) => Promise<void> | void
  entityCrouch: (entity: Entity) => Promise<void> | void
  entityUncrouch: (entity: Entity) => Promise<void> | void
  entityEquip: (entity: Entity) => Promise<void> | void
  entitySleep: (entity: Entity) => Promise<void> | void
  entitySpawn: (entity: Entity) => Promise<void> | void
  entityElytraFlew: (entity: Entity) => Promise<void> | void
  usedFirework: () => Promise<void> | void
  itemDrop: (entity: Entity) => Promise<void> | void
  playerCollect: (collector: Entity, collected: Entity) => Promise<void> | void
  entityAttributes: (entity: Entity) => Promise<void> | void
  entityGone: (entity: Entity) => Promise<void> | void
  entityMoved: (entity: Entity) => Promise<void> | void
  entityDetach: (entity: Entity, vehicle: Entity) => Promise<void> | void
  entityAttach: (entity: Entity, vehicle: Entity) => Promise<void> | void
  entityUpdate: (entity: Entity) => Promise<void> | void
  entityEffect: (entity: Entity, effect: Effect) => Promise<void> | void
  entityEffectEnd: (entity: Entity, effect: Effect) => Promise<void> | void
  playerJoined: (player: Player) => Promise<void> | void
  playerUpdated: (player: Player) => Promise<void> | void
  playerLeft: (entity: Player) => Promise<void> | void
  blockUpdate: (oldBlock: Block | null, newBlock: Block) => Promise<void> | void
  'blockUpdate:(x, y, z)': (oldBlock: Block | null, newBlock: Block | null) => Promise<void> | void
  blockEntityData: (block: Block | null) => Promise<void> | void
  signOpen: (block: Block | null) => Promise<void> | void
  chunkColumnLoad: (entity: Vec3) => Promise<void> | void
  chunkColumnUnload: (entity: Vec3) => Promise<void> | void
  soundEffectHeard: (
    soundName: string,
    position: Vec3,
    volume: number,
    pitch: number
  ) => Promise<void> | void
  hardcodedSoundEffectHeard: (
    soundId: number,
    soundCategory: number,
    position: Vec3,
    volume: number,
    pitch: number
  ) => Promise<void> | void
  noteHeard: (block: Block, instrument: Instrument, pitch: number) => Promise<void> | void
  pistonMove: (block: Block, isPulling: number, direction: number) => Promise<void> | void
  chestLidMove: (block: Block, isOpen: number, block2: Block | null) => Promise<void> | void
  blockBreakProgressObserved: (block: Block, destroyStage: number) => Promise<void> | void
  blockBreakProgressEnd: (block: Block) => Promise<void> | void
  diggingCompleted: (block: Block) => Promise<void> | void
  diggingAborted: (block: Block) => Promise<void> | void
  move: (position: Vec3) => Promise<void> | void
  forcedMove: () => Promise<void> | void
  mount: () => Promise<void> | void
  dismount: (vehicle: Entity) => Promise<void> | void
  windowOpen: (window: Window) => Promise<void> | void
  windowClose: (window: Window) => Promise<void> | void
  sleep: () => Promise<void> | void
  wake: () => Promise<void> | void
  experience: () => Promise<void> | void
  physicsTick: () => Promise<void> | void
  physicTick: () => Promise<void> | void
  scoreboardCreated: (scoreboard: ScoreBoard) => Promise<void> | void
  scoreboardDeleted: (scoreboard: ScoreBoard) => Promise<void> | void
  scoreboardTitleChanged: (scoreboard: ScoreBoard) => Promise<void> | void
  scoreUpdated: (scoreboard: ScoreBoard, item: number) => Promise<void> | void
  scoreRemoved: (scoreboard: ScoreBoard, item: number) => Promise<void> | void
  scoreboardPosition: (position: DisplaySlot, scoreboard: ScoreBoard) => Promise<void> | void
  teamCreated: (team: Team) => Promise<void> | void
  teamRemoved: (team: Team) => Promise<void> | void
  teamUpdated: (team: Team) => Promise<void> | void
  teamMemberAdded: (team: Team) => Promise<void> | void
  teamMemberRemoved: (team: Team) => Promise<void> | void
  bossBarCreated: (bossBar: BossBar) => Promise<void> | void
  bossBarDeleted: (bossBar: BossBar) => Promise<void> | void
  bossBarUpdated: (bossBar: BossBar) => Promise<void> | void
  resourcePack: (url: string, hash?: string, uuid?: string) => Promise<void> | void
  heldItemChanged: (newItem: Item | null) => Promise<void> | void
  particle: (particle: Particle) => Promise<void> | void
}

export interface CommandBlockOptions {
  mode: number,
  trackOutput: boolean,
  conditional: boolean,
  alwaysActive: boolean
}

export interface Bot extends TypedEmitter<BotEvents> {
  username: string
  /** When the last bytes arrived from the server (`Date.now()`), null before the connection */
  lastPacketAt: number | null
  protocolVersion: string
  majorVersion: string
  version: string
  entity: Entity
  entities: { [id: string]: Entity }
  fireworkRocketDuration: number
  spawnPoint: Vec3
  game: GameState
  player: Player
  players: { [username: string]: Player }
  isRaining: boolean
  thunderState: number
  chatPatterns: ChatPattern[]
  settings: GameSettings
  experience: Experience
  health: number
  food: number
  foodSaturation: number
  oxygenLevel: number
  physics: PhysicsOptions
  physicsEnabled: boolean
  vanilla: VanillaInteract
  abilities: Abilities
  time: Time
  quickBarSlot: number
  inventory: Window<StorageEvents>
  targetDigBlock: Block
  isSleeping: boolean
  scoreboards: { [name: string]: ScoreBoard }
  scoreboard: { [slot in DisplaySlot]: ScoreBoard }
  teams: { [name: string]: Team }
  teamMap: { [name: string]: Team }
  controlState: ControlStateStatus
  creative: creativeMethods
  world: world.WorldSync
  _client: Client
  heldItem: Item | null
  usingHeldItem: boolean
  itemInUse: boolean
  sprinting: boolean
  crouching: boolean
  currentWindow: Window | null
  simpleClick: simpleClick
  tablist: Tablist
  registry: Registry

  connect: (options: BotOptions) => void

  supportFeature: IndexedData['supportFeature']

  end: (reason?: string) => void

  blockAt: (point: Vec3, extraInfos?: boolean) => Block | null

  blockInSight: (maxSteps: number, vectorLength: number) => Block | null

  blockAtCursor: (maxDistance?: number, matcher?: Function) => Block | null
  blockAtEntityCursor: (entity?: Entity, maxDistance?: number, matcher?: Function) => Block | null

  canSeeBlock: (block: Block) => boolean

  findBlock: (options: FindBlockOptions) => Block | null

  findBlocks: (options: FindBlockOptions) => Vec3[]

  canDigBlock: (block: Block) => boolean

  recipesFor: (
    itemType: number,
    metadata: number | null,
    minResultCount: number | null,
    craftingTable: Block | boolean | null
  ) => Recipe[]

  recipesAll: (
    itemType: number,
    metadata: number | null,
    craftingTable: Block | boolean | null
  ) => Recipe[]

  quit: (reason?: string) => void

  tabComplete: (
    str: string,
    assumeCommand?: boolean,
    sendBlockInSight?: boolean,
    timeout?: number
  ) => Promise<string[]>

  chat: (message: string) => void

  whisper: (username: string, message: string) => void

  chatAddPattern: (pattern: RegExp, chatType: string, description?: string) => number

  setSettings: (options: Partial<GameSettings>) => void

  loadPlugin: (plugin: Plugin) => void

  loadPlugins: (plugins: Plugin[]) => void

  hasPlugin: (plugin: Plugin) => boolean

  sleep: (bedBlock: Block) => Promise<void>

  isABed: (bedBlock: Block) => boolean

  wake: () => Promise<void>

  elytraFly: () => Promise<void>

  setControlState: (control: ControlState, state: boolean) => void

  getControlState: (control: ControlState) => boolean

  clearControlStates: () => void

  getExplosionDamages: (targetEntity: Entity, position: Vec3, radius: number, rawDamages?: boolean) => number | null

  lookAt: (point: Vec3, force?: boolean) => Promise<void>

  look: (
    yaw: number,
    pitch: number,
    force?: boolean
  ) => Promise<void>

  updateSign: (block: Block, text: string, back?: boolean) => void

  equip: (
    item: Item | number,
    destination: EquipmentDestination | null
  ) => Promise<void>

  unequip: (
    destination: EquipmentDestination | null
  ) => Promise<void>

  tossStack: (item: Item) => Promise<void>

  toss: (
    itemType: number,
    metadata: number | null,
    count: number | null
  ) => Promise<void>

  dig: ((block: Block, forceLook?: boolean | 'ignore') => Promise<void>) & ((block: Block, forceLook: boolean | 'ignore', digFace: 'auto' | Vec3 | 'raycast') => Promise<void>)

  stopDigging: () => void

  digTime: (block: Block) => number

  placeBlock: (referenceBlock: Block, faceVector: Vec3) => Promise<void>

  placeEntity: (referenceBlock: Block, faceVector: Vec3) => Promise<Entity>

  activateBlock: (block: Block, direction?: Vec3, cursorPos?: Vec3) => Promise<void>

  activateEntity: (entity: Entity, options?: EntityActionOptions) => Promise<void>

  activateEntityAt: (entity: Entity, position: Vec3, options?: EntityActionOptions) => Promise<void>

  consume: () => Promise<void>

  fish: () => Promise<void>

  activateItem: (offhand?: boolean) => Promise<void>

  deactivateItem: () => Promise<void>

  useOn: (targetEntity: Entity, options?: EntityActionOptions) => Promise<void>

  attack: (entity: Entity, options?: EntityActionOptions) => Promise<void>

  swingArm: (hand: 'left' | 'right' | undefined, showHand?: boolean) => Promise<void>

  mount: (entity: Entity, options?: EntityActionOptions) => Promise<void>

  dismount: () => void

  moveVehicle: (left: number, forward: number) => void

  setQuickBarSlot: (slot: number) => Promise<void>

  craft: (
    recipe: Recipe,
    count?: number,
    craftingTable?: Block
  ) => Promise<void>

  writeBook: (
    slot: number,
    pages: string[]
  ) => Promise<void>

  openContainer: (chest: Block | Entity, direction?: Vec3, cursorPos?: Vec3) => Promise<Chest | Dispenser>
  /** The items inside a shulker box item: its `container` component (1.20.5+) or `BlockEntityTag.Items`; `slot` is the slot in the box */
  containerItems: (item: Item) => ContainerItem[]

  openChest: (chest: Block | Entity, direction?: number, cursorPos?: Vec3) => Promise<Chest>

  openFurnace: (furnace: Block) => Promise<Furnace>

  openDispenser: (dispenser: Block) => Promise<Dispenser>

  openEnchantmentTable: (enchantmentTable: Block) => Promise<EnchantmentTable>

  openAnvil: (anvil: Block) => Promise<Anvil>

  openVillager: (
    villager: Entity
  ) => Promise<Villager>

  trade: (
    villagerInstance: Villager,
    tradeIndex: string | number,
    times?: number
  ) => Promise<void>



  setCommandBlock: (pos: Vec3, command: string, options: CommandBlockOptions) => void

  clickWindow: (
    slot: number,
    mouseButton: number,
    mode: number
  ) => Promise<void>

  putSelectedItemRange: (
    start: number,
    end: number,
    window: Window,
    slot: any
  ) => Promise<void>

  putAway: (slot: number) => Promise<void>

  closeWindow: (window: Window) => Promise<void>

  transfer: (options: TransferOptions) => Promise<void>

  openBlock: (block: Block, direction?: Vec3, cursorPos?: Vec3) => Promise<Window>

  openEntity: (block: Entity, Class: new () => EventEmitter) => Promise<Window>

  moveSlotItem: (
    sourceSlot: number,
    destSlot: number
  ) => Promise<void>

  updateHeldItem: () => void

  getEquipmentDestSlot: (destination: string) => number

  waitForChunksToLoad: () => Promise<void>

  entityAtCursor: (maxDistance?: number) => Entity | null
  nearestEntity: (filter?: (entity: Entity) => boolean) => Entity | null

  waitForTicks: (ticks: number) => Promise<void>

  addChatPattern: (name: string, pattern: RegExp, options?: chatPatternOptions) => number

  addChatPatternSet: (name: string, patterns: RegExp[], options?: chatPatternOptions) => number

  removeChatPattern: (name: string | number) => void

  awaitMessage: (...args: string[] | RegExp[]) => Promise<string>

  acceptResourcePack: () => void

  denyResourcePack: () => void

  respawn: () => void
}

export interface simpleClick {
  leftMouse: (slot: number) => Promise<void>
  rightMouse: (slot: number) => Promise<void>
}

export interface Tablist {
  header: ChatMessage
  footer: ChatMessage
}

export interface chatPatternOptions {
  repeat: boolean
  parse: boolean
}

export interface GameState {
  levelType: LevelType
  gameMode: GameMode
  hardcore: boolean
  dimension: Dimension
  difficulty: Difficulty
  maxPlayers: number
  serverBrand: string
}

export type LevelType =
  | 'default'
  | 'flat'
  | 'largeBiomes'
  | 'amplified'
  | 'customized'
  | 'buffet'
  | 'default_1_1'
export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator'
export type Dimension = 'the_nether' | 'overworld' | 'the_end'
export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard'

export interface Player {
  uuid: string
  username: string
  displayName: ChatMessage
  gamemode: number
  ping: number
  entity: Entity
  skinData: SkinData | undefined
  profileKeys?: {
    publicKey: Buffer
    signature: Buffer
  }
}

export interface SkinData {
  url: string
  model: string | null
  capeUrl?: string
}

export interface ChatPattern {
  pattern: RegExp
  type: string
  description: string
}

export interface SkinParts {
  showCape: boolean
  showJacket: boolean
  showLeftSleeve: boolean
  showRightSleeve: boolean
  showLeftPants: boolean
  showRightPants: boolean
  showHat: boolean
}

export interface GameSettings {
  chat: ChatLevel
  colorsEnabled: boolean
  viewDistance: ViewDistance
  difficulty: number
  skinParts: SkinParts
  mainHand: MainHands
}

export interface Experience {
  level: number
  points: number
  progress: number
}

export interface Abilities {
  invulnerable: boolean
  flying: boolean
  mayFly: boolean
  instantBuild: boolean
  flyingSpeed: number
  walkingSpeed: number
}

export interface PhysicsOptions {
  maxGroundSpeed: number
  terminalVelocity: number
  walkingAcceleration: number
  gravity: number
  groundFriction: number
  playerApothem: number
  playerHeight: number
  jumpSpeed: number
  yawSpeed: number
  pitchSpeed: number
  sprintSpeed: number
  maxGroundSpeedSoulSand: number
  maxGroundSpeedWater: number
}

export interface Time {
  doDaylightCycle: boolean
  bigTime: BigInt
  time: number
  timeOfDay: number
  day: number
  isDay: boolean
  moonPhase: number
  bigAge: BigInt
  age: number
}

export interface ControlStateStatus {
  forward: boolean
  back: boolean
  left: boolean
  right: boolean
  jump: boolean
  sprint: boolean
  sneak: boolean
}

export type ControlState =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'jump'
  | 'sprint'
  | 'sneak'

export interface Effect {
  id: number
  amplifier: number
  duration: number
}

export interface Instrument {
  id: number
  name: 'harp' | 'doubleBass' | 'snareDrum' | 'sticks' | 'bassDrum'
}

export interface FindBlockOptions {
  point?: Vec3
  matching: number | number[] | ((block: Block) => boolean)
  maxDistance?: number
  count?: number
  useExtraInfo?: boolean | ((block: Block) => boolean)
}

export type EquipmentDestination = 'hand' | 'head' | 'torso' | 'legs' | 'feet' | 'off-hand'

export interface TransferOptions {
  window: Window
  itemType: number
  metadata: number | null
  count?: number,
  sourceStart: number
  sourceEnd: number
  destStart: number
  destEnd: number
}

export interface creativeMethods {
  setInventorySlot: (
    slot: number,
    item: Item | null
  ) => Promise<void>

  clearSlot: (slot: number) => Promise<void>

  clearInventory: () => Promise<void>

  flyTo: (destination: Vec3) => Promise<void>

  startFlying: () => void

  stopFlying: () => void
}

export class Location {
  floored: Vec3
  blockPoint: Vec3
  chunkCorner: Vec3
  blockIndex: number
  biomeBlockIndex: number
  chunkYIndex: number

  constructor (absoluteVector: Vec3);
}

export class Painting {
  id: number
  position: Vec3
  name: string
  direction: Vec3

  constructor (id: number, position: Vec3, name: string, direction: Vec3);
}

interface StorageEvents {
  open: () => void
  close: () => void
  updateSlot: (slot: number, oldItem: Item | null, newItem: Item | null) => void
}

interface FurnaceEvents extends StorageEvents {
  update: () => void
}

interface ConditionalStorageEvents extends StorageEvents {
  ready: () => void
}

export class Chest extends Window<StorageEvents> {
  constructor ();

  close (): Promise<void>;

  deposit (
    itemType: number,
    metadata: number | null,
    count: number | null
  ): Promise<void>;

  withdraw (
    itemType: number,
    metadata: number | null,
    count: number | null
  ): Promise<void>;
}

export class Furnace extends Window<FurnaceEvents> {
  fuel: number
  progress: number

  constructor ();

  close (): Promise<void>;

  takeInput (): Promise<Item>;

  takeFuel (): Promise<Item>;

  takeOutput (): Promise<Item>;

  putInput (
    itemType: number,
    metadata: number | null,
    count: number
  ): Promise<void>;

  putFuel (
    itemType: number,
    metadata: number | null,
    count: number
  ): Promise<void>;

  inputItem (): Item;

  fuelItem (): Item;

  outputItem (): Item;
}

export class Dispenser extends Window<StorageEvents> {
  constructor ();

  close (): Promise<void>;

  deposit (
    itemType: number,
    metadata: number | null,
    count: number | null
  ): Promise<void>;

  withdraw (
    itemType: number,
    metadata: number | null,
    count: number | null
  ): Promise<void>;
}

export class EnchantmentTable extends Window<ConditionalStorageEvents> {
  enchantments: Enchantment[]

  constructor ();

  close (): Promise<void>;

  targetItem (): Item;

  enchant (
    choice: string | number
  ): Promise<Item>;

  takeTargetItem (): Promise<Item>;

  putTargetItem (item: Item): Promise<Item>;

  putLapis (item: Item): Promise<Item>;
}

export class Anvil {
  combine (itemOne: Item, itemTwo: Item, name?: string): Promise<void>
  rename (item: Item, name?: string): Promise<void>
}

export interface Enchantment {
  level: number
  expected: { enchant: number, level: number }
}

export class Villager extends Window<ConditionalStorageEvents> {
  trades: VillagerTrade[]

  constructor ();

  close (): Promise<void>;
}

export interface VillagerTrade {
  inputItem1: Item
  outputItem: Item
  inputItem2: Item | null
  hasItem2: boolean
  tradeDisabled: boolean
  nbTradeUses: number
  maximumNbTradeUses: number
  xp?: number
  specialPrice?: number
  priceMultiplier?: number
  demand?: number
  realPrice?: number
}

export class ScoreBoard {
  name: string
  title: string
  itemsMap: { [name: string]: ScoreBoardItem }
  items: ScoreBoardItem[]

  constructor (packet: object);

  setTitle (title: string): void;

  add(name: string, value: number): ScoreBoardItem;

  remove (name: string): ScoreBoardItem;
}

export interface ScoreBoardItem {
  name: string
  displayName: ChatMessage
  value: number
}

export class Team {
  team: string
  name: ChatMessage
  friendlyFire: number
  nameTagVisibility: string
  collisionRule: string
  color: string
  prefix: ChatMessage
  suffix: ChatMessage
  memberMap: { [name: string]: '' }
  members: string[]

  constructor(team: string, name: string, friendlyFire: boolean, nameTagVisibility: string, collisionRule: string, formatting: number, prefix: string, suffix: string);

  parseMessage (value: string): ChatMessage;

  add (name: string, value: number): void;

  remove (name: string): void;

  update (name: string, friendlyFire: boolean, nameTagVisibility: string, collisionRule: string, formatting: number, prefix: string, suffix: string): void;

  displayName (member: string): ChatMessage;
}

export type DisplaySlot =
  | 'list'
  | 'sidebar'
  | 'belowName'
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18

export class BossBar {
  entityUUID: string
  title: ChatMessage
  health: number
  dividers: number
  color: 'pink' | 'blue' | 'red' | 'green' | 'yellow' | 'purple' | 'white'
  shouldDarkenSky: boolean
  isDragonBar: boolean
  createFog: boolean
  shouldCreateFog: boolean

  constructor (
    uuid: string,
    title: string,
    health: number,
    dividers: number,
    color: number,
    flags: number
  );
}

export class Particle {
  id: number
  position: Vec3
  offset: Vec3
  count: number
  movementSpeed: number
  longDistanceRender: boolean
  static fromNetwork(packet: Object): Particle

  constructor(
    id: number,
    position: Vec3,
    offset: Vec3,
    count?: number,
    movementSpeed?: number,
    longDistanceRender?: boolean
  );
}

export let testedVersions: string[]
export let latestSupportedVersion: string
export let oldestSupportedVersion: string

export function supportFeature (feature: string, version: string): boolean

/** Number of undecodable packets skipped so far (see `skipUndecodablePackets`) */
export function protodefSkipped (): number
export function installProtodefGuard (): boolean

/** What attack, useOn, mount and activateEntity* take: aiming is on by default (turn to the hitbox, settle, check the ray). Errors carry `code`: 'gone' | 'too-far' | 'no-sight' | 'moved'. */
export interface EntityActionOptions {
  /** false: don't turn to the entity (the reach and stale-id checks remain) */
  aim?: boolean
  /** range in blocks, default the entity_interaction_range attribute (3.0) */
  reach?: number
  /** interactions: the world point to aim at, clamped into the hitbox */
  point?: Vec3
}

// ── Keeping a bot connected (lib/connection.js) ─────────────────────────────

export type PersistentBotState = 'connecting' | 'online' | 'waiting' | 'stopped'
export type ReconnectVerdict = 'retry' | 'stop' | 'wait'

export interface LoginBudget {
  /** Logins (attempts that reached the socket) per `windowMs` for this bot; 0 = unlimited @default 6 */
  perHour?: number
  /**
   * Logins per `windowMs` to one host:port from the whole process (every PersistentBot targeting it); 0 = unlimited.
   * TCPShield counts per IP, not per account. @default 20
   */
  perHostPerHour?: number
  /** Minimum time between two logins starting in this process, shared by every PersistentBot. @default 15000 for auth 'microsoft', else 0 */
  minSpacingMs?: number
  /** @default 3600000 */
  windowMs?: number
}

/** Remembers the login timestamps across process restarts. Synchronous; failures are ignored. */
export interface LoginStore {
  load: () => LoginState | null | undefined
  save: (state: LoginState) => void
}

/** `hosts` holds the history of the host budget, keyed by 'host:port' */
export interface LoginState {
  logins: number[]
  hosts?: Record<string, number[]>
}

export interface ReconnectOptions {
  /** @default true */
  enabled?: boolean
  /** Delay after the first failure, doubling after each one @default 10000 */
  baseDelayMs?: number
  /** @default 300000 */
  maxDelayMs?: number
  /** Fraction of random spread on every delay (0 to 1) @default 0.2 */
  jitter?: number
  /** Consecutive failed attempts before giving up; 0 = never @default 0 */
  maxAttempts?: number
  loginBudget?: LoginBudget
  store?: LoginStore
  /** Milliseconds from the attempt to the first spawn before the connection is dropped and counted as hung @default 180000 */
  loginTimeoutMs?: number
  /** Hung logins in a row after which the keeper stops (the IP is probably throttled); 0 = never @default 3 */
  hungLoginLimit?: number
  /**
   * After that stop, one new try this long later (and again each time it hangs) instead of stopping for good;
   * 'waiting' (reason 'throttled') says when. 0 = stop for good with cause 'throttled'. @default 3600000
   */
  hungLoginResumeMs?: number
  /** Time online after which the backoff starts over @default 60000 */
  stableMs?: number
  /** How long 'wait' verdicts (already connected, server restart, 429) hold off @default 300000 */
  longWaitMs?: number
  /** 'already connected' kicks in a row before assuming another session owns the account @default 3 */
  conflictLimit?: number
  /** Pause before following a transfer packet @default 500 */
  transferDelayMs?: number
  /** Added to the built-in list (bans, whitelist, invalid session, outdated client…): kick texts that mean stop */
  giveUpOn?: Array<string | RegExp>
  /** Decide for a disconnect text; return nothing to use the built-in rules */
  classify?: (reason: string, info: { kicked: boolean, error: Error | null, wasOnline: boolean, onlineMs: number, hung: boolean }) => ReconnectVerdict | void | undefined
}

export interface PersistentBotOptions extends Omit<BotOptions, 'client'> {
  reconnect?: ReconnectOptions | false
  /** Called with every new bot before it connects (load plugins here) */
  onBot?: (bot: Bot) => void
}

export interface ReconnectDecision {
  action: ReconnectVerdict
  /** Why: 'user', 'stopped', 'give-up', 'classify', 'throttled', 'conflict', 'max-attempts', 'transfer', 'rate-limit', 'server-restart', 'hung-login', 'watchdog', 'kicked', 'network'… */
  cause: string
  delayMs: number
  /** When the next login starts (`Date.now()` scale); null when stopped */
  at: number | null
  /** 'budget' or 'hostBudget' if a login budget, not the backoff, sets the time */
  blockedBy?: 'budget' | 'hostBudget' | null
  /** What the client reported ('socketClosed', 'watchdog', 'loginTimeout'…) */
  endReason?: string
  message?: string
}

export interface PersistentBotStats {
  /** Logins that reached 'login' */
  logins: number
  /** Connections started, not counting transfers */
  attempts: number
  kicks: number
  hungLogins: number
  hungLoginsInARow: number
  transfers: number
  loginsLastHour: number
  lastError: { message: string, code?: string, at: number } | null
  lastKick: { reason: string, at: number } | null
  lastEnd: { reason: string, at: number } | null
  nextAttemptAt: number | null
  onlineSince: number | null
}

export interface PersistentBotEvents {
  /** A new bot, before it connects: attach listeners and load plugins */
  bot: (bot: Bot) => void
  login: (bot: Bot) => void
  spawn: (bot: Bot) => void
  /** A connection ended; `decision` says whether and when the next one starts */
  end: (reason: string, decision: ReconnectDecision) => void
  /** A retry is scheduled */
  reconnecting: (info: { attempt: number, delayMs: number, at: number, reason: string }) => void
  /** The login budget holds the next login back until `until` */
  waiting: (info: { until: number, delayMs: number, reason: 'budget' | 'hostBudget' | 'throttled', loginsLastHour: number, perHour: number }) => void
  /** The server moved the player to `host:port`; the keeper follows */
  transfer: (target: { host: string, port: number }) => void
  /** Microsoft device-code sign-in needed */
  msaCode: (data: any) => void
  state: (state: PersistentBotState, previous: PersistentBotState) => void
  stopped: (reason: string, cause: string) => void
  error: (err: Error) => void
}

/** Keeps a bot connected, reconnecting within a login budget (see docs/api.md) */
export class PersistentBot extends (EventEmitter as new () => TypedEmitter<PersistentBotEvents>) {
  constructor (options: PersistentBotOptions)
  /** The current bot, replaced on every reconnect; null before the first login */
  bot: Bot | null
  readonly state: PersistentBotState
  readonly stats: PersistentBotStats
  /** Resolves with the bot once it has spawned. Rejects with code 'stopped' or 'timeout'. */
  whenOnline (options?: { timeoutMs?: number }): Promise<Bot>
  /** Runs a task on the current bot; rejects with code 'disconnected' if the bot ends first (`signal` aborts then) */
  run<T> (task: (bot: Bot, signal: AbortSignal) => Promise<T> | T, options?: { wait?: boolean }): Promise<T>
  /** Stops for good: cancels a pending retry or sign-in and ends the bot */
  stop (reason?: string): void
  /** Skips the wait and logs in now (the budget still applies unless `ignoreBudget`); restarts a stopped bot */
  reconnectNow (options?: { ignoreBudget?: boolean }): boolean
}

export function createPersistentBot (options: PersistentBotOptions): PersistentBot
/** Login history in a JSON file; several bots can share it with different `key`s */
export function fileStore (file: string, options?: { key?: string }): LoginStore
