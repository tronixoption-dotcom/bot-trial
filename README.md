# One-Tick Trade Guard

12. STRICT CONTRACT DURATION — 1 TICK ONLY

The bot must execute all OVER 2 and UNDER 7 trades with a contract duration of EXACTLY 1 TICK.

Mandatory requirements:

- Contract duration: 1

- Duration unit: "t" (ticks)

- OVER 2: 1 tick only.

- UNDER 7: 1 tick only.

- The duration must never increase or decrease, even during recovery.

- The user must not be able to accidentally change the contract duration.

- Every contract proposal must be validated to confirm its duration is exactly 1 tick before purchase.

If the API returns a proposal with any duration other than 1 tick, the bot must reject it immediately.

Stake is fixed at the configured base amount by default. If "Double stake after loss" is explicitly enabled, the next trade after a loss uses twice the base stake; this does not compound after consecutive losses. The selected stake must be covered by the account balance and validated before purchase.

Every trade must use a duration of exactly 1 tick and satisfy the configured entry conditions before execution.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/93e64da5-7ac0-4f1a-a788-209488532333).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
