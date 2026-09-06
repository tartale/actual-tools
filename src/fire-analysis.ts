import { formatUsd } from "./actual-helpers.ts"
import { isPortfolioCategory } from "./fire-accounts.ts"
import type { ClassifiedAccount } from "./fire-accounts.ts"
import { ALLOCATION_PRESET_RETURNS, WITHDRAWAL_TAX_RATES, effectiveAccessAge } from "./fire-dashboard.ts"
import type { CrossoverCardMeta, MonteCarloCardMeta } from "./fire-dashboard.ts"

export type FindingLevel = "fail" | "warn" | "info" | "ok"

export interface Finding {
  level: FindingLevel
  title: string
  detail: string[]
}

// One portfolio account reduced to just what the bridge projection needs. accessAge here is
// already Rule-of-55 adjusted (see effectiveAccessAge) -- this type deliberately has no notion of
// why an age is what it is.
export interface BridgeAccount {
  id: string
  name: string
  balance: number
  accessAge: number | null
  annualContribution: number
  returnMean: number
  withdrawalTaxRate: number
}

// Balances are whole cents, but the proportional split across pots is floating-point, so a year's
// funding check can land a hair under its target purely from rounding. Treat anything within a
// cent as funded -- without this, a scenario reports depleting a year earlier than it does.
const FUNDING_TOLERANCE_CENTS = 1

export interface BridgeResult {
  retirementAge: number
  accessibleAtRetirement: number
  lockedAtRetirement: number
  // The age at which the accessible pool can no longer fund a full year of spending, or null if it
  // funds every year through planToAge.
  depletionAge: number | null
  // The earliest age at which any money locked at retirement becomes available, or null if nothing
  // is locked. This is the first tranche, not necessarily all of it.
  nextUnlockAge: number | null
  // How much was still locked at the moment the reachable pool ran dry, and when the next tranche
  // of it would have opened. Access ages come in tiers (Rule of 55 at 55, everything else at 59),
  // so surviving past the *first* unlock proves nothing -- these two are what separate a real
  // bridging gap from having simply outspent a fully-unlocked portfolio.
  lockedAtDepletion: number
  nextUnlockAfterDepletion: number | null
}

// Function to project a single retirement-age scenario forward at mean returns with no
// volatility, tracking only whether the *accessible* pool can fund each year -- the same
// accessible-only funding rule Actual's own Monte Carlo engine applies, minus the randomness.
// That makes this a best case: a scenario that depletes here depletes in essentially every
// simulated run, which is what makes it worth reporting without re-implementing the simulation.
export function simulateBridge(
  accounts: readonly BridgeAccount[],
  currentAge: number,
  retirementAge: number,
  planToAge: number,
  annualSpend: number,
  inflationMean: number,
): BridgeResult {
  const balances = accounts.map((account) => account.balance)
  const isAccessible = (account: BridgeAccount, age: number): boolean => account.accessAge == null || age >= account.accessAge

  let accessibleAtRetirement = 0
  let lockedAtRetirement = 0
  let capturedSplit = false
  let depletionAge: number | null = null
  let lockedAtDepletion = 0
  let nextUnlockAfterDepletion: number | null = null

  const recordDepletion = (age: number): void => {
    depletionAge = age
    lockedAtDepletion = accounts.reduce(
      (total, account, index) => total + (isAccessible(account, age) ? 0 : (balances[index] as number)),
      0,
    )
    const pending = accounts.filter((account) => account.accessAge != null && account.accessAge > age).map((account) => account.accessAge as number)
    nextUnlockAfterDepletion = pending.length > 0 ? Math.min(...pending) : null
  }

  for (let age = currentAge; age < planToAge; age++) {
    if (!capturedSplit && age >= retirementAge) {
      accounts.forEach((account, index) => {
        if (isAccessible(account, age)) {
          accessibleAtRetirement += balances[index] as number
        } else {
          lockedAtRetirement += balances[index] as number
        }
      })
      capturedSplit = true
    }

    if (age < retirementAge) {
      accounts.forEach((account, index) => {
        balances[index] = (balances[index] as number) + account.annualContribution
      })
    } else {
      const spend = annualSpend * Math.pow(1 + inflationMean, age - currentAge)
      const reachable = accounts.map((account, index) => index).filter((index) => isAccessible(accounts[index] as BridgeAccount, age))
      const reachableTotal = reachable.reduce((total, index) => total + (balances[index] as number), 0)
      if (reachableTotal <= FUNDING_TOLERANCE_CENTS) {
        recordDepletion(age)
        break
      }
      const shares = new Map(reachable.map((index) => [index, (balances[index] as number) / reachableTotal]))
      // Withdrawals are taxed, so funding `spend` net needs a larger gross withdrawal. Each pot
      // contributes its balance-weighted share of that gross at its own rate.
      const netPerGross = reachable.reduce(
        (total, index) => total + (shares.get(index) as number) * (1 - (accounts[index] as BridgeAccount).withdrawalTaxRate),
        0,
      )
      const gross = netPerGross > 0 ? spend / netPerGross : Infinity
      if (gross > reachableTotal + FUNDING_TOLERANCE_CENTS) {
        recordDepletion(age)
        break
      }
      for (const index of reachable) {
        balances[index] = (balances[index] as number) - gross * (shares.get(index) as number)
      }
    }

    accounts.forEach((account, index) => {
      balances[index] = (balances[index] as number) * (1 + account.returnMean)
    })
  }

  const unlockAges = accounts
    .filter((account) => account.accessAge != null && account.accessAge > retirementAge)
    .map((account) => account.accessAge as number)

  return {
    retirementAge,
    accessibleAtRetirement,
    lockedAtRetirement,
    depletionAge,
    nextUnlockAge: unlockAges.length > 0 ? Math.min(...unlockAges) : null,
    lockedAtDepletion,
    nextUnlockAfterDepletion,
  }
}

// Function to turn a bridge projection into a reportable finding. A scenario that never depletes
// passes; one that depletes before its locked money unlocks is the real failure this whole
// analysis exists to catch; one that depletes after everything has already unlocked is a plain
// "you ran out", not a bridging problem.
export function bridgeFinding(result: BridgeResult, planToAge: number): Finding {
  const total = result.accessibleAtRetirement + result.lockedAtRetirement
  const share = total > 0 ? Math.round((result.accessibleAtRetirement / total) * 1000) / 10 : 0
  const split = [
    `${formatUsd(result.accessibleAtRetirement)} reachable at ${result.retirementAge} (${share}%)` +
      (result.lockedAtRetirement > 0 && result.nextUnlockAge != null
        ? `, ${formatUsd(result.lockedAtRetirement)} locked (earliest unlock at ${result.nextUnlockAge})`
        : ""),
  ]

  if (result.depletionAge === null) {
    return { level: "ok", title: `age ${result.retirementAge} -- funds every year through ${planToAge}.`, detail: split }
  }
  if (result.nextUnlockAfterDepletion != null) {
    const gap = result.nextUnlockAfterDepletion - result.depletionAge
    return {
      level: "fail",
      title: `age ${result.retirementAge} -- reachable money runs out at ${result.depletionAge}, ${gap} yr${gap === 1 ? "" : "s"} before the next ${formatUsd(result.lockedAtDepletion)} unlocks at ${result.nextUnlockAfterDepletion}.`,
      detail: [...split, "Even at mean returns with no volatility, so every simulated run fails here too."],
    }
  }
  return {
    level: "warn",
    title: `age ${result.retirementAge} -- runs out at ${result.depletionAge}, short of ${planToAge}.`,
    detail: [...split, "Everything has unlocked by then, so this is a shortfall, not a bridging problem."],
  }
}

// Function to build bridge inputs from classified accounts plus live balances and derived annual
// contributions, keyed by account id. Non-portfolio accounts (debt/cash/other) are dropped, and an
// account with no allocation preset contributes nothing to growth rather than silently assuming one.
export function toBridgeAccounts(
  accounts: readonly ClassifiedAccount[],
  balances: ReadonlyMap<string, number>,
  annualContributions: ReadonlyMap<string, number>,
): BridgeAccount[] {
  return accounts
    .filter((account) => isPortfolioCategory(account.category))
    .map((account) => ({
      id: account.id,
      name: account.name,
      balance: balances.get(account.id) ?? 0,
      accessAge: effectiveAccessAge(account),
      annualContribution: annualContributions.get(account.id) ?? 0,
      returnMean: account.allocationPreset === null ? 0 : ALLOCATION_PRESET_RETURNS[account.allocationPreset].mean,
      withdrawalTaxRate: WITHDRAWAL_TAX_RATES[account.taxTreatment],
    }))
}

// Function to compare the access ages actually stored in the live dashboard's Monte Carlo pots
// against what the current config would generate. A mismatch means the dashboard predates a
// config change and hasn't been re-imported -- the drift that makes the generate/import/edit cycle
// go wrong, and which nothing surfaces today.
export function detectPotDrift(
  metas: readonly MonteCarloCardMeta[],
  accounts: readonly ClassifiedAccount[],
): Finding[] {
  const portfolio = accounts.filter((account) => isPortfolioCategory(account.category))
  const expected = new Map(portfolio.map((account) => [account.id, effectiveAccessAge(account)]))

  const live = new Map<string, Set<number | null>>()
  for (const meta of metas) {
    for (const pot of meta.pots ?? []) {
      if (pot.accountId == null) {
        continue
      }
      const seen = live.get(pot.accountId) ?? new Set<number | null>()
      seen.add(pot.accessAge ?? null)
      live.set(pot.accountId, seen)
    }
  }

  const findings: Finding[] = []
  for (const account of portfolio) {
    const seen = live.get(account.id)
    if (seen === undefined) {
      findings.push({
        level: "warn",
        title: `${account.name} is classified ${account.category} but has no pot in the dashboard.`,
        detail: ["Added or reclassified since the last import; regenerate and re-import to include it."],
      })
      continue
    }
    const want = expected.get(account.id) ?? null
    const stale = [...seen].filter((age) => age !== want)
    if (stale.length > 0) {
      findings.push({
        level: "warn",
        title: `${account.name}: dashboard has access age ${stale.map((age) => age ?? "none").join("/")}, config would generate ${want ?? "none"}.`,
        detail: ["The dashboard predates this config change; regenerate and re-import to apply it."],
      })
    }
  }

  for (const accountId of live.keys()) {
    if (!expected.has(accountId)) {
      const named = accounts.find((account) => account.id === accountId)
      findings.push({
        level: "info",
        title: `${named?.name ?? accountId} has a pot in the dashboard but is no longer a portfolio account.`,
        detail: ["Regenerate and re-import to drop it from the simulation."],
      })
    }
  }

  return findings
}

// Function to compare the accounts the crossover widget counts as investable against the accounts
// the simulation actually models. The two widgets answer the same question from different account
// sets when these diverge, which is how the crossover ends up materially more optimistic than the
// Monte Carlo without anything saying so. Silent when no crossover widget exists to compare.
export function detectCrossoverMismatch(
  metas: readonly CrossoverCardMeta[],
  accounts: readonly ClassifiedAccount[],
): Finding[] {
  if (metas.length === 0) {
    return []
  }
  const nameFor = (accountId: string): string => accounts.find((account) => account.id === accountId)?.name ?? accountId
  const simulated = new Set(accounts.filter((account) => isPortfolioCategory(account.category)).map((account) => account.id))
  const counted = new Set(metas.flatMap((meta) => meta.incomeAccountIds ?? []))

  const findings: Finding[] = []
  for (const accountId of counted) {
    if (!simulated.has(accountId)) {
      findings.push({
        level: "warn",
        title: `${nameFor(accountId)} is counted by the crossover but is not in the simulation.`,
        detail: ["Classify it as a portfolio account so both widgets see it, or drop it from the widget -- as it stands they disagree."],
      })
    }
  }
  for (const accountId of simulated) {
    if (!counted.has(accountId)) {
      findings.push({
        level: "warn",
        title: `${nameFor(accountId)} is in the simulation but the crossover does not count it.`,
        detail: ["Regenerate and re-import so the crossover's account list matches what is simulated."],
      })
    }
  }
  return findings
}
