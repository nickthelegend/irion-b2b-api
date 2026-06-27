// Pure underwriting math — credit score + limit derived from REAL on-ledger
// signals (treasury depth + on-time repayment history). No ledger calls, so it's
// unit-testable in isolation. These replace the old caller-supplied / hardcoded
// scores: a borrower can no longer set their own score — it is computed here.
//
// Used by Ledger.underwrite (business working capital) and
// Ledger.ensureConsumerCredit (the consumer BNPL "pay-never" starter line).

/** Business score: base 550 + treasury-depth uplift (≤250) + repayment history (≤120). */
export function businessScore(treasuryTotal: number, repayments: number): number {
  const depthPts = Math.min(250, Math.floor(treasuryTotal / 40))
  const historyPts = Math.min(120, repayments * 15)
  return Math.max(500, Math.min(850, 550 + depthPts + historyPts))
}

/** Business limit: scaled by score against half the treasury (floor $50). */
export function businessLimit(treasuryTotal: number, score: number): number {
  return Math.max(50, Math.round((score / 850) * Math.max(treasuryTotal * 0.5, 200)))
}

/** Consumer BNPL score: approved at the unsecured gate (600) as a starter line,
 * lifted by real signals. Capped at 850. */
export function consumerScore(treasuryTotal: number, repayments: number): number {
  const depthPts = Math.min(200, Math.floor(treasuryTotal / 40))
  const historyPts = Math.min(120, repayments * 15)
  return Math.min(850, 600 + depthPts + historyPts)
}

/** Consumer starter line: $1000 + half the treasury. */
export function consumerLimit(treasuryTotal: number): number {
  return Math.max(1000, 1000 + Math.round(treasuryTotal * 0.5))
}
