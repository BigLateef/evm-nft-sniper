import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ethers } from 'ethers';
import { enrichContract, openSeaConfig } from './opensea.mjs';
import { discoverMintPlan } from './discovery.mjs';

const serviceName = 'evm-nft-sniper';
const healthServer = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: serviceName }));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
healthServer.listen(Number(process.env.PORT || 10000), '0.0.0.0');

// Configuration is environment-first. config.json is optional compatibility
// fallback only; operators can run this bot entirely from .env/secret vars.
const configPath = path.resolve(process.env.CONFIG_PATH || 'config.json');
const hasConfig = fs.existsSync(configPath);
const cfg = hasConfig ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
function envOrConfig(envName, configKey, fallback) {
  return process.env[envName] === undefined ? (cfg[configKey] ?? fallback) : process.env[envName];
}
function envJson(name, fallback) {
  if (process.env[name] === undefined || process.env[name].trim() === '') return fallback;
  try { return JSON.parse(process.env[name]); }
  catch { throw new Error(`${name} must contain valid JSON.`); }
}
function envBool(name, fallback) {
  return process.env[name] === undefined ? fallback : process.env[name] === '1' || process.env[name].toLowerCase() === 'true';
}

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)'
];
const ERC165_ABI = ['function supportsInterface(bytes4) view returns (bool)'];
const ERC721_INTERFACE = '0x80ac58cd';
const ERC1155_INTERFACE = '0xd9b67a26';

function requiredString(name, value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required.`);
  return value.trim();
}
function address(name, value) {
  if (!ethers.isAddress(value)) throw new Error(`${name} is not a valid EVM address.`);
  return ethers.getAddress(value);
}
function bps(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 10000) throw new Error(`${name} must be an integer from 0 to 10000.`);
  return n;
}

const configuredChainIdRaw = envOrConfig('CHAIN_ID', 'chainId', undefined);
const configuredChainId = configuredChainIdRaw === undefined || String(configuredChainIdRaw).trim() === ''
  ? null
  : Number(configuredChainIdRaw);
if (configuredChainId !== null && (!Number.isInteger(configuredChainId) || configuredChainId <= 0)) {
  throw new Error('CHAIN_ID must be a positive integer when supplied.');
}
const gasBufferBps = bps('GAS_BUFFER_BPS', envOrConfig('GAS_BUFFER_BPS', 'gasBufferBps', 2000));
const confirmations = Number(envOrConfig('CONFIRMATIONS', 'confirmations', 1));
if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 12) throw new Error('CONFIRMATIONS must be between 1 and 12.');

const dryRun = envBool('DRY_RUN', cfg.dryRun !== false);
if (process.env.LIVE_TRADING === '1' && dryRun) throw new Error('LIVE_TRADING=1 conflicts with DRY_RUN=1; refusing to start.');
const live = process.env.LIVE_TRADING === '1' && !dryRun;
const privateKey = process.env.SNIPER_PRIVATE_KEY?.trim();
if (live && !privateKey) throw new Error('Live mode requires SNIPER_PRIVATE_KEY locally.');

const httpUrl = process.env.RPC_HTTP_URL?.trim();
const wsUrl = process.env.RPC_WS_URL?.trim();
if (!httpUrl && !wsUrl) throw new Error('Set RPC_HTTP_URL or RPC_WS_URL in .env.');
// The RPC endpoint is authoritative. CHAIN_ID, when supplied, is only an
// assertion that protects against connecting a wallet to the wrong network.
const provider = wsUrl ? new ethers.WebSocketProvider(wsUrl) : new ethers.JsonRpcProvider(httpUrl);
const network = await provider.getNetwork();
const chainId = Number(network.chainId);
if (configuredChainId !== null && network.chainId !== BigInt(configuredChainId)) {
  throw new Error(`Wrong network: expected CHAIN_ID ${configuredChainId}, RPC reported ${network.chainId}.`);
}
const chainName = String(envOrConfig('CHAIN_NAME', 'chainName', `EVM-${chainId}`));

const wallet = privateKey ? new ethers.Wallet(privateKey, provider) : null;
const actorAddress = wallet?.address || process.env.SIMULATION_ADDRESS?.trim();
if (!actorAddress) throw new Error('Set SIMULATION_ADDRESS for dry-run or SNIPER_PRIVATE_KEY for live mode.');
const actor = address('wallet/simulation address', actorAddress);
if (live && actor !== wallet.address) throw new Error('Signer address could not be resolved safely.');
const openSea = openSeaConfig(process.env, chainId);

const globalTarget = {
  mintFunction: envOrConfig('MINT_FUNCTION', 'mintFunction', undefined),
  mintArgs: envJson('MINT_ARGS_JSON', cfg.mintArgs),
  mintQuantity: envOrConfig('MINT_QUANTITY', 'mintQuantity', '1'),
  paymentMode: envOrConfig('PAYMENT_MODE', 'paymentMode', undefined),
  mintPriceNative: envOrConfig('MINT_PRICE_NATIVE', 'mintPriceNative', undefined),
  paymentTokenAddress: envOrConfig('PAYMENT_TOKEN_ADDRESS', 'paymentTokenAddress', undefined),
  paymentAmount: envOrConfig('PAYMENT_AMOUNT', 'paymentAmount', undefined),
  approvalSpender: envOrConfig('APPROVAL_SPENDER', 'approvalSpender', undefined),
  autoApprove: envBool('AUTO_APPROVE', cfg.autoApprove !== false),
  autoDiscover: envBool('AUTO_DISCOVER_MINT', true),
  maxMintPriceNative: envOrConfig('MAX_MINT_PRICE_NATIVE', 'maxMintPriceNative', '0'),
  maxApprovalGasCostNative: envOrConfig('MAX_APPROVAL_GAS_COST_NATIVE', 'maxApprovalGasCostNative', '0'),
  maxTotalCostNative: envOrConfig('MAX_TOTAL_COST_NATIVE', 'maxTotalCostNative', '0'),
  tokenId: envOrConfig('TOKEN_ID', 'tokenId', '0')
};
function rawTargetInputs() {
  const jsonTargets = envJson('NFT_TARGETS_JSON', undefined);
  if (jsonTargets !== undefined) return jsonTargets;
  if (Array.isArray(cfg.targets) && cfg.targets.length > 0) return cfg.targets;
  if (Array.isArray(cfg.nftContractAddresses) && cfg.nftContractAddresses.length > 0) return cfg.nftContractAddresses;
  const envMany = process.env.TARGET_NFT_CONTRACT_ADDRESSES?.split(',').map(value => value.trim()).filter(Boolean);
  if (envMany?.length) return envMany;
  const envOneOrMany = process.env.TARGET_NFT_CONTRACT_ADDRESS?.split(',').map(value => value.trim()).filter(Boolean);
  if (envOneOrMany?.length) return envOneOrMany;
  return [cfg.nftContractAddress];
}
const rawTargets = rawTargetInputs();
if (!Array.isArray(rawTargets) || !rawTargets.length) throw new Error('Provide at least one NFT contract address.');
const targets = rawTargets.map((raw, index) => {
  const target = typeof raw === 'string' ? { nftContractAddress: raw } : raw;
  if (!target || typeof target !== 'object') throw new Error(`Target ${index + 1} must be an address or object.`);
  const targetChainId = Number(target.chainId ?? chainId);
  if (targetChainId !== chainId) throw new Error(`Target ${index + 1} chainId ${targetChainId} does not match RPC chain ${chainId}. Run separate instances per chain.`);
  const targetAddress = target.nftContractAddress || target.address;
  return { ...globalTarget, ...target, nftContractAddress: address(`target ${index + 1}`, targetAddress) };
});

async function feePolicy() {
  const feeData = await provider.getFeeData();
  const latest = await provider.getBlock('latest');
  let priorityFromRpc = feeData.maxPriorityFeePerGas;
  if (priorityFromRpc == null) {
    try { priorityFromRpc = BigInt(await provider.send('eth_maxPriorityFeePerGas', [])); } catch { priorityFromRpc = 0n; }
  }
  const priority = priorityFromRpc || 0n;
  const multiplier = 10000n + BigInt(gasBufferBps);
  if (latest?.baseFeePerGas != null) {
    const suggestedMax = feeData.maxFeePerGas ?? (latest.baseFeePerGas * 2n + priority);
    const maxFeePerGas = suggestedMax * multiplier / 10000n;
    const maxPriorityFeePerGas = priority * multiplier / 10000n;
    return {
      type: 'EIP1559',
      unitPrice: maxFeePerGas,
      override: { maxFeePerGas, maxPriorityFeePerGas: maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas }
    };
  }
  if (!feeData.gasPrice) throw new Error('RPC returned no usable dynamic fee data.');
  const gasPrice = feeData.gasPrice * multiplier / 10000n;
  return { type: 'LEGACY', unitPrice: gasPrice, override: { gasPrice } };
}
function nativeCost(gasLimit, unitPrice) { return gasLimit * unitPrice; }
function enforceTotalCap(label, total, maxTotal) {
  if (total > maxTotal) throw new Error(`${label} exceeds maxTotalCostNative: ${ethers.formatEther(total)} > ${ethers.formatEther(maxTotal)}.`);
  return total;
}

async function runTarget(target, index) {
  const label = `target-${index + 1}`;
  const nftAddress = target.nftContractAddress;
  const openSeaInfo = await enrichContract(openSea, nftAddress);
  console.log(JSON.stringify({ event: 'OPENSEA_ENRICHMENT', target: label, nftContract: nftAddress, ...openSeaInfo }));

  let mintFunction = target.mintFunction;
  let mintArgs = target.mintArgs;
  if (!mintFunction && !Array.isArray(mintArgs) && target.autoDiscover !== false) {
    const plan = await discoverMintPlan({
      provider,
      contract: nftAddress,
      actor,
      quantity: String(target.mintQuantity ?? '1'),
      configuredPriceNative: target.mintPriceNative
    });
    console.log(JSON.stringify({ event: 'MINT_DISCOVERY', target: label, nftContract: nftAddress, ...plan }));
    if (plan.blocked) throw new Error(`${label} mint discovery blocked: ${plan.reason}`);
    mintFunction = mintFunction || plan.mintFunction;
    mintArgs = mintArgs || plan.mintArgs;
    if (target.mintPriceNative === undefined) target.mintPriceNative = plan.mintPriceNative;
    if (target.paymentMode === undefined) target.paymentMode = plan.paymentMode;
  }
  mintFunction = requiredString(`${label}.mintFunction`, mintFunction);
  if (!mintFunction.includes('(')) throw new Error(`${label}.mintFunction must be a full ABI signature; guessing is blocked.`);
  if (!Array.isArray(mintArgs)) throw new Error(`${label}.mintArgs must be an array.`);
  const mintQuantity = String(target.mintQuantity ?? '1');
  const paymentMode = String(target.paymentMode || 'NATIVE').toUpperCase();
  if (!['NATIVE', 'ERC20'].includes(paymentMode)) throw new Error(`${label}.paymentMode must be NATIVE or ERC20.`);
  const autoApprove = target.autoApprove !== false;
  const maxMintPriceNative = ethers.parseEther(String(target.maxMintPriceNative ?? '0'));
  const maxApprovalGasCostNative = ethers.parseEther(String(target.maxApprovalGasCostNative ?? '0'));
  const maxTotalCostNative = ethers.parseEther(String(target.maxTotalCostNative ?? '0'));
  if (maxMintPriceNative <= 0n || maxApprovalGasCostNative <= 0n || maxTotalCostNative <= 0n) throw new Error(`${label} cost caps must be positive.`);

  const nftCode = await provider.getCode(nftAddress);
  if (nftCode === '0x') throw new Error(`${label} has no deployed contract code on chain ${chainId}.`);
  const supportsInterface = async interfaceId => {
    const iface = new ethers.Interface(ERC165_ABI);
    try {
      const result = await provider.call({ to: nftAddress, data: iface.encodeFunctionData('supportsInterface', [interfaceId]) });
      return iface.decodeFunctionResult('supportsInterface', result)[0] === true;
    } catch { return false; }
  };
  const [is721, is1155] = await Promise.all([supportsInterface(ERC721_INTERFACE), supportsInterface(ERC1155_INTERFACE)]);
  if (!is721 && !is1155) throw new Error(`${label} did not confirm ERC-721 or ERC-1155 support.`);

  const nftInterface = new ethers.Interface([`function ${mintFunction}`]);
  const mintFragment = nftInterface.fragments.find(fragment => fragment.type === 'function');
  if (!mintFragment) throw new Error(`${label} mintFunction could not be parsed.`);

  const paymentTokenAddress = paymentMode === 'ERC20'
    ? address(`${label}.paymentTokenAddress`, requiredString(`${label}.paymentTokenAddress`, target.paymentTokenAddress))
    : null;
  const approvalSpender = paymentMode === 'ERC20'
    ? address(`${label}.approvalSpender`, target.approvalSpender?.trim() || nftAddress)
    : null;
  if (paymentMode === 'ERC20' && approvalSpender !== nftAddress) throw new Error(`${label} approvalSpender must equal the NFT contract.`);
  const paymentToken = paymentTokenAddress ? new ethers.Contract(paymentTokenAddress, ERC20_ABI, provider) : null;
  const paymentDecimals = paymentToken ? Number(await paymentToken.decimals()) : 18;
  const paymentAmountUnits = paymentMode === 'ERC20'
    ? ethers.parseUnits(requiredString(`${label}.paymentAmount`, target.paymentAmount), paymentDecimals)
    : 0n;
  const nativeMintValue = paymentMode === 'NATIVE' ? ethers.parseEther(String(target.mintPriceNative ?? '0')) : 0n;
  if (nativeMintValue > maxMintPriceNative) throw new Error(`${label} native mint price exceeds its configured maximum.`);
  if (paymentMode === 'ERC20' && paymentAmountUnits <= 0n) throw new Error(`${label}.paymentAmount must be greater than zero.`);

  const substitutions = {
    WALLET_ADDRESS: actor,
    MINT_QUANTITY: mintQuantity,
    NFT_CONTRACT_ADDRESS: nftAddress,
    PAYMENT_AMOUNT: paymentAmountUnits.toString(),
    TOKEN_ID: String(target.tokenId ?? '0')
  };
  const resolvedMintArgs = mintArgs.map(value => typeof value === 'string' && Object.hasOwn(substitutions, value) ? substitutions[value] : value);
  let mintData;
  try { mintData = nftInterface.encodeFunctionData(mintFragment.name, resolvedMintArgs); }
  catch (error) { throw new Error(`${label}.mintArgs do not match its ABI: ${error.shortMessage || error.message}`); }

  const baseMintTx = { from: actor, to: nftAddress, data: mintData, value: nativeMintValue };
  const paymentAllowance = paymentToken ? await paymentToken.allowance(actor, approvalSpender) : paymentAmountUnits;
  const approvalNeeded = paymentToken && paymentAllowance < paymentAmountUnits;
  let approvalCost = 0n;

  if (paymentToken && approvalNeeded) {
    if (!autoApprove) throw new Error(`${label} needs allowance but autoApprove=false.`);
    const approvalInterface = new ethers.Interface(ERC20_ABI);
    const approvalData = approvalInterface.encodeFunctionData('approve', [approvalSpender, paymentAmountUnits]);
    const approvalTx = { from: actor, to: paymentTokenAddress, data: approvalData, value: 0n };
    const approvalGasLimit = await provider.estimateGas(approvalTx);
    const approvalFee = await feePolicy();
    approvalCost = nativeCost(approvalGasLimit, approvalFee.unitPrice);
    if (approvalCost > maxApprovalGasCostNative) throw new Error(`${label} exact approval gas exceeds its cap.`);
    console.log(JSON.stringify({ event: live ? 'APPROVAL_REQUIRED' : 'APPROVAL_WOULD_BE_REQUIRED', target: label, nftContract: nftAddress, token: paymentTokenAddress, spender: approvalSpender, exactAmount: paymentAmountUnits.toString(), gasLimit: approvalGasLimit.toString(), maxGasCostNative: ethers.formatEther(approvalCost) }));

    if (!live) {
      enforceTotalCap(`${label} approval preflight`, nativeMintValue + approvalCost, maxTotalCostNative);
      console.log(JSON.stringify({ event: 'DRY_RUN_BLOCKED_ON_APPROVAL', target: label, message: 'No approval or mint transaction was broadcast.' }));
      return { ok: false, blockedOnApproval: true };
    }
    const approvalTxResponse = await wallet.sendTransaction({ ...approvalTx, ...approvalFee.override, gasLimit: approvalGasLimit });
    const approvalReceipt = await approvalTxResponse.wait(confirmations);
    if (!approvalReceipt || Number(approvalReceipt.status) !== 1) throw new Error(`${label} exact approval transaction failed.`);
    const after = await paymentToken.allowance(actor, approvalSpender);
    if (after < paymentAmountUnits) throw new Error(`${label} approval receipt succeeded but exact allowance was not observed.`);
    approvalCost = approvalReceipt.gasUsed * (approvalReceipt.gasPrice ?? approvalFee.unitPrice);
    console.log(JSON.stringify({ event: 'APPROVAL_CONFIRMED', target: label, txHash: approvalReceipt.hash, actualCostNative: ethers.formatEther(approvalCost) }));
  }

  // Simulation occurs only after allowance state is correct. A quote or gas
  // estimate alone is never treated as readiness.
  try { await provider.call(baseMintTx); }
  catch (error) { throw new Error(`${label} exact mint simulation reverted: ${error.shortMessage || error.reason || error.message}`); }
  const mintGasLimit = await provider.estimateGas(baseMintTx);
  const fee = await feePolicy();
  const mintGasCost = nativeCost(mintGasLimit, fee.unitPrice);
  const totalCost = enforceTotalCap(`${label} mint execution`, nativeMintValue + mintGasCost + approvalCost, maxTotalCostNative);
  const nativeBalance = await provider.getBalance(actor);
  if (nativeBalance < totalCost) throw new Error(`${label} native balance is below the payment plus bounded gas requirement.`);
  if (paymentToken && await paymentToken.balanceOf(actor) < paymentAmountUnits) throw new Error(`${label} payment-token balance is insufficient.`);

  console.log(JSON.stringify({ event: 'PREFLIGHT_OK', mode: live ? 'LIVE' : 'DRY_RUN', target: label, chain: chainName, chainId, configPath: hasConfig ? configPath : '(environment only)', nftContract: nftAddress, standard: is721 ? 'ERC-721' : 'ERC-1155', mintFunction, mintQuantity, paymentMode, paymentToken: paymentTokenAddress, exactPayment: paymentMode === 'ERC20' ? ethers.formatUnits(paymentAmountUnits, paymentDecimals) : ethers.formatEther(nativeMintValue), gasType: fee.type, gasLimit: mintGasLimit.toString(), boundedGasUnitPrice: fee.unitPrice.toString(), mintGasCostNative: ethers.formatEther(mintGasCost), approvalGasCostNative: ethers.formatEther(approvalCost), totalCostNative: ethers.formatEther(totalCost), maxTotalCostNative: ethers.formatEther(maxTotalCostNative), wallet: actor }, null, 2));
  if (!live) return { ok: true, dryRun: true };

  const mintTx = await wallet.sendTransaction({ ...baseMintTx, ...fee.override, gasLimit: mintGasLimit });
  console.log(JSON.stringify({ event: 'MINT_SUBMITTED', target: label, nftContract: nftAddress, txHash: mintTx.hash }));
  const receipt = await mintTx.wait(confirmations);
  if (!receipt || Number(receipt.status) !== 1) throw new Error(`${label} mint transaction failed.`);
  console.log(JSON.stringify({ event: 'MINT_CONFIRMED', target: label, nftContract: nftAddress, txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), actualGasCostNative: ethers.formatEther(receipt.gasUsed * (receipt.gasPrice ?? fee.unitPrice)) }));
  return { ok: true, live: true };
}

console.log(JSON.stringify({ event: 'STARTUP', mode: live ? 'LIVE' : 'DRY_RUN', chain: chainName, chainId, configPath: hasConfig ? configPath : '(environment only)', targetCount: targets.length, nftContracts: targets.map(target => target.nftContractAddress), wallet: actor, autoApprove: targets.some(target => target.autoApprove !== false), gasBufferBps, openSeaEnrichment: openSea.enabled, openSeaChain: openSea.chain || '(not configured)' }, null, 2));
let succeeded = 0;
for (let index = 0; index < targets.length; index += 1) {
  try {
    const result = await runTarget(targets[index], index);
    if (result.ok) succeeded += 1;
  } catch (error) {
    console.log(JSON.stringify({ event: 'TARGET_BLOCKED', target: `target-${index + 1}`, nftContract: targets[index].nftContractAddress, reason: error.message }));
  }
}
console.log(JSON.stringify({ event: 'RUN_COMPLETE', targetCount: targets.length, succeeded, mode: live ? 'LIVE' : 'DRY_RUN' }));
