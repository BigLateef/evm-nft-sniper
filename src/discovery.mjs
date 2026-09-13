import { ethers } from 'ethers';

const PRICE_METHODS = [
  'mintPrice()',
  'publicPrice()',
  'publicSalePrice()',
  'mintCost()',
  'mintFee()',
  'publicMintPrice()',
  'cost()',
  'price()'
];
const TOKEN_METHODS = [
  'paymentToken()',
  'mintCurrency()',
  'currency()',
  'getPaymentToken()'
];
const STATE_METHODS = [
  'paused()',
  'isPaused()',
  'publicSaleActive()',
  'saleIsActive()',
  'mintingActive()',
  'publicSaleOpen()'
];

const CANDIDATES = [
  ['mint()', []],
  ['mint(uint256)', ['QUANTITY']],
  ['mint(address,uint256)', ['WALLET', 'QUANTITY']],
  ['mint(uint256,address)', ['QUANTITY', 'WALLET']],
  ['publicMint()', []],
  ['publicMint(uint256)', ['QUANTITY']],
  ['publicMint(address,uint256)', ['WALLET', 'QUANTITY']],
  ['claim()', []],
  ['claim(uint256)', ['QUANTITY']],
  ['claim(address,uint256)', ['WALLET', 'QUANTITY']],
  ['mintNFT()', []],
  ['mintNFT(uint256)', ['QUANTITY']]
];

function ifaceFor(signature, returns) {
  return new ethers.Interface([`function ${signature}${returns ? ` view returns (${returns})` : ''}`]);
}
function isZeroAddress(value) {
  return value === '0x0000000000000000000000000000000000000000';
}
async function readUint(provider, target, signature) {
  const iface = ifaceFor(signature, 'uint256');
  try {
    const result = await provider.call({ to: target, data: iface.encodeFunctionData(signature.split('(')[0], []) });
    return iface.decodeFunctionResult(signature.split('(')[0], result)[0];
  } catch { return null; }
}
async function readAddress(provider, target, signature) {
  const iface = ifaceFor(signature, 'address');
  try {
    const result = await provider.call({ to: target, data: iface.encodeFunctionData(signature.split('(')[0], []) });
    const value = iface.decodeFunctionResult(signature.split('(')[0], result)[0];
    return value && !isZeroAddress(value) ? value : null;
  } catch { return null; }
}
async function readBool(provider, target, signature) {
  const iface = ifaceFor(signature, 'bool');
  try {
    const result = await provider.call({ to: target, data: iface.encodeFunctionData(signature.split('(')[0], []) });
    return iface.decodeFunctionResult(signature.split('(')[0], result)[0];
  } catch { return null; }
}

function candidateArgs(shape, actor, quantity) {
  return shape.map(value => value === 'WALLET' ? actor : quantity);
}

// Discovery is deliberately conservative. It only selects a common public-mint
// shape after a read-only eth_call succeeds. It never sends a transaction and
// never treats a method name alone as proof that the mint is executable.
export async function discoverMintPlan({ provider, contract, actor, quantity = '1', configuredPriceNative }) {
  const states = [];
  for (const signature of STATE_METHODS) {
    const value = await readBool(provider, contract, signature);
    if (value !== null) states.push({ signature, value });
  }
  const pausedStates = new Set(['paused()', 'isPaused()']);
  const inactiveStates = states.filter(state => (pausedStates.has(state.signature) && state.value === true) || (!pausedStates.has(state.signature) && state.value === false));
  if (inactiveStates.length) {
    return { blocked: true, reason: `sale state is inactive (${inactiveStates.map(state => state.signature).join(', ')})` };
  }

  let priceWei = null;
  if (configuredPriceNative !== undefined && configuredPriceNative !== '') {
    try { priceWei = ethers.parseEther(String(configuredPriceNative)); }
    catch { return { blocked: true, reason: 'MINT_PRICE_NATIVE is not valid ETH/native-coin units' }; }
  }
  if (priceWei === null) {
    for (const signature of PRICE_METHODS) {
      const value = await readUint(provider, contract, signature);
      if (value !== null) { priceWei = value; break; }
    }
  }

  const paymentTokenAddress = (await Promise.all(TOKEN_METHODS.map(signature => readAddress(provider, contract, signature)))).find(Boolean) || null;
  if (paymentTokenAddress) {
    return {
      blocked: true,
      paymentMode: 'ERC20',
      paymentTokenAddress,
      paymentAmount: priceWei === null ? null : priceWei.toString(),
      reason: priceWei === null
        ? 'an ERC-20 payment token was discovered but its exact amount was not readable'
        : 'an ERC-20 payment token and amount were discovered; supply the mint signature before live execution'
    };
  }

  const value = priceWei ?? 0n;
  for (const [signature, shape] of CANDIDATES) {
    const iface = ifaceFor(signature);
    const name = signature.split('(')[0];
    const args = candidateArgs(shape, actor, quantity);
    let data;
    try { data = iface.encodeFunctionData(name, args); } catch { continue; }
    try {
      await provider.call({ from: actor, to: contract, data, value });
      return {
        blocked: false,
        mintFunction: signature,
        mintArgs: shape.map(value => value === 'WALLET' ? 'WALLET_ADDRESS' : 'MINT_QUANTITY'),
        mintPriceNative: ethers.formatEther(value),
        paymentMode: 'NATIVE',
        evidence: { source: 'read-only eth_call', priceSource: priceWei === null ? 'successful zero-value simulation' : 'price view/config' }
      };
    } catch { /* try the next known safe shape */ }
  }

  return { blocked: true, reason: priceWei === null ? 'no safe common mint shape simulated and no readable mint price found' : 'no safe common mint shape simulated at the discovered price' };
}
