// StreamEscrow v2 ABI for the server and agent. Kept in-repo so a Vercel
// build does not need Foundry's `contracts/out` artifact. Bytecode for
// `src/deploy.ts` still comes from that artifact after `forge build`.
export const escrowAbi = [
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
    name: "owed",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
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
    name: "streams",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    outputs: [{
      name: "",
      type: "tuple",
      internalType: "struct StreamEscrow.Stream",
      components: [
        { name: "payer", type: "address", internalType: "address" },
        { name: "payee", type: "address", internalType: "address" },
        { name: "ratePerSec", type: "uint128", internalType: "uint128" },
        { name: "deposit", type: "uint128", internalType: "uint128" },
        { name: "start", type: "uint64", internalType: "uint64" },
        { name: "stoppedAt", type: "uint64", internalType: "uint64" },
        { name: "claimed", type: "uint128", internalType: "uint128" },
      ],
    }],
  },
  {
    type: "event",
    name: "Opened",
    anonymous: false,
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
    anonymous: false,
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "by", type: "address", indexed: true },
      { name: "paidToPayee", type: "uint256", indexed: false },
      { name: "refunded", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Claimed",
    anonymous: false,
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;
