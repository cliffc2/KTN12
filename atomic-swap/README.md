# Kaspa ↔ ETH Atomic Swap 

A production-grade Kaspa ↔ Ethereum atomic swap webapp based on the Stroemnet protocol.

## Overview

This is a non-custodial atomic swap application that enables trustless exchange between Kaspa (KAS) and Ethereum (ETH) using Hash Time Locked Contracts (HTLCs).

## Protocol

The Stroemnet protocol implements:
- **Intent → Proposal → HTLCA-first lock → HTLCB → Reveal**
- Alice locks on Kaspa first (griefing resistance)
- TB < TA with safety buffer (atomicity)
- Keys never leave browser (non-custodial)

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19 + TypeScript + Vite + Tailwind |
| State | Zustand + TanStack Query |
| Kaspa | rusty-kaspa (covpp-reset2) + SilverScript → WASM |
| ETH | viem + wagmi |
| P2P | libp2p (Gossipsub) |

## Project Structure

```
atomic-swap-app/
├── frontend/          # React + TypeScript webapp
│   ├── src/
│   │   ├── components/   # UI components
│   │   ├── stores/       # Zustand state
│   │   └── types.ts     # TypeScript types
│   └── package.json
├── wasm-kaspa/       # Rust WASM bindings for Kaspa
│   └── src/lib.rs
├── contracts/        # Smart contracts
│   ├── KaspaHTLC.sl  # SilverScript
│   └── ETHHTLC.sol   # Solidity
├── shared/           # Shared types & P2P
│   ├── types.ts
│   └── p2p.ts
└── README.md
```

## Getting Started

### Prerequisites

- Node.js 18+
- Rust (for WASM compilation)
- wasm-pack

### Build WASM

```bash
cd wasm-kaspa
wasm-pack build --target web --out-dir ../frontend/src/wasm-kaspa
```

### Run Frontend

```bash
cd frontend
npm run dev
```

### Build for Production

```bash
cd frontend
npm run build
```

## Security

- All atomic swap operations are trustless
- Private keys never leave the wallet
- HTLCs enforce atomic execution
- Griefing resistance via Alice-locks-first pattern

## References

- [Stroemnet Paper](https://github.com/stroemnet/paper)
- [rusty-kaspa](https://github.com/kaspanet/rusty-kaspa)
- [SilverScript](https://github.com/kaspanet/silverscript)
