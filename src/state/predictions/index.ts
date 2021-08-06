import { createAsyncThunk, createSlice, PayloadAction } from '@reduxjs/toolkit'
import maxBy from 'lodash/maxBy'
import merge from 'lodash/merge'
import range from 'lodash/range'
import { BIG_ZERO } from 'utils/bigNumber'
import {
  Bet,
  LedgerData,
  HistoryFilter,
  PredictionsState,
  PredictionStatus,
  ReduxNodeRound,
  LeaderboardLoadingState,
  PredictionUser,
  LeaderboardFilter,
  State,
} from 'state/types'
import { getPredictionsContract } from 'utils/contractHelpers'
import { FUTURE_ROUND_COUNT, PAST_ROUND_COUNT, ROUND_BUFFER } from './config'
import {
  getBetHistory,
  transformBetResponse,
  makeFutureRoundResponse,
  makeRoundData,
  getRoundsData,
  getPredictionData,
  MarketData,
  getLedgerData,
  makeLedgerData,
  serializePredictionsRoundsResponse,
  getClaimStatuses,
  getPredictionUsers,
  transformUserResponse,
  LEADERBOARD_RESULTS_PER_PAGE,
  getPredictionUser,
} from './helpers'

const initialState: PredictionsState = {
  status: PredictionStatus.INITIAL,
  isLoading: false,
  isHistoryPaneOpen: false,
  isChartPaneOpen: false,
  isFetchingHistory: false,
  historyFilter: HistoryFilter.ALL,
  currentEpoch: 0,
  intervalSeconds: 300,
  minBetAmount: '10000000000000',
  bufferSeconds: 60,
  lastOraclePrice: BIG_ZERO.toJSON(),
  rounds: {},
  history: {},
  ledgers: {},
  claimableStatuses: {},
  leaderboard: {
    loadingState: LeaderboardLoadingState.INITIAL,
    filters: {
      address: null,
      orderBy: 'netBNB',
      timePeriod: 'all',
    },
    skip: 0,
    hasMoreResults: true,
    accountResult: null,
    results: [],
  },
}

// Thunks
type PredictionInitialization = Pick<
  PredictionsState,
  | 'status'
  | 'currentEpoch'
  | 'intervalSeconds'
  | 'minBetAmount'
  | 'rounds'
  | 'ledgers'
  | 'claimableStatuses'
  | 'bufferSeconds'
>
export const initializePredictions = createAsyncThunk<PredictionInitialization, string>(
  'predictions/intialize',
  async (account = null) => {
    // Static values
    const marketData = await getPredictionData()
    const epochs =
      marketData.currentEpoch > PAST_ROUND_COUNT
        ? range(marketData.currentEpoch, marketData.currentEpoch - PAST_ROUND_COUNT)
        : [marketData.currentEpoch]

    // Round data
    const roundsResponse = await getRoundsData(epochs)
    const initialRoundData: { [key: string]: ReduxNodeRound } = roundsResponse.reduce((accum, roundResponse) => {
      const reduxNodeRound = serializePredictionsRoundsResponse(roundResponse)

      return {
        ...accum,
        [reduxNodeRound.epoch.toString()]: reduxNodeRound,
      }
    }, {})

    const initializedData = {
      ...marketData,
      rounds: initialRoundData,
      ledgers: {},
      claimableStatuses: {},
    }

    if (!account) {
      return initializedData
    }

    // Bet data
    const ledgerResponses = await getLedgerData(account, epochs)

    // Claim statuses
    const claimableStatuses = await getClaimStatuses(account, epochs)

    return merge({}, initializedData, {
      ledgers: makeLedgerData(account, ledgerResponses, epochs),
      claimableStatuses,
    })
  },
)

export const fetchRound = createAsyncThunk<ReduxNodeRound, number>('predictions/fetchRound', async (epoch) => {
  const predictionContract = getPredictionsContract()
  const response = await predictionContract.rounds(epoch)
  return serializePredictionsRoundsResponse(response)
})

export const fetchRounds = createAsyncThunk<{ [key: string]: ReduxNodeRound }, number[]>(
  'predictions/fetchRounds',
  async (epochs) => {
    const rounds = await getRoundsData(epochs)
    return rounds.reduce((accum, round) => {
      if (!round) {
        return accum
      }

      const reduxNodeRound = serializePredictionsRoundsResponse(round)

      return {
        ...accum,
        [reduxNodeRound.epoch.toString()]: reduxNodeRound,
      }
    }, {})
  },
)

export const fetchMarketData = createAsyncThunk<MarketData>('predictions/fetchMarketData', async () => {
  const marketData = await getPredictionData()
  return marketData
})

export const fetchLedgerData = createAsyncThunk<LedgerData, { account: string; epochs: number[] }>(
  'predictions/fetchLedgerData',
  async ({ account, epochs }) => {
    const ledgers = await getLedgerData(account, epochs)
    return makeLedgerData(account, ledgers, epochs)
  },
)

export const fetchClaimableStatuses = createAsyncThunk<
  PredictionsState['claimableStatuses'],
  { account: string; epochs: number[] }
>('predictions/fetchClaimableStatuses', async ({ account, epochs }) => {
  const ledgers = await getClaimStatuses(account, epochs)
  return ledgers
})

export const fetchHistory = createAsyncThunk<{ account: string; bets: Bet[] }, { account: string; claimed?: boolean }>(
  'predictions/fetchHistory',
  async ({ account, claimed }) => {
    const response = await getBetHistory({
      user: account.toLowerCase(),
      claimed,
    })
    const bets = response.map(transformBetResponse)

    return { account, bets }
  },
)

// Leaderboard
export const filterLeaderboard = createAsyncThunk<{ results: PredictionUser[] }, { filters: LeaderboardFilter }>(
  'predictions/filterLeaderboard',
  async ({ filters }) => {
    const usersResponse = await getPredictionUsers({
      skip: 0,
      orderBy: filters.orderBy,
    })

    return { results: usersResponse.map(transformUserResponse) }
  },
)

export const fetchAccountResult = createAsyncThunk<PredictionUser, string>(
  'predictions/fetchAccountResult',
  async (account) => {
    const userResponse = await getPredictionUser(account)
    return transformUserResponse(userResponse)
  },
)

export const filterNextPageLeaderboard = createAsyncThunk<
  { results: PredictionUser[]; skip: number },
  number,
  { state: State }
>('predictions/filterNextPageLeaderboard', async (skip, { getState }) => {
  const state = getState()
  const usersResponse = await getPredictionUsers({
    skip,
    orderBy: state.predictions.leaderboard.filters.orderBy,
  })

  return { results: usersResponse.map(transformUserResponse), skip }
})

export const predictionsSlice = createSlice({
  name: 'predictions',
  initialState,
  reducers: {
    setLeaderboardFilter: (state, action: PayloadAction<Partial<LeaderboardFilter>>) => {
      state.leaderboard.filters = {
        ...state.leaderboard.filters,
        ...action.payload,
      }

      // Anytime we filters change we need to reset back to page 1
      state.leaderboard.skip = 0
      state.leaderboard.hasMoreResults = true
    },
    setPredictionStatus: (state, action: PayloadAction<PredictionStatus>) => {
      state.status = action.payload
    },
    setHistoryPaneState: (state, action: PayloadAction<boolean>) => {
      state.isHistoryPaneOpen = action.payload
      state.historyFilter = HistoryFilter.ALL
    },
    setChartPaneState: (state, action: PayloadAction<boolean>) => {
      state.isChartPaneOpen = action.payload
    },
    setHistoryFilter: (state, action: PayloadAction<HistoryFilter>) => {
      state.historyFilter = action.payload
    },
    setCurrentEpoch: (state, action: PayloadAction<number>) => {
      state.currentEpoch = action.payload
    },
    setLastOraclePrice: (state, action: PayloadAction<string>) => {
      state.lastOraclePrice = action.payload
    },
    markBetHistoryAsCollected: (state, action: PayloadAction<{ account: string; betId: string }>) => {
      const { account, betId } = action.payload

      if (state.history[account]) {
        const betIndex = state.history[account].findIndex((bet) => bet.id === betId)

        if (betIndex >= 0) {
          state.history[account][betIndex].claimed = true
        }
      }
    },
  },
  extraReducers: (builder) => {
    // Leaderboard filter
    builder.addCase(filterLeaderboard.pending, (state) => {
      // Only mark as loading if we come from IDLE. This allows initialization.
      if (state.leaderboard.loadingState === LeaderboardLoadingState.IDLE) {
        state.leaderboard.loadingState = LeaderboardLoadingState.LOADING
      }
    })
    builder.addCase(filterLeaderboard.fulfilled, (state, action) => {
      const { results } = action.payload

      state.leaderboard.loadingState = LeaderboardLoadingState.IDLE
      state.leaderboard.results = results

      if (results.length < LEADERBOARD_RESULTS_PER_PAGE) {
        state.leaderboard.hasMoreResults = false
      }
    })

    // Leaderboard account result
    builder.addCase(fetchAccountResult.pending, (state) => {
      state.leaderboard.loadingState = LeaderboardLoadingState.LOADING
    })
    builder.addCase(fetchAccountResult.fulfilled, (state, action) => {
      state.leaderboard.loadingState = LeaderboardLoadingState.IDLE
      state.leaderboard.accountResult = action.payload
    })

    // Leaderboard next page
    builder.addCase(filterNextPageLeaderboard.pending, (state) => {
      state.leaderboard.loadingState = LeaderboardLoadingState.LOADING
    })
    builder.addCase(filterNextPageLeaderboard.fulfilled, (state, action) => {
      const { results, skip } = action.payload

      state.leaderboard.loadingState = LeaderboardLoadingState.IDLE
      state.leaderboard.results = [...state.leaderboard.results, ...results]
      state.leaderboard.skip = skip

      if (results.length < LEADERBOARD_RESULTS_PER_PAGE) {
        state.leaderboard.hasMoreResults = false
      }
    })

    // Claimable statuses
    builder.addCase(fetchClaimableStatuses.fulfilled, (state, action) => {
      state.claimableStatuses = merge({}, state.claimableStatuses, action.payload)
    })

    // Ledger (bet) records
    builder.addCase(fetchLedgerData.fulfilled, (state, action) => {
      state.ledgers = merge({}, state.ledgers, action.payload)
    })

    // Get static market data
    builder.addCase(fetchMarketData.fulfilled, (state, action) => {
      const { status, currentEpoch, intervalSeconds, minBetAmount } = action.payload

      // If the round has change add a new future round
      if (state.currentEpoch !== currentEpoch) {
        const newestRound = maxBy(Object.values(state.rounds), 'epoch')
        const futureRound = makeFutureRoundResponse(
          newestRound.epoch + 1,
          newestRound.startTimestamp + intervalSeconds + ROUND_BUFFER,
        )

        state.rounds[futureRound.epoch] = futureRound
      }

      state.status = status
      state.currentEpoch = currentEpoch
      state.intervalSeconds = intervalSeconds
      state.minBetAmount = minBetAmount
    })

    // Initialize predictions
    builder.addCase(initializePredictions.fulfilled, (state, action) => {
      const { status, currentEpoch, intervalSeconds, bufferSeconds, rounds, claimableStatuses, ledgers } =
        action.payload
      const futureRounds: ReduxNodeRound[] = []
      const currentRound = rounds[currentEpoch]

      for (let i = 1; i <= FUTURE_ROUND_COUNT; i++) {
        futureRounds.push(makeFutureRoundResponse(currentEpoch + i, currentRound.startTimestamp + intervalSeconds * i))
      }

      return {
        ...state,
        status,
        currentEpoch,
        intervalSeconds,
        bufferSeconds,
        claimableStatuses,
        ledgers,
        rounds: merge({}, rounds, makeRoundData(futureRounds)),
      }
    })

    // Get single round
    builder.addCase(fetchRound.fulfilled, (state, action) => {
      state.rounds = merge({}, state.rounds, {
        [action.payload.epoch.toString()]: action.payload,
      })
    })

    // Get multiple rounds
    builder.addCase(fetchRounds.fulfilled, (state, action) => {
      state.rounds = merge({}, state.rounds, action.payload)
    })

    // Show History
    builder.addCase(fetchHistory.pending, (state) => {
      state.isFetchingHistory = true
    })
    builder.addCase(fetchHistory.rejected, (state) => {
      state.isFetchingHistory = false
    })
    builder.addCase(fetchHistory.fulfilled, (state, action) => {
      const { account, bets } = action.payload

      state.isFetchingHistory = false
      state.history[account] = bets
    })
  },
})

// Actions
export const {
  setChartPaneState,
  setCurrentEpoch,
  setHistoryFilter,
  setHistoryPaneState,
  setPredictionStatus,
  setLastOraclePrice,
  markBetHistoryAsCollected,
  setLeaderboardFilter,
} = predictionsSlice.actions

export default predictionsSlice.reducer
