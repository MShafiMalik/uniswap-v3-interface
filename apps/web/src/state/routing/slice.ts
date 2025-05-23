import { createApi, fetchBaseQuery, FetchBaseQueryError } from '@reduxjs/toolkit/query/react'
import { Protocol } from '@uniswap/router-sdk'
import { sendAnalyticsEvent } from 'analytics'
import { isUniswapXSupportedChain } from 'constants/chains'
import ms from 'ms'
import { logSwapQuoteRequest } from 'tracing/swapFlowLoggers'
import { trace } from 'tracing/trace'

import {
  GetQuoteArgs,
  INTERNAL_ROUTER_PREFERENCE_PRICE,
  QuoteIntent,
  QuoteMethod,
  QuoteState,
  RouterPreference,
  RoutingConfig,
  TradeResult,
  URAQuoteResponse,
  URAQuoteType,
} from './types'
import { isExactInput, transformQuoteToTrade } from './utils'

const UNISWAP_API_URL = process.env.REACT_APP_UNISWAP_API_URL
const UNISWAP_GATEWAY_DNS_URL = process.env.REACT_APP_UNISWAP_GATEWAY_DNS
if (UNISWAP_API_URL === undefined || UNISWAP_GATEWAY_DNS_URL === undefined) {
  throw new Error(`UNISWAP_API_URL and UNISWAP_GATEWAY_DNS_URL must be defined environment variables`)
}

const CLIENT_PARAMS = {
  protocols: [Protocol.V2, Protocol.V3, Protocol.MIXED],
}

const protocols: Protocol[] = [Protocol.V2, Protocol.V3, Protocol.MIXED]

// routing API quote query params: https://github.com/Uniswap/routing-api/blob/main/lib/handlers/quote/schema/quote-schema.ts
const DEFAULT_QUERY_PARAMS = {
  protocols,
  // this should be removed once BE fixes issue where enableUniversalRouter is required for fees to work
  enableUniversalRouter: true,
}

function getQuoteLatencyMeasure(mark: PerformanceMark): PerformanceMeasure {
  performance.mark('quote-fetch-end')
  return performance.measure('quote-fetch-latency', mark.name, 'quote-fetch-end')
}

function getRoutingAPIConfig(args: GetQuoteArgs): RoutingConfig {
  const { account, tokenInChainId, uniswapXForceSyntheticQuotes, routerPreference } = args

  const uniswapx = {
    useSyntheticQuotes: uniswapXForceSyntheticQuotes,
    // Protocol supports swap+send to different destination address, but
    // for now recipient === swapper
    recipient: account,
    swapper: account,
    routingType: URAQuoteType.DUTCH_LIMIT,
  }

  const classic = {
    ...DEFAULT_QUERY_PARAMS,
    routingType: URAQuoteType.CLASSIC,
    recipient: account,
    enableFeeOnTransferFeeFetching: true,
  }

  if (
    // If the user has opted out of UniswapX during the opt-out transition period, we should respect that preference and only request classic quotes.
    routerPreference === RouterPreference.API ||
    routerPreference === INTERNAL_ROUTER_PREFERENCE_PRICE ||
    !isUniswapXSupportedChain(tokenInChainId)
  ) {
    return [classic]
  }

  return [uniswapx, classic]
}

export const routingApi = createApi({
  reducerPath: 'routingApi',
  baseQuery: fetchBaseQuery(),
  endpoints: (build) => ({
    getQuote: build.query<TradeResult, GetQuoteArgs>({
      async onQueryStarted(args: GetQuoteArgs, { queryFulfilled }) {
        trace(
          'quote',
          async ({ setTraceError, setTraceStatus }) => {
            try {
              await queryFulfilled
            } catch (error: unknown) {
              if (error && typeof error === 'object' && 'error' in error) {
                const queryError = (error as Record<'error', FetchBaseQueryError>).error
                if (typeof queryError.status === 'number') {
                  setTraceStatus(queryError.status)
                }
                setTraceError(queryError)
              } else {
                throw error
              }
            }
          },
          {
            data: {
              ...args,
              isPrice: args.routerPreference === INTERNAL_ROUTER_PREFERENCE_PRICE,
              isAutoRouter: args.routerPreference === RouterPreference.API,
            },
          }
        )
      },
      async queryFn(args, _api, _extraOptions, fetch) {
        logSwapQuoteRequest(args.tokenInChainId, args.routerPreference, false)
        const quoteStartMark = performance.mark(`quote-fetch-start-${Date.now()}`)
        try {
          const {
            tokenInAddress: tokenIn,
            tokenInChainId,
            tokenOutAddress: tokenOut,
            tokenOutChainId,
            amount,
            tradeType,
            sendPortionEnabled,
            gatewayDNSUpdateEnabled,
          } = args

          const requestBody = {
            tokenInChainId,
            tokenIn,
            tokenOutChainId,
            tokenOut,
            amount,
            sendPortionEnabled,
            type: isExactInput(tradeType) ? 'EXACT_INPUT' : 'EXACT_OUTPUT',
            intent:
              args.routerPreference === INTERNAL_ROUTER_PREFERENCE_PRICE ? QuoteIntent.Pricing : QuoteIntent.Quote,
            configs: getRoutingAPIConfig(args),
          }

          let response = await fetch({
            method: 'GET',
            url: `https://q80a8rx8l9.execute-api.eu-west-1.amazonaws.com/prod/quote?tokenInAddress=${tokenIn}&tokenInChainId=${tokenInChainId}&tokenOutAddress=${tokenOut}&tokenOutChainId=${tokenOutChainId}&amount=${amount}&type=exactIn`,
          })

          if (response.error) {
            try {
              // cast as any here because we do a runtime check on it being an object before indexing into .errorCode
              const errorData = response.error.data as { errorCode?: string; detail?: string }
              // NO_ROUTE should be treated as a valid response to prevent retries.
              if (
                typeof errorData === 'object' &&
                (errorData?.errorCode === 'NO_ROUTE' || errorData?.detail === 'No quotes available')
              ) {
                sendAnalyticsEvent('No quote received from routing API', {
                  requestBody,
                  response,
                  routerPreference: args.routerPreference,
                })
                return {
                  data: { state: QuoteState.NOT_FOUND, latencyMs: getQuoteLatencyMeasure(quoteStartMark).duration },
                }
              }
            } catch {
              throw response.error
            }
          }

          const quoteResponse = {
            quote : response.data,
            allQuotes : [response.data],
            routing :  URAQuoteType.CLASSIC
          };

          const uraQuoteResponse = quoteResponse as URAQuoteResponse;
          const tradeResult = await transformQuoteToTrade(args, uraQuoteResponse, QuoteMethod.ROUTING_API)
          return { data: { ...tradeResult, latencyMs: getQuoteLatencyMeasure(quoteStartMark).duration } }
        } catch (error: any) {
          console.warn(
            `GetQuote failed on Unified Routing API, falling back to client: ${
              error?.message ?? error?.detail ?? error
            }`
          )
        }

        try {
          const { getRouter, getClientSideQuote } = await import('lib/hooks/routing/clientSideSmartOrderRouter')
          const router = getRouter(args.tokenInChainId)
          const quoteResult = await getClientSideQuote(args, router, CLIENT_PARAMS)
          if (quoteResult.state === QuoteState.SUCCESS) {
            const trade = await transformQuoteToTrade(args, quoteResult.data, QuoteMethod.CLIENT_SIDE_FALLBACK)
            return {
              data: { ...trade, latencyMs: getQuoteLatencyMeasure(quoteStartMark).duration },
            }
          } else {
            return { data: { ...quoteResult, latencyMs: getQuoteLatencyMeasure(quoteStartMark).duration } }
          }
        } catch (error: any) {
          console.warn(`GetQuote failed on client: ${error}`)
          return {
            error: { status: 'CUSTOM_ERROR', error: error?.detail ?? error?.message ?? error },
          }
        }
      },
      keepUnusedDataFor: ms(`10s`),
      extraOptions: {
        maxRetries: 0,
      },
    }),
  }),
})

export const { useGetQuoteQuery } = routingApi
export const useGetQuoteQueryState = routingApi.endpoints.getQuote.useQueryState
