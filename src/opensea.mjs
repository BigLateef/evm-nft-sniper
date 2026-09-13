const CHAIN_SLUGS = {
  1: 'ethereum',
  10: 'optimism',
  137: 'matic',
  8453: 'base',
  42161: 'arbitrum',
  43114: 'avalanche',
  7777777: 'zora'
};

function safeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function openSeaConfig(env, chainId) {
  const apiKey = env.OPENSEA_API_KEY?.trim();
  const enabled = apiKey && env.OPENSEA_ENABLED !== '0';
  return {
    enabled: Boolean(enabled),
    apiKey,
    chain: env.OPENSEA_CHAIN?.trim() || CHAIN_SLUGS[chainId] || null,
    timeoutMs: Number(env.OPENSEA_TIMEOUT_MS || 2500)
  };
}

// OpenSea is enrichment only. A failure, stale response, or missing collection
// never blocks direct RPC inspection and never authorizes a transaction.
export async function enrichContract(config, contractAddress) {
  if (!config.enabled) return { source: 'disabled' };
  if (!config.chain) return { source: 'skipped', reason: 'OPENSEA_CHAIN is required for this chain' };
  const url = `https://api.opensea.io/api/v2/chain/${encodeURIComponent(config.chain)}/contract/${contractAddress}/nfts?limit=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'x-api-key': config.apiKey },
      signal: controller.signal
    });
    if (!response.ok) return { source: 'unavailable', status: response.status };
    const body = await response.json();
    const nft = Array.isArray(body.nfts) ? body.nfts[0] : null;
    return {
      source: 'opensea',
      collection: safeText(nft?.collection),
      name: safeText(nft?.name),
      identifier: safeText(nft?.identifier),
      tokenStandard: safeText(nft?.token_standard),
      contract: safeText(nft?.contract)
    };
  } catch (error) {
    return { source: 'unavailable', reason: error.name === 'AbortError' ? 'timeout' : 'request failed' };
  } finally {
    clearTimeout(timer);
  }
}
