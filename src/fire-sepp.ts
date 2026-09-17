import { lifeExpectancyFactor } from "./irs-life-expectancy.ts"
import type { IrsLifeExpectancyTable } from "./irs-life-expectancy.ts"

// IRC Sec. 72(t)(2)(A)(iv): Substantially Equal Periodic Payments -- one of the exceptions to the
// 10% early-withdrawal penalty (see fire-dashboard.ts's EARLY_WITHDRAWAL_PENALTY_RATE for the
// straight "just accept the penalty" alternative this app also models). Two of the three
// IRS-approved methods (Rev. Rul. 2002-62, as amended by Notice 2022-6) are implemented here --
// the RMD method and the Fixed Amortization method. The third, Fixed Annuitization, needs an
// actuarial annuity table this app doesn't vendor and is left out; RMD and Amortization cover the
// two ends of the real tradeoff (lowest initial payment that moves with the market, vs. a level
// payment fixed for the life of the schedule) that most real elections choose between anyway.
export type SeppMethod = "rmd" | "amortization"

export const SEPP_METHODS: SeppMethod[] = ["rmd", "amortization"]

// Function to compute one year's distribution under the RMD method: this year's own account
// balance divided by this year's own life expectancy factor. Recalculated every year -- both the
// balance and the age (and so the factor) change annually, unlike Fixed Amortization below, which
// locks in a level payment once at the start. The most conservative of the two methods (lowest
// initial payment), and the only one where a market downturn actually lowers next year's required
// distribution along with it, rather than staying fixed regardless of what happened to the account.
export function rmdSeppAmount(balanceCents: number, age: number, table: IrsLifeExpectancyTable): number {
  return Math.round(balanceCents / lifeExpectancyFactor(age, table))
}

// Function to compute the level annual distribution under the Fixed Amortization method: the
// STARTING balance amortized over the life expectancy factor at the START age (both fixed for the
// life of the schedule), at a chosen "reasonable interest rate" -- IRC Sec. 72(t) guidance caps
// this at the greater of 5% or 120% of the federal mid-term rate, a published-monthly figure this
// app doesn't fetch live, so the rate is a plain hand-entered input, same as every other
// IRS-adjacent rate in this app. Same shape as a mortgage payment (calculateMortgagePayoff's own
// math in fire-analysis.ts), just solved for the level payment instead of a payoff date. The
// published methodology compounds annually for this calculation (unlike a mortgage's monthly
// compounding), and the life-expectancy factor -- a decimal, e.g. 36.2 -- is used directly as the
// term rather than rounded to a whole number of years.
export function amortizationSeppAmount(startingBalanceCents: number, startAge: number, annualInterestRate: number, table: IrsLifeExpectancyTable): number {
  const years = lifeExpectancyFactor(startAge, table)
  if (annualInterestRate === 0) {
    return Math.round(startingBalanceCents / years)
  }
  const payment = (startingBalanceCents * annualInterestRate) / (1 - Math.pow(1 + annualInterestRate, -years))
  return Math.round(payment)
}

// Function to compute an account's own SEPP distribution under whichever method it's configured
// for -- the one entry point callers (the account-state API, the UI) actually need, so neither has
// to know the two methods' own different argument shapes.
export function seppAmount(
  method: SeppMethod,
  balanceCents: number,
  age: number,
  interestRate: number | null,
  table: IrsLifeExpectancyTable,
): number {
  if (method === "rmd") {
    return rmdSeppAmount(balanceCents, age, table)
  }
  return amortizationSeppAmount(balanceCents, age, interestRate ?? 0, table)
}
