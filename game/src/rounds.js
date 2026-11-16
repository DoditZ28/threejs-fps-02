// The match: rounds, money and the bomb, in one place. Ember attacks,
// Slate defends. A round is won by eliminating the other team, by the
// bomb exploding, by a defuse, or by the clock running out with no plant.
// First to 5 rounds takes the match (at most 9 rounds). Money pays for
// the next round's guns; the amounts are the Counter-Strike shape, not
// its numbers.
import { WEAPONS, GRENADE, ARMOR_PRICE } from './weapons.js';

export const BUY_TIME = 12;
export const ROUND_TIME = 100;
export const FUSE_TIME = 40;
export const WIN_ROUNDS = 5;
export const MAX_ROUNDS = 9;
export const PLANT_TIME = 3;
export const DEFUSE_TIME = 5;

export const SHOP = [
  { id: 'rifle', name: WEAPONS.rifle.name, price: WEAPONS.rifle.price, kind: 'primary' },
  { id: 'smg', name: WEAPONS.smg.name, price: WEAPONS.smg.price, kind: 'primary' },
  { id: 'sniper', name: WEAPONS.sniper.name, price: WEAPONS.sniper.price, kind: 'primary' },
  { id: 'grenade', name: GRENADE.name, price: GRENADE.price, kind: 'grenade' },
  { id: 'armor', name: 'Kevlar Vest', price: ARMOR_PRICE, kind: 'armor' },
];

export function createMatch(events) {
  const state = {
    round: 1,
    score: { ember: 0, slate: 0 },
    phase: 'buy', // buy | live | planted | over | matchover
    phaseTime: BUY_TIME,
    money: 800,
    lossStreak: 0,
    bomb: {
      planted: false,
      site: null, // 'A' | 'B'
      fuse: 0,
      defuseProgress: 0,
      carrier: 'player', // 'player' | bot id
    },
    lastReason: '',
    winner: null,
  };

  function endRound(winner, reason) {
    if (state.phase === 'over' || state.phase === 'matchover') return;
    state.score[winner] += 1;
    state.lastReason = reason;
    if (winner === 'ember') {
      state.money += 3250;
      state.lossStreak = 0;
    } else {
      state.money += 1900 + Math.min(state.lossStreak, 3) * 500;
      state.lossStreak += 1;
    }
    state.phase = 'over';
    state.phaseTime = 5;
    events.onRoundEnd(winner, reason, { ...state.score });
    if (state.score[winner] >= WIN_ROUNDS || state.round >= MAX_ROUNDS) {
      state.phase = 'matchover';
      state.winner = state.score.ember > state.score.slate ? 'ember' : 'slate';
      state.phaseTime = 999;
      events.onMatchEnd(state.winner, { ...state.score });
    }
  }

  return {
    state,
    startMatch() {
      state.round = 1;
      state.score.ember = 0;
      state.score.slate = 0;
      state.money = 800;
      state.lossStreak = 0;
      state.winner = null;
      this.startRound();
    },
    startRound() {
      state.phase = 'buy';
      state.phaseTime = BUY_TIME;
      state.bomb.planted = false;
      state.bomb.site = null;
      state.bomb.fuse = 0;
      state.bomb.defuseProgress = 0;
      state.bomb.carrier = 'player';
      events.onRoundStart(state.round);
    },
    nextRound() {
      state.round += 1;
      this.startRound();
    },
    beginLive() {
      if (state.phase !== 'buy') return;
      state.phase = 'live';
      state.phaseTime = ROUND_TIME;
      events.onLiveStart();
    },
    plantBomb(site) {
      if (state.phase !== 'live') return false;
      state.bomb.planted = true;
      state.bomb.site = site;
      state.bomb.fuse = FUSE_TIME;
      state.phase = 'planted';
      state.phaseTime = FUSE_TIME;
      state.money += 300;
      events.onBombPlanted(site);
      return true;
    },
    defuseBomb() {
      if (state.phase !== 'planted') return false;
      state.bomb.planted = false;
      endRound('slate', 'Bomb defused');
      return true;
    },
    // Step the clocks. `alive` is { ember, slate } live counts; the
    // match only ends rounds on the clock and the fuse — eliminations
    // are reported by the game, which sees the kills first.
    step(dt, alive) {
      if (state.phase === 'buy') {
        state.phaseTime -= dt;
        if (state.phaseTime <= 0) this.beginLive();
      } else if (state.phase === 'live') {
        state.phaseTime -= dt;
        if (state.phaseTime <= 0) endRound('slate', 'Time expired — no plant');
      } else if (state.phase === 'planted') {
        state.phaseTime -= dt;
        state.bomb.fuse = state.phaseTime;
        if (state.phaseTime <= 0) endRound('ember', 'Bomb detonated');
      } else if (state.phase === 'over') {
        state.phaseTime -= dt;
        if (state.phaseTime <= 0) {
          if (state.score.ember >= WIN_ROUNDS || state.score.slate >= WIN_ROUNDS || state.round >= MAX_ROUNDS) {
            state.phase = 'matchover';
          } else {
            this.nextRound();
          }
        }
      }
      void alive;
    },
    reportElimination(alive) {
      if (state.phase !== 'live' && state.phase !== 'planted') return;
      if (alive.ember === 0) {
        if (state.phase === 'planted') {
          // Defenders still have to defuse; the round plays on.
          events.onTeamWiped('ember');
          return;
        }
        endRound('slate', 'Ember team eliminated');
      } else if (alive.slate === 0) {
        if (state.phase === 'planted') {
          // No one left to defuse: the bomb goes off.
          endRound('ember', 'Slate team eliminated — bomb detonates');
        } else {
          endRound('ember', 'Slate team eliminated');
        }
      }
    },
    awardKill() {
      state.money += 300;
    },
    canBuy() {
      return state.phase === 'buy';
    },
    buy(itemId) {
      const item = SHOP.find((entry) => entry.id === itemId);
      if (!item || state.phase !== 'buy') return null;
      if (state.money < item.price) return null;
      state.money -= item.price;
      return item;
    },
    // The player is standing on a site with the bomb: which one?
    siteAt(x, z, sites) {
      for (const [letter, site] of Object.entries(sites)) {
        const dx = x - site.center.x;
        const dz = z - site.center.z;
        if (dx * dx + dz * dz <= site.radius * site.radius) return letter;
      }
      return null;
    },
  };
}
