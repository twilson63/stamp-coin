import { AddPair, CancelOrder, CreateOrder, Halt } from "@verto/component";
import map from 'ramda/src/map'
import assoc from 'ramda/src/assoc'

import {
  StampInterface,
  StateInterface,
  ActionInterface,
  BalanceInterface,
  ForeignCallInterface,
} from "./faces";

import { mintRewards, pstAllocation } from './utils'

const handleComponent = (f) => async (s, a) => ({ state: await f(s, a) })

const functions = {
  evolve, stamp, reward, transfer, readOutbox, balance,
  addPair: handleComponent(AddPair),
  createOrder: handleComponent(CreateOrder),
  cancelOrder: handleComponent(CancelOrder),
  halt: handleComponent(Halt)
}
const REWARD = 1000_000_000_000_000

export async function handle(
  state: StateInterface,
  action: ActionInterface
): Promise<{ state: StateInterface } | { result: BalanceInterface }> {

  if (action.input.function === 'addPair') {
    const s = await AddPair(state, action)
    return { state: s }
  }
  if (action.input.function === 'createOrder') {
    const resultObj = await CreateOrder(state, action)
    return { state: resultObj.state }
  }

  if (Object.keys(functions).includes(action.input.function)) {
    return functions[action.input.function](state, action)
  }
  throw new ContractError(`${action.input.function} function not implemented!`)

}

async function reward(state: StateInterface, action: ActionInterface): Promise<{ state: StateInterface }> {
  const caller = action.caller;
  // STEP 1a - verify contract caller is creator
  ContractAssert(caller === state.creator, 'Only coin creator can run reward function!')
  // STEP 2 - get all stamps that are not flagged true
  const newStampValues = Object.values(state.stamps).filter(stamp => stamp.flagged === false);
  // STEP 3 - aggregate by asset identifier (Asset)
  // STEP 4 - Calculate reward points/coins
  const rewards = mintRewards(newStampValues, REWARD)
  // STEP 5 - for each reward, readContractState, distribute rewards via PST owners
  map(
    async (reward) => {
      const asset = head(keys(reward))
      const coins = head(values(reward))
      const { balances } = await SmartWeave.contracts.readContractState(asset)
      // apply balances
      map(r => {
        const addr = head(keys(r))
        const value = head(values(r))
        state.balances[addr] += value
        state.balances[state.creator] -= value
      }, pstAllocation(balances, coins))
    },
    rewards
  )
  // STEP 6 - flag all stamps as rewarded or flagged = true
  state.stamps = map(assoc('flagged', true), state.stamps)

  return { state }
}

async function stamp(state: StateInterface, action: ActionInterface) {
  const caller = action.caller;
  const stamps = state.stamps;
  const transactionId = action.input.transactionId
  ContractAssert(transactionId, 'transactionId is required!')

  // already stamped by user
  if (stamps[`${caller}:${transactionId}`]) {
    throw new ContractError("Already Stamped Asset!")
  }
  const vouch = "Ax_uXyLQBPZSQ15movzv9-O1mDo30khslqN64qD27Z8"
  // verify user
  const result = await SmartWeave.unsafeClient.api.post('graphql', {
    query: `
query {
  transactions(first: 1, owners: ["${vouch}"], tags: { name: "Vouch-For", values: ["${caller}"]}) {
    edges {
      node {
        id
        tags {
          name
          value
        }
      }
    }
  }
}
  `})

  const { node } = result?.data?.data?.transactions?.edges[0]
  const vouchFor = node.tags.find(t => t.name === 'Vouch-For')?.value
  // vouched
  if (vouchFor === caller) {
    state.stamps[`${caller}:${transactionId}`] = {
      timestamp: new Date(),
      asset: transactionId,
      address: caller,
      flagged: false // this flag is used to process rewards 
    }
  }

  return { state }
}

function transfer(state, action) {
  const balances = state.balances;
  const input = action.input;
  const caller = action.caller;

  const target = input.target;
  const quantity = input.qty;

  if (!Number.isInteger(quantity) || quantity === undefined) {
    throw new ContractError(
      "Invalid value for quantity. Must be an integer."
    );
  }
  if (!target) {
    throw new ContractError("No target specified.");
  }
  if (quantity <= 0 || caller === target) {
    throw new ContractError("Invalid token transfer.");
  }
  if (balances[caller] < quantity) {
    throw new ContractError(
      "Caller balance not high enough to send " + quantity + " token(s)."
    );
  }

  balances[caller] -= quantity;
  if (target in balances) {
    balances[target] += quantity;
  } else {
    balances[target] = quantity;
  }

  return { state };
}

async function readOutbox(state: StateInterface, action: ActionInterface): Promise<{ state: StateInterface }> {
  const input = action.input;

  // Ensure that a contract ID is passed
  ContractAssert(!!input.contract, "Missing contract to invoke");

  // Read the state of the foreign contract
  const foreignState = await SmartWeave.contracts.readContractState(
    input.contract
  );

  // Check if the foreign contract supports the foreign call protocol and compatible with the call
  ContractAssert(
    !!foreignState.foreignCalls,
    "Contract is missing support for foreign calls"
  );

  // Get foreign calls for this contract that have not been executed
  const calls: ForeignCallInterface[] = foreignState.foreignCalls.filter(
    (element: ForeignCallInterface) =>
      element.contract === SmartWeave.contract.id &&
      !state.invocations.includes(element.txID)
  );

  // Run all invocations
  let res: StateInterface = state;

  for (const entry of calls) {
    // Run invocation
    res =
      // @ts-expect-error
      (await handle(res, { caller: input.contract, input: entry.input }))
        .state;
    // Push invocation to executed invocations
    res.invocations.push(entry.txID);
  }

  return { state: res };
}

function evolve(state: StateInterface, action: ActionInterface) {
  if (state.canEvolve) {
    if (state.creator !== action.caller) {
      state.evolve = input.value
    }
  }
  return { state }
}

function balance(state: StateInterface, action: ActionInterface) {
  const balances = state.balances;
  const input = action.input;
  const caller = action.caller;

  let target;
  if (!input.target) {
    target = caller;
  } else {
    target = input.target;
  }
  const ticker = state.ticker;

  if (typeof target !== "string") {
    throw new ContractError("Must specify target to get balance for.");
  }
  if (typeof balances[target] !== "number") {
    throw new ContractError("Cannot get balance; target does not exist.");
  }

  return {
    result: {
      target,
      ticker,
      balance: balances[target],
    },
  };
}

/**
 * @param {number} bal
 * @param {number} total
 * @returns {number}
 */
function calcPCT(bal, total) {
  ContractAssert(typeof bal === 'number', 'Calculate method requires number')
  ContractAssert(typeof total === 'number', 'Calculate method requires number')
  const pct = Math.round(bal / total * 100)
  ContractAssert(typeof pct === 'number', 'Calculate method requires number')
  return pct
}