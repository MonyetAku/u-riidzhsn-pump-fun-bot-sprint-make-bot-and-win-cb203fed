// Pump.fun Bot Sprint: Make Bot And Win — launch-sniper paper bot.
//
// The replay is a 24h tape of pump.fun bonding curves; every coin pumps in
// its first 1-3 slots (the big 2x-14x moves are over before any fill can
// land, 2 slots after the decision) and then bleeds slowly. Momentum chasing
// loses ~0.6-1.1 SOL on the dev window and buying everything loses ~1.4 SOL.
// So this bot does the opposite of chasing: it buys only the earliest,
// cheapest launches that look untouched — flat price, tiny creator buy, at
// most one other buyer, creator has not sold — and exits on a trailing stop
// (-15% from the peak since entry), a stop-loss (-20%), a hard 100-slot cap,
// or immediately when the creator sells. Dev-window grade of this exact
// configuration: net -0.0099 SOL over 33 coins / 66 fills, max drawdown 0.2%,
// both window halves near breakeven (-0.006 / -0.004). No variant tested
// (about 60 parameter combinations across sniper, momentum and hold-to-
// completion shapes) was net positive on the dev window; this is the closest
// to breakeven with real exposure, so it is the entry: the prize needs net
// PnL > 0 on the unseen 6-hour final window, and this shape gives that draw
// the best odds of any shape measured.
//
// The bot speaks agent-fun/replay/v2 on stdin/stdout through the kit's
// vendored shim and writes nothing to disk. It never reads the clock, the
// environment or any randomness: every decision comes from the batch.

import { runBot, type Batch, type BotState, type OrderInput } from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;
const TX_FEE = 105_000n; // base + priority fee the harness charges per order
const CURVE_FEE_BPS = 125n; // protocol 95 + creator 30 fallback, charged on each side

// Tuned on the full dev window (see the header note). Units: SOL for sizes,
// basis points for ratios, slots for ages.
const PARAMS = {
  maxAge: 3, // buy only within 3 slots of the CreateEvent
  maxRunupBps: 11000, // price vs create price at most 1.10x (flat = untouched)
  minRqSol: 0.3, // real SOL reserves between 0.3 and 30
  maxRqSol: 30,
  maxCreatorBuySol: 1.0, // creator's own buys total at most 1 SOL
  maxOtherBuyers: 1, // at most one distinct non-creator buyer so far
  stakeSol: 0.05, // target bet size
  stakeCapBps: 100, // ...capped at 1% of real reserves (the harness cap)
  minStakeSol: 0.01, // skip when the capped stake falls below the 0.01 SOL round-trip floor
  slBps: 2000, // stop-loss: net value 20% below cost
  maxHold: 100, // hard exit 100 slots after the buy fills
  slipBps: 1000, // max slippage on every order (10%)
  trailBps: 1500, // trailing stop: net value 15% below its peak since entry
} as const;

interface Coin {
  createdSlot: number;
  createVq: bigint;
  createVt: bigint;
  creator: string;
  creatorBuy: bigint;
  creatorSold: boolean;
  otherBuyers: Set<string>;
  bought: boolean;
}

interface Held {
  cost: bigint;
  tokens: bigint;
  buySlot: number;
  peak: bigint; // best net value seen since entry, for the trailing stop
}

// SOL lamports per token, scaled by 1e9 so the division stays in integers.
function priceOf(vq: bigint, vt: bigint): bigint {
  if (vt === 0n) return 0n;
  return (vq * 1_000_000_000n) / vt;
}

const coins = new Map<string, Coin>();
const held = new Map<string, Held>();

function trackEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      if (!coins.has(e.mint)) {
        coins.set(e.mint, {
          createdSlot: e.slot,
          createVq: BigInt(e.virtual_quote_reserves),
          createVt: BigInt(e.virtual_token_reserves),
          creator: e.creator,
          creatorBuy: 0n,
          creatorSold: false,
          otherBuyers: new Set(),
          bought: false,
        });
      }
    } else if (e.event === 'TradeEvent') {
      const c = coins.get(e.mint);
      if (c === undefined) continue;
      if (e.user === c.creator) {
        if (e.is_buy) c.creatorBuy += BigInt(e.sol_amount);
        else c.creatorSold = true;
      } else if (e.is_buy) {
        c.otherBuyers.add(e.user);
      }
    }
  }
}

function trackFills(state: BotState, batch: Batch): void {
  for (const f of batch.fills) {
    if (f.status !== 'filled') continue;
    if (f.side === 'buy') {
      const pos = state.positions.get(f.mint);
      const c = coins.get(f.mint);
      if (c !== undefined) c.bought = true;
      held.set(f.mint, {
        cost: pos !== undefined ? pos.cost_lamports : BigInt(f.quote_lamports),
        tokens: BigInt(f.token_amount),
        buySlot: f.slot,
        peak: 0n,
      });
    } else if (f.side === 'sell') {
      const pos = state.positions.get(f.mint);
      if (pos === undefined) {
        held.delete(f.mint);
      } else {
        const h = held.get(f.mint);
        if (h !== undefined) {
          h.tokens = pos.token_amount;
          h.cost = pos.cost_lamports;
        }
      }
    }
  }
  // Positions the harness closed itself (curve completed / replay flattened).
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint)) held.delete(mint);
  }
}

// Exits first: trailing stop, stop-loss, hard time cap, creator sell.
// The net value is what a full sell would return now: tokens at the current
// curve price, minus curve fees and the tx fee.
function exitOrders(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  for (const [mint, h] of held) {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    let sellPending = false;
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell' && p.order.mint === mint) {
        sellPending = true;
        break;
      }
    }
    if (sellPending) continue;
    const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (price === 0n) continue;
    const gross = (h.tokens * price) / 1_000_000_000n;
    const net = (gross * (BPS - CURVE_FEE_BPS)) / BPS - TX_FEE;
    if (net > h.peak) h.peak = net;
    const slAt = (h.cost * (BPS - BigInt(PARAMS.slBps))) / BPS;
    const coin = coins.get(mint);
    const creatorDumped = coin !== undefined && coin.creatorSold;
    const tooOld = batch.slot - h.buySlot >= PARAMS.maxHold;
    const trailed = h.peak > 0n && net <= (h.peak * (BPS - BigInt(PARAMS.trailBps))) / BPS;
    if (net <= slAt || creatorDumped || tooOld || trailed) {
      const pos = state.positions.get(mint);
      if (pos !== undefined && pos.token_amount > 0n) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: PARAMS.slipBps });
      }
    }
  }
  return orders;
}

// Entries: the earliest, cheapest, least-touched launches only. One shot per
// mint; a buy that the harness rejects is not retried.
function entryOrders(state: BotState, batch: Batch, orders: OrderInput[]): void {
  if (state.committedPositionCount() >= state.hello.caps.max_open_positions) return;
  for (const [mint, c] of coins) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (c.bought) continue;
    if (state.positions.has(mint)) continue;
    let buyPending = false;
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy' && p.order.mint === mint) {
        buyPending = true;
        break;
      }
    }
    if (buyPending) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const age = batch.slot - c.createdSlot;
    if (age < 0 || age > PARAMS.maxAge) continue;
    // Run-up vs create price must be at most 1.10x, in exact integer ratios.
    if (c.createVq === 0n || c.createVt === 0n) continue;
    const lhs = curve.virtual_quote_reserves * c.createVt * BPS;
    const rhs = BigInt(PARAMS.maxRunupBps) * curve.virtual_token_reserves * c.createVq;
    if (lhs > rhs) continue;
    // Real-reserve band.
    const rqSol = Number(curve.real_quote_reserves) / 1e9;
    if (rqSol < PARAMS.minRqSol || rqSol > PARAMS.maxRqSol) continue;
    // Rug filter: small creator buy, no creator sale, at most one other buyer.
    if (Number(c.creatorBuy) / 1e9 > PARAMS.maxCreatorBuySol) continue;
    if (c.creatorSold) continue;
    if (c.otherBuyers.size > PARAMS.maxOtherBuyers) continue;
    // Size: min(stake, 1% of real reserves); skip below the round-trip floor.
    const capStake = (curve.real_quote_reserves * BigInt(PARAMS.stakeCapBps)) / BPS;
    let stake = BigInt(Math.round(PARAMS.stakeSol * 1e9));
    if (stake > capStake) stake = capStake;
    if (stake < BigInt(Math.round(PARAMS.minStakeSol * 1e9))) continue;
    if (state.freeCashLamports() < stake + TX_FEE) continue;
    orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: PARAMS.slipBps });
    c.bought = true;
  }
}

await runBot({
  onBatch(state, batch) {
    trackEvents(batch);
    trackFills(state, batch);
    const orders = exitOrders(state, batch);
    entryOrders(state, batch, orders);
    return orders;
  },
});
