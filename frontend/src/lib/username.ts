/**
 * Generated display names for the account.
 *
 * Every install starts with a name so the login dialog has something to show
 * under the avatar without asking first. Names are short English handles built
 * from two curated word lists — `Adjective Noun`, e.g. "Sassy Otter" — which
 * keeps them readable in both locales and gives the built-in avatar picker a
 * stable string to hash (see `builtinAvatarIdFor` in ./avatar.ts).
 *
 * Pure module: no storage, no DOM, so the check scripts can import it.
 */

/** First half of a generated name. Order is cosmetic; length feeds the pick. */
const ADJECTIVES = [
  'Sassy',
  'Neon',
  'Cosmic',
  'Dapper',
  'Velvet',
  'Brave',
  'Sly',
  'Mellow',
  'Rusty',
  'Quantum',
  'Cozy',
  'Witty',
  'Sunny',
  'Mystic',
  'Turbo',
  'Lunar',
  'Peppy',
  'Gritty',
  'Breezy',
  'Zesty',
  'Dizzy',
  'Snazzy',
  'Minty',
  'Groovy',
  'Sleepy',
  'Rapid',
  'Golden',
  'Icy',
  'Fuzzy',
  'Cheeky',
  'Jolly',
  'Plucky',
  'Silver',
  'Wild',
  'Chill',
  'Bouncy',
  'Sparky',
  'Wonder',
  'Crystal',
  'Ember',
  'Frosty',
  'Giggly',
  'Handy',
  'Jazzy',
  'Kooky',
  'Lucky',
  'Merry',
  'Nifty',
] as const;

/**
 * Second half of a generated name: the animals on the built-in avatars plus
 * creatures and objects that read well as a handle.
 */
const NOUNS = [
  'Otter',
  'Capybara',
  'Penguin',
  'Samoyed',
  'Raccoon',
  'Whale',
  'Robot',
  'Screwdriver',
  'Fox',
  'Owl',
  'Lynx',
  'Alpaca',
  'Gecko',
  'Narwhal',
  'Pangolin',
  'Axolotl',
  'Corgi',
  'Sloth',
  'Mantis',
  'Raven',
  'Falcon',
  'Hamster',
  'Dolphin',
  'Llama',
  'Badger',
  'Wombat',
  'Byte',
  'Pixel',
  'Comet',
  'Nova',
  'Meteor',
  'Gadget',
  'Widget',
  'Circuit',
  'Magnet',
  'Rocket',
  'Anchor',
  'Lantern',
  'Beacon',
  'Pebble',
  'Marshmallow',
  'Waffle',
  'Pancake',
  'Dumpling',
  'Pretzel',
  'Cactus',
  'Bubble',
  'Feather',
] as const;

/** Every name the generator can produce — handy for tests and uniqueness checks. */
export const USER_NAME_COMBINATIONS = ADJECTIVES.length * NOUNS.length;

function pick<T>(items: readonly T[], rand: () => number): T {
  const value = rand();
  // Clamp (and rescue NaN) so any rand() still selects a real entry.
  const index = Number.isFinite(value) ? Math.floor(value * items.length) : 0;
  return items[Math.min(items.length - 1, Math.max(0, index))];
}

/**
 * A fresh `Adjective Noun` handle.
 *
 * @param rand source of randomness; defaults to `Math.random`
 * @param avoid when the roll would repeat this name, the noun steps one slot
 *   along the list instead, so a dice roll never returns the current name
 */
export function randomUserName(rand: () => number = Math.random, avoid = ''): string {
  const adjective = pick(ADJECTIVES, rand);
  let noun = pick(NOUNS, rand);
  if (`${adjective} ${noun}` === avoid && NOUNS.length > 1) {
    noun = NOUNS[(NOUNS.indexOf(noun) + 1) % NOUNS.length];
  }
  return `${adjective} ${noun}`;
}
