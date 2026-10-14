# Onboarding: sign up → register onchain → Stripe-style keys

Built on Monad testnet (chainId 10143) during Metropolis, Oct 13 2026.

**ServiceRegistry:** [`0xdaeddd6a68bbea02c58dd0349797e8847c3fa797`](https://testnet.monadscan.com/address/0xdaeddd6a68bbea02c58dd0349797e8847c3fa797) ([deploy tx](https://testnet.monadscan.com/tx/0x8ec2e134564dda5a1a3dfd6ed0115aa770ab62c2a2650397a60feba9cf5ffc75))

## Flow (`/onboard`)
1. **Sign up with email (Privy)**, which creates an embedded wallet on Monad testnet. If `PRIVY_APP_ID` is unset, the page uses an injected wallet instead.
2. **Testnet gas drip** (`POST /api/registry/drip`) gives each address one 0.05 MON drip, capped, so new users can pay for their own tx.
3. **Register a service** onchain: `registerService(name, ratePerSec, payee, keccak256(sk))`. The browser generates the `sk_test_…` secret, shows it once with a copy button, and only its hash goes onchain. The publishable key is `pk_test_<serviceId>`.
4. **Register an agent identity** onchain: `registerAgent(name)`.
5. **Get charged per second:** an agent calls `GET /api/registry/terms/pk_test_<id>` to get x402 `stream-per-second` terms (payTo, ratePerSec, escrow), then opens a `StreamEscrow` stream at that rate.

## API
| endpoint | auth | purpose |
|---|---|---|
| `GET /api/registry/terms/:pk` | publishable key | discover per-second terms for a service |
| `GET /api/registry/me` | `Authorization: Bearer sk_test_…` + `X-Publishable-Key` | provider auth, checked against `verifyKey` onchain |
| `GET /api/registry/config` | none | registry address, ABI, Privy app id |
| `POST /api/registry/drip` | none (testnet, capped) | gas for new embedded wallets |

## Real testnet transactions (scripted e2e: `bun src/onboard-demo.ts`)
- registerService (service #0): https://testnet.monadscan.com/tx/0x4f2eab956e70292a1a347b1ada75bad6cdb8d0243447cbb6951cd63b54bf8dd3
- registerAgent: https://testnet.monadscan.com/tx/0xe42cd0a31629546c35db0cc92028be4f1eb83a5c3c88043d994d2f7fd49b6458
- registerService (service #1): https://testnet.monadscan.com/tx/0x9519d44e263394507b4cca943b27473f15f2b5457e7b1fb8f3da7b7cf492ae85
- agent opens stream to service #1 using terms from `pk_test_1`: https://testnet.monadscan.com/tx/0x0d060310920473db3df708635b728c33abb69cb97b920c50cb5be7e37269f9c1
- close after ~5s, 0.005 MON paid to the service and 0.015 refunded: https://testnet.monadscan.com/tx/0xf15413f1aecec81522ec8cb0a834c0bb1474c76446bea95ffd401c76986c1efb

## Run
```
# .env: existing vars plus REGISTRY_ADDRESS=0xdaed… and PRIVY_APP_ID=<your app id>
bun run build:onboard   # rebuilds web/onboard.js from web/src/onboard.tsx
bun src/server.ts       # open /onboard
```
In the Privy dashboard, add the live demo URL to **Allowed origins**.

## Demo script addition (about 30s, insert before the agent run)
"First a provider signs up. I log in with my email through Privy, which gives me an embedded wallet on Monad. I grab testnet gas, then register a GPU session at 0.001 MON per second. That's an onchain tx, here on monadscan. I get Stripe-style keys: a publishable `pk_test` for agents and a secret `sk_test` that's shown once. Only its hash lives onchain. An agent takes the pk, gets the per-second terms, opens a stream, and the meter runs."
