/** Minimal StreamEscrow ABI. Settlement is native MON: open locks a deposit, close pays rate × elapsed and refunds the rest. */
export const streamEscrowAbi = [
  {
    type: "function",
    name: "open",
    stateMutability: "payable",
    inputs: [
      { name: "payee", type: "address" },
      { name: "ratePerSec", type: "uint128" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "close",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isActive",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "owed",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "streams",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "payer", type: "address" },
      { name: "payee", type: "address" },
      { name: "ratePerSec", type: "uint128" },
      { name: "deposit", type: "uint128" },
      { name: "start", type: "uint64" },
      { name: "stoppedAt", type: "uint64" },
      { name: "claimed", type: "uint128" },
    ],
  },
  {
    type: "event",
    name: "Opened",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "payee", type: "address", indexed: true },
      { name: "ratePerSec", type: "uint256", indexed: false },
      { name: "deposit", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Closed",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "by", type: "address", indexed: true },
      { name: "paidToPayee", type: "uint256", indexed: false },
      { name: "refunded", type: "uint256", indexed: false },
    ],
  },
] as const;

export const OPEN_GAS = 200_000n;
export const CLOSE_GAS = 200_000n;
export const CLAIM_GAS = 120_000n;
