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

// SeaDrop V1 uses a public-stage struct stored on the SeaDrop contract, not
// on the NFT collection. The collection's allowed-SeaDrop list is the trust
// boundary: never call an arbitrary router or marketplace address.
const SEADROP_COLLECTION_ABI = [
  'function getAllowedSeaDrop() view returns (address[])'
];
const SEADROP_ABI = [
  'function getPublicDrop(address nftContract) view returns (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBPS, address feeRecipient)'
];
const SEADROP_MINT_SIGNATURE = 'mintPublic(address,tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBPS,address feeRecipient),uint256)';

function ifaceFor(signature, returns) {
  return new ethers.Interface([`function ${signature}${returns ? ` view returns (${returns})` : ''}`]);
}
function isZeroAddress(value) {
  return value === '0x0000000000000000000000000000000000000000';
}
function probeError(error) {
  return error?.shortMessage || error?.reason || error?.code || 'eth_call failed';
}
async function readOptional(provider, contract, signature, returns, args = []) {
  const iface = ifaceFor(signature, returns);
  const name = signature.split('(')[0];
  try {
    const data = iface.encodeFunctionData(name, args);
    const result = await provider.call({ to: contract, data });
    const decoded = iface.decodeFunctionResult(name, result);
    const value = decoded.length === 1 ? decoded[0] : decoded;
    return { status: 'OK', value: typeof value === 'bigint' ? value.toString() : value };
  } catch (error) {
    return { status: 'ERROR', error: probeError(error) };
  }
}
async function auditContract(provider, contract) {
  const audit = {};
  try {
    const code = await provider.getCode(contract);
    audit.codeBytes = code === '0x' ? 0 : (code.length - 2) / 2;
    audit.codeHash = code === '0x' ? null : ethers.keccak256(code);
  } catch (error) {
    audit.code = { status: 'ERROR', error: probeError(error) };
  }
  const supportsInterface = new ethers.Interface(['function supportsInterface(bytes4) view returns (bool)']);
  audit.erc165 = {};
  for (const [label, interfaceId] of [['ERC721', '0x80ac58cd'], ['ERC1155', '0xd9b67a26']]) {
    try {
      const data = supportsInterface.encodeFunctionData('supportsInterface', [interfaceId]);
      const result = await provider.call({ to: contract, data });
      audit.erc165[label] = { status: 'OK', value: supportsInterface.decodeFunctionResult('supportsInterface', result)[0] };
    } catch (error) {
      audit.erc165[label] = { status: 'ERROR', error: probeError(error) };
    }
  }
  const getters = [
    ['name()', 'string'],
    ['symbol()', 'string'],
    ['totalSupply()', 'uint256'],
    ['owner()', 'address'],
    ['getSeaDrop()', 'address'],
    ['seaDrop()', 'address'],
    ['implementation()', 'address'],
    ['getImplementation()', 'address'],
    ['proxiableUUID()', 'bytes32']
  ];
  audit.getters = {};
  for (const [signature, returns] of getters) audit.getters[signature] = await readOptional(provider, contract, signature, returns);
  try {
    const slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
    const raw = await provider.getStorage(contract, slot);
    audit.eip1967ImplementationSlot = raw && raw !== '0x' ? ethers.getAddress(`0x${raw.slice(-40)}`) : null;
  } catch (error) {
    audit.eip1967ImplementationSlot = { status: 'ERROR', error: probeError(error) };
  }
  return audit;
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
async function readAllowedSeaDrop(provider, contract) {
  const iface = new ethers.Interface(SEADROP_COLLECTION_ABI);
  try {
    const data = iface.encodeFunctionData('getAllowedSeaDrop', []);
    const result = await provider.call({ to: contract, data });
    const [addresses] = iface.decodeFunctionResult('getAllowedSeaDrop', result);
    if (!addresses || typeof addresses.filter !== 'function') {
      return { ok: false, addresses: [], error: 'getAllowedSeaDrop returned an unexpected ABI shape' };
    }
    return { ok: true, addresses: addresses.filter(value => value && !isZeroAddress(value)) };
  } catch (error) {
    return { ok: false, addresses: [], error: probeError(error) };
  }
}
async function readPublicDrop(provider, seaDrop, nftContract) {
  const iface = new ethers.Interface(SEADROP_ABI);
  try {
    const data = iface.encodeFunctionData('getPublicDrop', [nftContract]);
    const result = await provider.call({ to: seaDrop, data });
    const [drop] = iface.decodeFunctionResult('getPublicDrop', result);
    return {
      ok: true,
      drop: {
        mintPrice: BigInt(drop.mintPrice),
        startTime: BigInt(drop.startTime),
        endTime: BigInt(drop.endTime),
        maxTotalMintableByWallet: BigInt(drop.maxTotalMintableByWallet),
        feeBPS: Number(drop.feeBPS),
        feeRecipient: drop.feeRecipient
      }
    };
  } catch (error) {
    return { ok: false, error: probeError(error) };
  }
}

async function discoverSeaDropPlan({ provider, contract, quantity, configuredPriceNative }) {
  const allowedResult = await readAllowedSeaDrop(provider, contract);
  const seaDropProbe = {
    method: 'getAllowedSeaDrop() eth_call',
    status: allowedResult.ok ? (allowedResult.addresses.length ? 'OK' : 'EMPTY') : 'ERROR',
    allowedSeaDropCount: allowedResult.addresses.length,
    error: allowedResult.error || null
  };
  if (!allowedResult.ok || allowedResult.addresses.length === 0) {
    seaDropProbe.contractAudit = await auditContract(provider, contract);
    return { seaDropProbe };
  }
  const allowedSeaDrop = allowedResult.addresses;

  const latest = await provider.getBlock('latest');
  if (!latest || latest.timestamp == null) return { blocked: true, protocol: 'SeaDrop', seaDropProbe, reason: 'could not read latest block time for SeaDrop stage validation' };
  const now = BigInt(latest.timestamp);
  const requestedQuantity = BigInt(quantity);
  const futureStages = [];
  const expiredStages = [];
  const publicDropErrors = [];
  const zeroCodeAddresses = [];

  for (const seaDrop of allowedSeaDrop) {
    const code = await provider.getCode(seaDrop);
    if (code === '0x') {
      zeroCodeAddresses.push(seaDrop);
      continue;
    }
    const publicDropResult = await readPublicDrop(provider, seaDrop, contract);
    if (!publicDropResult.ok) {
      publicDropErrors.push({ seaDrop, error: publicDropResult.error });
      continue;
    }
    const drop = publicDropResult.drop;
    if (drop.mintPrice === 0n && drop.startTime === 0n && drop.endTime === 0n) continue;

    if (drop.startTime > now) {
      futureStages.push({ seaDrop, startTime: drop.startTime });
      continue;
    }
    if (drop.endTime !== 0n && now >= drop.endTime) {
      expiredStages.push({ seaDrop, endTime: drop.endTime });
      continue;
    }
    if (drop.maxTotalMintableByWallet !== 0n && requestedQuantity > drop.maxTotalMintableByWallet) {
      return { blocked: true, protocol: 'SeaDrop', seaDropAddress: seaDrop, reason: `quantity ${quantity} exceeds SeaDrop wallet limit ${drop.maxTotalMintableByWallet.toString()}` };
    }

    const mintPriceNative = ethers.formatEther(drop.mintPrice);
    if (configuredPriceNative !== undefined && configuredPriceNative !== '') {
      let configured;
      try { configured = ethers.parseEther(String(configuredPriceNative)); }
      catch { return { blocked: true, protocol: 'SeaDrop', reason: 'MINT_PRICE_NATIVE is not valid ETH/native-coin units' }; }
      if (configured !== drop.mintPrice) return { blocked: true, protocol: 'SeaDrop', seaDropAddress: seaDrop, reason: `configured mint price ${configuredPriceNative} does not match on-chain SeaDrop price ${mintPriceNative}` };
    }

    return {
      blocked: false,
      protocol: 'SeaDrop',
      seaDropAddress: seaDrop,
      executionTarget: seaDrop,
      mintFunction: SEADROP_MINT_SIGNATURE,
      mintArgs: ['NFT_CONTRACT_ADDRESS', 'SEADROP_PUBLIC_DROP', 'MINT_QUANTITY'],
      publicDrop: [drop.mintPrice.toString(), drop.startTime.toString(), drop.endTime.toString(), drop.maxTotalMintableByWallet.toString(), drop.feeBPS, drop.feeRecipient],
      mintPriceNative,
      paymentMode: 'NATIVE',
      evidence: { source: 'read-only SeaDrop getPublicDrop eth_call', stage: 'active', allowedSeaDropCount: allowedSeaDrop.length, seaDropProbe, publicDropErrors, zeroCodeAddresses }
    };
  }

  if (futureStages.length) {
    const next = futureStages.sort((a, b) => Number(a.startTime - b.startTime))[0];
    return { blocked: true, protocol: 'SeaDrop', seaDropAddress: next.seaDrop, seaDropProbe, reason: `SeaDrop public stage is upcoming at unix time ${next.startTime.toString()}`, evidence: { publicDropErrors, zeroCodeAddresses } };
  }
  if (expiredStages.length) return { blocked: true, protocol: 'SeaDrop', seaDropProbe, reason: 'all discovered SeaDrop public stages have ended', evidence: { publicDropErrors, zeroCodeAddresses } };
  return { blocked: true, protocol: 'SeaDrop', seaDropProbe, reason: 'SeaDrop support detected but no readable public stage was found', evidence: { publicDropErrors, zeroCodeAddresses } };
}

function candidateArgs(shape, actor, quantity) {
  return shape.map(value => value === 'WALLET' ? actor : quantity);
}

// Discovery is deliberately conservative. It only selects a common public-mint
// shape after a read-only eth_call succeeds. It never sends a transaction and
// never treats a method name alone as proof that the mint is executable.
export async function discoverMintPlan({ provider, contract, actor, quantity = '1', configuredPriceNative }) {
  let requestedQuantity;
  try { requestedQuantity = BigInt(quantity); }
  catch { return { blocked: true, reason: 'MINT_QUANTITY must be an integer' }; }
  if (requestedQuantity <= 0n) return { blocked: true, reason: 'MINT_QUANTITY must be greater than zero' };

  const seaDropPlan = await discoverSeaDropPlan({ provider, contract, quantity: String(requestedQuantity), configuredPriceNative });
  if (seaDropPlan?.blocked) return seaDropPlan;
  const seaDropProbe = seaDropPlan?.seaDropProbe || null;

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
    const args = candidateArgs(shape, actor, String(requestedQuantity));
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
        evidence: { source: 'read-only eth_call', priceSource: priceWei === null ? 'successful zero-value simulation' : 'price view/config', seaDropProbe }
      };
    } catch { /* try the next known safe shape */ }
  }

  return { blocked: true, reason: priceWei === null ? 'no safe common mint shape simulated and no readable mint price found' : 'no safe common mint shape simulated at the discovered price', evidence: { seaDropProbe } };
}
