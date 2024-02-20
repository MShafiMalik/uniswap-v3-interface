import { Connector } from '@web3-react/types'
import { coinbaseWallet, gnosisSafe, injected, network, walletConnect } from 'connectors'
import { CHAIN_INFO } from 'constants/chainInfo'
import { ALL_SUPPORTED_CHAIN_IDS, SupportedChainId } from 'constants/chains'

function getRpcUrls(chainId: SupportedChainId): [string] {
  switch (chainId) {
    case SupportedChainId.OPTIMISM:
      return ['https://mainnet.optimism.io']
    default:
  }
  // Our API-keyed URLs will fail security checks when used with external wallets.
  throw new Error('RPC URLs must use public endpoints')
}

export function isChainAllowed(connector: Connector, chainId: number) {
  switch (connector) {
    case injected:
    case coinbaseWallet:
    case walletConnect:
    case network:
    case gnosisSafe:
      return ALL_SUPPORTED_CHAIN_IDS.includes(chainId)
    default:
      return false
  }
}

export const switchChain = async (connector: Connector, chainId: number) => {
  if (!isChainAllowed(connector, chainId)) {
    throw new Error(`Chain ${chainId} not supported for connector (${typeof connector})`)
  } else if (connector === walletConnect || connector === network) {
    await connector.activate(chainId)
  } else {
    const info = CHAIN_INFO[chainId]
    const addChainParameter = {
      chainId,
      chainName: info.label,
      rpcUrls: getRpcUrls(chainId),
      nativeCurrency: info.nativeCurrency,
      blockExplorerUrls: [info.explorer],
    }
    await connector.activate(addChainParameter)
  }
}
