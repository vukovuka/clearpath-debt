import { useEffect, useMemo, useState } from "react";
import "./App.css";
import logo from "./assets/logo.png";

const STORAGE_KEY = "clearpath_debt_inputs_v1";
const STRIPE_DONATE_URL = "https://buy.stripe.com/test_fZucN5d2x2KC9P8alr7wA00";

const DEFAULTS = {
  debts: [
    { id: "d1", name: "Credit Card", type: "credit_card", balance: 4000, interest_rate: 29.99 },
    { id: "d2", name: "Personal Loan", type: "loan", balance: 6000, interest_rate: 7.99 },
  ],
  paycheques: [{ amount: 5300 }],
  bills: [{ amount: 2700 }],
  monthlyPayment: 1500,

  goal: "speed", // speed | interest | stick
  paymentMode: "fixed", // fixed | schedule

  // schedule rows now support allocations:
  // allocations: { [debtId]: number }  (A = total to that debt, incl minimum)
  paymentSchedule: [
    { month: 1, amount: 1500, allocations: {} },
    { month: 2, amount: 1500, allocations: {} },
    { month: 3, amount: 1500, allocations: {} },
    { month: 4, amount: 1500, allocations: {} },
    { month: 5, amount: 1500, allocations: {} },
    { month: 6, amount: 1500, allocations: {} },
  ],
};

function makeId(prefix = "d") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function formatUpdated(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

const emptyDebt = () => ({
  id: makeId("d"),
  name: "",
  type: "credit_card",
  balance: "",
  interest_rate: "",
  min_override_enabled: false,
  min_override_amount: "",
});

function clampNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function keepBlankOrNumber(v, fallback = 0) {
  if (v === "" || v === null || v === undefined) return "";
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}


function round2(n) {
  return Math.round((clampNumber(n, 0) + Number.EPSILON) * 100) / 100;
}

function formatMoney(n) {
  const x = clampNumber(n, 0);
  return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Minimum payment estimator (monthly).
 * Heuristics; issuers vary. We allow Advanced override.
 */
function estimateMinimumPayment(debt) {
  const balance = Math.max(0, clampNumber(debt.balance, 0));
  const apr = Math.max(0, clampNumber(debt.interest_rate, 0));
  const r = (apr / 100) / 12;
  const interestOnly = balance * r;

  const floor = 25;

  if (debt.type === "credit_card") {
    const pctOfBalance = 0.02 * balance;
    const interestPlusPrincipal = interestOnly + 0.01 * balance;
    return Math.max(floor, pctOfBalance, interestPlusPrincipal);
  }

  if (debt.type === "loc") {
    return Math.max(floor, interestOnly);
  }

  if (debt.type === "loan") {
    const principalPortion = balance / 36;
    return Math.max(floor, interestOnly + principalPortion);
  }

  const pct = 0.015 * balance;
  return Math.max(floor, interestOnly + 0.005 * balance, pct);
}

function computeMonthlyMinimumDynamic(debt, currentBalance) {
  // Use the same estimator but based on current balance
  const est = estimateMinimumPayment({
    type: debt.type,
    balance: currentBalance,
    interest_rate: debt.interest_rate,
  });

  // Apply override floor if enabled
  if (debt.min_floor_enabled) {
    return Math.max(est, debt.min_floor);
  }
  return est;
}


/**
 * Compute the "required" per-debt payments for a given month in schedule mode.
 * A = user enters TOTAL payment to that debt (includes minimum).
 * So required = max(minimum, userAllocation) for each active debt.
 *
 * Returns:
 *  - requiredByDebtId: { [id]: number }
 *  - requiredSum: number
 *  - overBudget: boolean
 *  - unassigned: monthlyPayment - requiredSum (>=0 if feasible)
 */
function computeScheduleMonthRequiredPayments(debts, scheduleRow, monthlyPayment) {
  const mPay = Math.max(0, round2(clampNumber(monthlyPayment, 0)));
  const alloc = scheduleRow?.allocations || {};

  const requiredByDebtId = {};
  let requiredSum = 0;

  for (const d of debts) {
    const bal = Math.max(0, clampNumber(d.balance, 0));
    if (bal <= 0) continue;

    const min = Math.max(0, clampNumber(d.minimum_payment, 0));
    const user = Math.max(0, clampNumber(alloc[d.id], 0));
    const required = round2(Math.max(min, user));

    requiredByDebtId[d.id] = required;
    requiredSum = round2(requiredSum + required);
  }

  const overBudget = requiredSum - mPay > 0.000001;
  const unassigned = round2(Math.max(0, mPay - requiredSum));

  return { requiredByDebtId, requiredSum, overBudget, unassigned };
}

/**
 * Strategy simulator (monthly).
 * - Accrue interest monthly.
 * - In FIXED mode:
 *    pay minimums, then strategy gets extra.
 * - In SCHEDULE mode:
 *    pay required per-debt payments first (max(min, allocation)),
 *    then strategy gets any unassigned remainder.
 *
 * paymentPlanFn(monthIndex1Based) returns:
 *  {
 *    monthlyPayment: number,
 *    requiredByDebtId?: { [id]: number },
 *    requiredSum?: number,
 *    overBudget?: boolean,
 *    unassigned?: number
 *  }
 */
function simulateStrategy(strategy, debts, paymentPlanFn) {
  const MAX_MONTHS = 600;

  const state = debts.map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    apr: Math.max(0, clampNumber(d.interest_rate, 0)),
    r: (Math.max(0, clampNumber(d.interest_rate, 0)) / 100) / 12,
    balance: round2(Math.max(0, clampNumber(d.balance, 0))),
    interestPaid: 0,
    payoffMonth: null,

    // override is a FLOOR (never below)
    min_floor_enabled: !!d.min_floor_enabled,
    min_floor: round2(Math.max(0, clampNumber(d.min_floor, 0))),
  }));

  const allPaid = () => state.every((d) => d.balance <= 0.000001);

  const pickTargetId = () => {
    const active = state.filter((d) => d.balance > 0.000001);
    if (!active.length) return null;

    if (strategy === "snowball") {
      active.sort((a, b) => a.balance - b.balance || b.apr - a.apr);
    } else {
      active.sort((a, b) => b.apr - a.apr || a.balance - b.balance);
    }
    return active[0]?.id ?? null;
  };

  let totalInterest = 0;
  const timeline = [];

  for (let month = 1; month <= MAX_MONTHS; month++) {
    if (allPaid()) break;

    const plan = paymentPlanFn(month);
    const paymentThisMonth = Math.max(
      0,
      round2(clampNumber(plan?.monthlyPayment, 0))
    );

    if (plan?.overBudget) {
      timeline.push({
        month,
        paymentThisMonth,
        requiredSum: round2(plan?.requiredSum ?? 0),
        unassigned: round2(plan?.unassigned ?? 0),
        interestThisMonth: 0,
        totalInterestToDate: totalInterest,
        minPaid: 0,
        directedPaid: 0,
        extraPaid: 0,
        totalRemaining: round2(
          state.reduce((sum, d) => sum + Math.max(0, d.balance), 0)
        ),
        targetDebtId: null,
        targetDebtName: null,
        appliedToTargetThisMonth: 0,
        extraAppliedToTarget: 0,
        extraByDebtId: {},
        invalid: true,
      });
      break;
    }

    // 1) accrue interest
    let interestThisMonthTotal = 0;
    for (const d of state) {
      if (d.balance <= 0.000001) continue;
      const interest = round2(d.balance * d.r);
      d.balance = round2(d.balance + interest);
      d.interestPaid = round2(d.interestPaid + interest);
      interestThisMonthTotal = round2(interestThisMonthTotal + interest);
    }
    totalInterest = round2(totalInterest + interestThisMonthTotal);

    // 2) compute dynamic minimums for THIS month (after interest)
    const dynamicMinByDebtId = {};
    for (const d of state) {
      if (d.balance <= 0.000001) continue;

      dynamicMinByDebtId[d.id] = round2(
        computeMonthlyMinimumDynamic(
          {
            type: d.type,
            interest_rate: d.apr,
            min_floor_enabled: d.min_floor_enabled,
            min_floor: d.min_floor,
          },
          d.balance
        )
      );
    }

    // 3) pay required (schedule allocations, with mins enforced) OR minimums (fixed)
    let remaining = round2(paymentThisMonth);
    let minPaidTotal = 0;
    let directedPaidTotal = 0;

    const requiredByDebtId = plan?.requiredByDebtId || null;

    // Track total paid per debt this month (directed + extra) for a truthful "target"
    const paidThisMonthByDebtId = {};

    // Compute the REAL required sum for this month:
    // - fixed: sum(dynamic mins)
    // - schedule: sum(max(allocation, dynamic min)) for each debt
    let requiredSumThisMonth = 0;

    for (const d of state) {
      if (d.balance <= 0.000001) continue;

      const dynamicMin = dynamicMinByDebtId[d.id] || 0;
      const alloc = requiredByDebtId ? Math.max(0, clampNumber(requiredByDebtId[d.id], 0)) : 0;

      const intended = requiredByDebtId ? Math.max(alloc, dynamicMin) : dynamicMin;

      requiredSumThisMonth = round2(requiredSumThisMonth + intended);

      const pay = round2(Math.min(intended, d.balance, remaining));
      if (pay > 0) {
        paidThisMonthByDebtId[d.id] = round2((paidThisMonthByDebtId[d.id] || 0) + pay);

        const minPortion = Math.min(dynamicMin, pay);
        minPaidTotal = round2(minPaidTotal + minPortion);

        if (requiredByDebtId) directedPaidTotal = round2(directedPaidTotal + pay);

        d.balance = round2(d.balance - pay);
        remaining = round2(remaining - pay);

        if (d.balance <= 0.000001 && d.payoffMonth == null) d.payoffMonth = month;
      }
    }

    // If user allocations/required exceed payment, requiredSumThisMonth can be > paymentThisMonth.
    // In that case, the month is effectively underfunded. We'll reflect that with unassigned = 0.
    const unassignedThisMonth = round2(Math.max(0, paymentThisMonth - requiredSumThisMonth));

    // 4) extra targeting (strategy controls whatever remains)
    const extraByDebtId = {};
    let extraPaidTotal = 0;

    while (remaining > 0.000001 && !allPaid()) {
      const targetId = pickTargetId();
      if (targetId == null) break;

      const t = state.find((x) => x.id === targetId);
      if (!t || t.balance <= 0.000001) break;

      const pay = round2(Math.min(t.balance, remaining));
      if (pay <= 0) break;

      t.balance = round2(t.balance - pay);
      remaining = round2(remaining - pay);
      extraPaidTotal = round2(extraPaidTotal + pay);

      extraByDebtId[targetId] = round2((extraByDebtId[targetId] || 0) + pay);
      paidThisMonthByDebtId[targetId] = round2((paidThisMonthByDebtId[targetId] || 0) + pay);

      if (t.balance <= 0.000001 && t.payoffMonth == null) t.payoffMonth = month;
    }

    // Determine "target" as the debt that received the MOST total payment this month
    let actualTargetId = null;
    let actualTargetPaid = 0;

    for (const [idStr, amt] of Object.entries(paidThisMonthByDebtId)) {
      const id = Number(idStr);
      if (amt > actualTargetPaid) {
        actualTargetPaid = amt;
        actualTargetId = id;
      }
    }

    const actualTargetDebt =
      actualTargetId != null ? state.find((x) => x.id === actualTargetId) : null;

    const appliedToTargetThisMonth = round2(actualTargetPaid);
    const extraAppliedToTarget = round2(extraByDebtId[actualTargetId] || 0);

    const totalRemaining = round2(
      state.reduce((sum, d) => sum + Math.max(0, d.balance), 0)
    );

    timeline.push({
      month,
      paymentThisMonth,
      requiredSum: requiredSumThisMonth,
      unassigned: unassignedThisMonth,

      interestThisMonth: interestThisMonthTotal,
      totalInterestToDate: totalInterest,
      minPaid: minPaidTotal,
      directedPaid: directedPaidTotal,
      extraPaid: extraPaidTotal,
      totalRemaining,

      targetDebtId: actualTargetId,
      targetDebtName: actualTargetDebt?.name ?? null,
      appliedToTargetThisMonth,
      extraAppliedToTarget,
      extraByDebtId,
      invalid: false,
    });
  }

  const monthsToDebtFree = allPaid() ? timeline.length : MAX_MONTHS;

  return {
    strategy,
    monthsToDebtFree,
    totalInterest,
    timeline,
    perDebt: state.map((d) => ({
      id: d.id,
      name: d.name,
      apr: d.apr,
      payoffMonth: d.payoffMonth ?? monthsToDebtFree,
      interestPaid: d.interestPaid,
    })),
  };
}


function pickWinner(goal, snow, aval) {
  if (goal === "speed") return snow.monthsToDebtFree <= aval.monthsToDebtFree ? "snowball" : "avalanche";
  if (goal === "interest") return snow.totalInterest <= aval.totalInterest ? "snowball" : "avalanche";
  return "snowball";
}

function getPaymentPlanFn(paymentMode, monthlyPayment, scheduleRows, debtsWithMin) {
  const fixed = Math.max(0, round2(monthlyPayment));

  if (paymentMode !== "schedule") {
    return (month) => ({
      monthlyPayment: fixed,
      requiredByDebtId: null,
      requiredSum: null,
      overBudget: false,
      unassigned: null,
    });
  }

  // normalize schedule rows into map: month -> row
  const map = new Map();
  (scheduleRows || []).forEach((row) => {
    const m = Math.max(1, Math.floor(clampNumber(row.month, 0)));
    map.set(m, {
      month: m,
      amount: Math.max(0, round2(clampNumber(row.amount, 0))),
      allocations: row.allocations || {},
    });
  });

  const maxMonth = Math.max(0, ...Array.from(map.keys()));
  const lastRow = maxMonth ? map.get(maxMonth) : { month: 1, amount: fixed, allocations: {} };

  return (month) => {
    const row = map.get(month) || lastRow;
    const info = computeScheduleMonthRequiredPayments(debtsWithMin, row, row.amount);
    return {
      monthlyPayment: row.amount,
      requiredByDebtId: info.requiredByDebtId,
      requiredSum: info.requiredSum,
      overBudget: info.overBudget,
      unassigned: info.unassigned,
    };
  };
}

export default function App() {
  // ---------- Load ----------
  const stored = (() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })();

  const [debts, setDebts] = useState(stored?.debts ?? DEFAULTS.debts);
  const [paycheques, setPaycheques] = useState(stored?.paycheques ?? DEFAULTS.paycheques);
  const [bills, setBills] = useState(stored?.bills ?? DEFAULTS.bills);
  const [monthlyPayment, setMonthlyPayment] = useState(stored?.monthlyPayment ?? DEFAULTS.monthlyPayment);

  const [goal, setGoal] = useState(stored?.goal ?? DEFAULTS.goal);
  const [paymentMode, setPaymentMode] = useState(stored?.paymentMode ?? DEFAULTS.paymentMode);

  const [paymentSchedule, setPaymentSchedule] = useState(stored?.paymentSchedule ?? DEFAULTS.paymentSchedule);

  const [loading, setLoading] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(1);

  const [uiMode, setUiMode] = useState("simple"); // simple | advanced
  useEffect(() => {
  if (uiMode === "simple" && paymentMode !== "fixed") {
    setPaymentMode("fixed");
    setOpenAllocIdx(null);
  }
}, [uiMode, paymentMode]);




  // UX states
  const [lastUpdated, setLastUpdated] = useState(stored?.lastUpdated ?? null);
  const [status, setStatus] = useState(stored?.status ?? "idle");
  const [statusMessage, setStatusMessage] = useState(stored?.statusMessage ?? "");
  const [showDonate, setShowDonate] = useState(!!stored?.showDonate);

  // UI state: which schedule month is expanded for allocations
  const [openAllocIdx, setOpenAllocIdx] = useState(null);
  const [showWhy, setShowWhy] = useState(false);

  // Ensure every debt has an id (backward compatibility)
  useEffect(() => {
    setDebts((prev) =>
      (prev || []).map((d) => (d?.id ? d : { ...d, id: makeId("d") }))
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Derived values ----------
  const income = useMemo(() => clampNumber(paycheques?.[0]?.amount, 0), [paycheques]);
  const expenses = useMemo(() => clampNumber(bills?.[0]?.amount, 0), [bills]);
  const freeCash = useMemo(() => income - expenses, [income, expenses]);

  const minimumsTotal = useMemo(() => {
  let sum = 0;

  for (const d of debts || []) {
    const bal = Math.max(0, Number(d.balance || 0));
    if (bal <= 0) continue;

    const apr = Math.max(0, Number(d.interest_rate || 0));

    const dynamicMin = computeMonthlyMinimumDynamic(
      {
        type: d.type, // ok if undefined; see note below
        interest_rate: apr,
        min_floor_enabled: !!d.min_floor_enabled,
        min_floor: Number(d.min_floor || 0),
      },
      bal
    );

    sum += Number(dynamicMin || 0);
  }

  return round2(sum);
}, [debts]);


  const debtsWithMin = useMemo(() => {
    return (debts || []).map((d) => {
      const est = estimateMinimumPayment(d);
      const overrideEnabled = !!d.min_override_enabled;
      const overrideAmount = Math.max(0, clampNumber(d.min_override_amount, 0));
      const chosenMin = overrideEnabled ? overrideAmount : est;
      return { ...d, estimated_minimum_payment: est, minimum_payment: chosenMin };
    });
  }, [debts]);

 const activeDebts = debtsWithMin
  .map((d, idx) => ({
    id: idx,
    name: (d.name || "").trim() || "Debt",
    type: d.type || "other",
    balance: Math.max(0, clampNumber(d.balance, 0)),
    interest_rate: Math.max(0, clampNumber(d.interest_rate, 0)),

    // NEW: override is a FLOOR
    min_floor_enabled: !!d.min_override_enabled,
    min_floor: Math.max(0, clampNumber(d.min_override_amount, 0)),
  }))
  .filter((d) => d.balance > 0);


  const totalDebtBalance = useMemo(() => {
    return activeDebts.reduce((sum, d) => sum + d.balance, 0);
  }, [activeDebts]);

  const mpFixed = useMemo(() => Math.max(0, clampNumber(monthlyPayment, 0)), [monthlyPayment]);

  const paymentPlanFn = useMemo(
    () => getPaymentPlanFn(paymentMode, mpFixed, paymentSchedule, activeDebts),
    [paymentMode, mpFixed, paymentSchedule, activeDebts]
  );

  // Schedule validation / preview
  const firstMonthPlan = useMemo(() => paymentPlanFn(1), [paymentPlanFn]);
  const firstMonthPayment = useMemo(() => Math.max(0, round2(firstMonthPlan.monthlyPayment || 0)), [firstMonthPlan]);
  const firstMonthOverBudget = !!firstMonthPlan.overBudget;
  const firstMonthRequiredSum = round2(firstMonthPlan.requiredSum || 0);
  const firstMonthUnassigned = round2(firstMonthPlan.unassigned || 0);

  // Average for PDF export “for now”
  const avgPayment6 = useMemo(() => {
    if (paymentMode !== "schedule") return round2(mpFixed);
    let sum = 0;
    for (let m = 1; m <= 6; m++) sum += Math.max(0, round2(paymentPlanFn(m).monthlyPayment || 0));
    return round2(sum / 6);
  }, [paymentMode, mpFixed, paymentPlanFn]);

  // ---------- Reality / gating ----------
  const reality = useMemo(() => {
    const hasDebts = activeDebts.length > 0;
    const incomeMissing = income <= 0;
    const cannotCoverBills = income < expenses;
    const cannotCoverMinimums = hasDebts ? freeCash < minimumsTotal : false;

    // additional schedule rule: Month 1 cannot be over-budget (requiredSum > month payment)
    const scheduleInvalid = paymentMode === "schedule" ? firstMonthOverBudget : false;

    // also ensure month 1 payment covers minimums (otherwise you fall behind immediately)
    const month1BelowMins = hasDebts ? firstMonthPayment < minimumsTotal : false;

    const isAtRisk =
      incomeMissing ||
      cannotCoverBills ||
      cannotCoverMinimums ||
      scheduleInvalid ||
      month1BelowMins;

    const shortfallBills = Math.max(0, expenses - income);
    const shortfallMinimums = hasDebts ? Math.max(0, minimumsTotal - freeCash) : 0;
    const shortfallMonth1 = hasDebts ? Math.max(0, minimumsTotal - firstMonthPayment) : 0;

    const minIncomeNeeded = hasDebts ? expenses + minimumsTotal : expenses;
    const minDebtPaymentNeeded = minimumsTotal;

    let state = "stable";
    if (isAtRisk) state = "at_risk";
    else {
      const bufferAfterMins = freeCash - minimumsTotal;
      if (bufferAfterMins < 200) state = "tight";
      if (bufferAfterMins > 1500 && freeCash > 2000) state = "optimizing";
    }

    return {
      state,
      isAtRisk,
      hasDebts,
      cannotCoverBills,
      cannotCoverMinimums,
      scheduleInvalid,
      month1BelowMins,
      freeCash,
      minimumsTotal,
      shortfallBills,
      shortfallMinimums,
      shortfallMonth1,
      minIncomeNeeded,
      minDebtPaymentNeeded,
    };
  }, [
    activeDebts.length,
    income,
    expenses,
    freeCash,
    minimumsTotal,
    paymentMode,
    firstMonthOverBudget,
    firstMonthPayment,
  ]);

  // ---------- Simulation ----------
  const simulation = useMemo(() => {
    if (reality.isAtRisk) return null;
    if (activeDebts.length < 2) return null;

    const snow = simulateStrategy("snowball", activeDebts, paymentPlanFn);
    const aval = simulateStrategy("avalanche", activeDebts, paymentPlanFn);

    // If any sim flagged invalid in month 1 (overbudget), treat as unavailable
    if (snow.timeline?.[0]?.invalid || aval.timeline?.[0]?.invalid) return null;

    const winner = pickWinner(goal, snow, aval);
    const monthsDiff = Math.abs(snow.monthsToDebtFree - aval.monthsToDebtFree);
    const interestDiff = round2(Math.abs(snow.totalInterest - aval.totalInterest));

    return { snow, aval, winner, monthsDiff, interestDiff };
  }, [reality.isAtRisk, activeDebts, paymentPlanFn, goal]);

  useEffect(() => {
    if (!simulation) return;
    const max = Math.min(simulation.snow.timeline.length, simulation.aval.timeline.length);
    if (max <= 0) return;
    setSelectedMonth((m) => Math.min(Math.max(1, m), max));
  }, [simulation]);


  const monthDetails = useMemo(() => {
    if (!simulation) return null;

    const max = Math.min(simulation.snow.timeline.length, simulation.aval.timeline.length);
    const m = Math.min(Math.max(1, selectedMonth), max);

    const snowMonth = simulation.snow.timeline[m - 1];
    const avalMonth = simulation.aval.timeline[m - 1];

    return { max, m, snowMonth, avalMonth };
  }, [simulation, selectedMonth]);

const monthExplanation = useMemo(() => {
  if (!monthDetails) return "";

  const extra = monthDetails.snowMonth.unassigned;
  const target = monthDetails.snowMonth.targetDebtName;

  if (!target || extra <= 0) {
    return "This month, all of your payment goes toward required minimums.";
  }

  return `This month, after covering minimums, you have $${formatMoney(
    extra
  )} that the strategy applies to your ${target}.`;
}, [monthDetails]);


  // ---------- Persist ----------
  useEffect(() => {
    const payload = {
      debts,
      paycheques,
      bills,
      monthlyPayment,
      goal,
      paymentMode,
      paymentSchedule,
      lastUpdated,
      status,
      statusMessage,
      showDonate,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {}
  }, [
    debts,
    paycheques,
    bills,
    monthlyPayment,
    goal,
    paymentMode,
    paymentSchedule,
    lastUpdated,
    status,
    statusMessage,
    showDonate,
  ]);

  // ---------- Reset ----------
  const resetAll = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}

    setDebts(DEFAULTS.debts);
    setPaycheques(DEFAULTS.paycheques);
    setBills(DEFAULTS.bills);
    setMonthlyPayment(DEFAULTS.monthlyPayment);
    setGoal(DEFAULTS.goal);
    setPaymentMode(DEFAULTS.paymentMode);
    setPaymentSchedule(DEFAULTS.paymentSchedule);

    setLastUpdated(null);
    setStatus("idle");
    setStatusMessage("");
    setShowDonate(false);
    setOpenAllocIdx(null);
  };

  // ---------- Debt helpers ----------
  const updateDebt = (index, patch) => {
    setDebts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  };
  const addDebt = () => setDebts((prev) => [...prev, emptyDebt()]);
  const removeDebt = (index) => {
    setDebts((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length ? next : [emptyDebt()];
    });
  };

  // ---------- Schedule helpers ----------
  const setScheduleRow = (idx, patch) => {
    setPaymentSchedule((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const addScheduleMonth = () => {
    setPaymentSchedule((prev) => {
      const last = prev?.[prev.length - 1];
      const nextMonth = (last?.month ?? prev.length) + 1;
      const lastAmount = clampNumber(last?.amount, mpFixed);
      return [...prev, { month: nextMonth, amount: round2(lastAmount), allocations: {} }];
    });
  };

  const removeScheduleMonth = (idx) => {
    setPaymentSchedule((prev) => prev.filter((_, i) => i !== idx));
    setOpenAllocIdx((cur) => (cur === idx ? null : cur));
  };

  const quickFillSchedule = (months) => {
    const m = Math.max(1, Math.floor(clampNumber(months, 6)));
    const amt = round2(mpFixed);
    const rows = Array.from({ length: m }, (_, i) => ({
      month: i + 1,
      amount: amt,
      allocations: {},
    }));
    setPaymentSchedule(rows);
    setOpenAllocIdx(null);
  };

  // Allocation editing (per schedule row)
  const setAllocation = (scheduleIdx, debtId, value) => {
    setPaymentSchedule((prev) =>
      prev.map((row, i) => {
        if (i !== scheduleIdx) return row;
        const alloc = { ...(row.allocations || {}) };
        const v = Math.max(0, clampNumber(value, 0));
        if (v <= 0) delete alloc[debtId]; // treat 0 as "no override" -> minimum applies
        else alloc[debtId] = v;
        return { ...row, allocations: alloc };
      })
    );
  };

  const fillMinimumsForMonth = (scheduleIdx) => {
    // Sets each debt's allocation to its minimum for this month (A = total incl min)
    setPaymentSchedule((prev) =>
      prev.map((row, i) => {
        if (i !== scheduleIdx) return row;
        const alloc = {};
        for (const d of activeDebts) alloc[d.id] = round2(d.minimum_payment);
        return { ...row, allocations: alloc };
      })
    );
  };

  const clearAllocationsForMonth = (scheduleIdx) => {
    setPaymentSchedule((prev) => prev.map((row, i) => (i === scheduleIdx ? { ...row, allocations: {} } : row)));
  };

  // ---------- PDF export snapshot (backend still accepts one payment) ----------
  const exportPaymentForBackend = paymentMode === "schedule" ? avgPayment6 : mpFixed;

  const exportPdf = async () => {
    setLoading(true);
    setStatus("idle");
    setStatusMessage("");
    setShowDonate(false);

    try {
      if (reality.isAtRisk) {
        setStatus("error");
        setStatusMessage("Survival Mode: export is locked until bills and minimums are covered.");
        setLoading(false);
        return;
      }

      if (activeDebts.length < 2) {
        setStatus("error");
        setStatusMessage("Please add at least two active debts to compare strategies.");
        setLoading(false);
        return;
      }

      const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

const response = await fetch(`${API_BASE_URL}/v1/export/pdf`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    debts: activeDebts.map((d) => ({
      name: d.name,
      type: d.type,
      balance: d.balance,
      interest_rate: d.interest_rate,
      minimum_payment: d.minimum_payment,
    })),
    paycheques,
    bills,
    monthly_payment: exportPaymentForBackend,
  }),
});


      if (!response.ok) {
        let msg = "Failed to export PDF";
        try {
          const errJson = await response.json();
          msg = errJson?.error || msg;
        } catch {}
        throw new Error(msg);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = "ClearPath_Debt_Report.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();

      window.URL.revokeObjectURL(url);

      const t = nowIso();
      setLastUpdated(t);
      setStatus("success");
      setStatusMessage("PDF exported successfully.");
      setShowDonate(true);
    } catch (err) {
      console.error(err);
      setStatus("error");
      setStatusMessage(err?.message || "There was a problem exporting your PDF.");
    } finally {
      setLoading(false);
    }
  };

  // ---------- UI helpers ----------
  const stateLabel =
    reality.state === "at_risk"
      ? "Survival Mode (At Risk)"
      : reality.state === "tight"
      ? "Stability Mode (Tight)"
      : reality.state === "optimizing"
      ? "Acceleration Mode (Optimizing)"
      : "Planning Mode (Stable)";

  const stateTone =
    reality.state === "at_risk" ? "danger" : reality.state === "tight" ? "warn" : "good";

  const winnerLabel =
    simulation?.winner === "snowball" ? "Snowball" : simulation?.winner === "avalanche" ? "Avalanche" : "";

  const goalLabel =
    goal === "speed" ? "Fastest payoff" : goal === "interest" ? "Lowest interest" : "Easiest to stick to";

  // Helper for showing month 1 allocation math
  const month1Info = useMemo(() => {
    if (paymentMode !== "schedule") return null;
    return {
      payment: firstMonthPayment,
      requiredSum: firstMonthRequiredSum,
      unassigned: firstMonthUnassigned,
      overBudget: firstMonthOverBudget,
    };
  }, [paymentMode, firstMonthPayment, firstMonthRequiredSum, firstMonthUnassigned, firstMonthOverBudget]);

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <img src={logo} alt="ClearPath Debt" className="brand-logo" />
          <span className="brand-name">ClearPath Debt</span>
        </div>

        <div className="header-actions">
  <button type="button" className="ghost" onClick={resetAll}>
    Reset
  </button>

  <div className="segmented">
    <button
      type="button"
      className={`seg-btn ${uiMode === "simple" ? "active" : ""}`}
      onClick={() => setUiMode("simple")}
    >
      Simple
    </button>
    <button
      type="button"
      className={`seg-btn ${uiMode === "advanced" ? "active" : ""}`}
      onClick={() => setUiMode("advanced")}
    >
      Advanced
    </button>
  </div>

  {lastUpdated ? (
    <span className="header-chip">Last updated: {formatUpdated(lastUpdated)}</span>
  ) : (
    <span className="header-chip">Informational use only</span>
  )}
</div>
      </header>

      <main className="container">
        <section className="left">

          {/* Reality Check */}
          <div className={`reality card ${stateTone}`}>
            <div className="reality-top">
              <div>
                <div className="card-title">Financial Reality Check</div>
                <div className="card-subtitle">
                  Minimum payments are estimated by default. Use exact numbers override is optional per debt.
                </div>
              </div>
              <div className="reality-badge">{stateLabel}</div>
            </div>

            <div className="reality-grid">
              <div className="reality-metric">
                <div className="metric-label">Monthly income</div>
                <div className="metric-value">${formatMoney(income)}</div>
              </div>
              <div className="reality-metric">
                <div className="metric-label">Monthly bills</div>
                <div className="metric-value">${formatMoney(expenses)}</div>
              </div>
              <div className="reality-metric">
                <div className="metric-label">Free cash (income − bills)</div>
                <div className={`metric-value ${freeCash < 0 ? "bad" : ""}`}>${formatMoney(freeCash)}</div>
              </div>
              <div className="reality-metric">
                <div className="metric-label">Minimum payments required (est.)</div>
                <div className="metric-value">${formatMoney(minimumsTotal)}</div>
              </div>
            </div>

            {paymentMode === "schedule" && month1Info && (
              <div className={`schedule-feasibility ${month1Info.overBudget ? "badbox" : ""}`}>
                <div className="sf-title">Schedule check (Month 1)</div>
                <div className="sf-row">
                  <span>Total payment:</span> <b>${formatMoney(month1Info.payment)}</b>
                </div>
                <div className="sf-row">
                  <span>Required payments (mins + your allocations):</span> <b>${formatMoney(month1Info.requiredSum)}</b>
                </div>
                <div className="sf-row">
                  <span>Unassigned remainder (strategy will allocate):</span> <b>${formatMoney(month1Info.unassigned)}</b>
                </div>
                {month1Info.overBudget && (
                  <div className="sf-warn">
                    Your Month 1 allocations force required payments above the month’s total payment.
                    Reduce allocations or increase the month payment.
                  </div>
                )}
              </div>
            )}

            {reality.isAtRisk ? (
              <div className="reality-callout">
                <div className="callout-title">Survival Mode: stabilize first</div>
                <ul className="callout-list">
                  {reality.cannotCoverBills && (
                    <li>
                      You’re short on bills by <b>${formatMoney(reality.shortfallBills)}</b> per month.
                    </li>
                  )}
                  {reality.hasDebts && reality.cannotCoverMinimums && (
                    <li>
                      After bills, you’re short on minimum payments by <b>${formatMoney(reality.shortfallMinimums)}</b> per month.
                    </li>
                  )}
                  {paymentMode === "schedule" && reality.scheduleInvalid && (
                    <li>
                      Your month 1 allocations exceed your month 1 total payment. (Reduce allocations or raise month 1 payment.)
                    </li>
                  )}
                  {paymentMode === "schedule" && reality.month1BelowMins && (
                    <li>
                      Your month 1 total payment is below minimums by <b>${formatMoney(reality.shortfallMonth1)}</b>.
                    </li>
                  )}
                  <li>
                    Minimum income needed to exit Survival Mode: <b>${formatMoney(reality.minIncomeNeeded)}</b>/month
                  </li>
                  <li>
                    Minimum debt payment needed (est.): <b>${formatMoney(reality.minDebtPaymentNeeded)}</b>/month
                  </li>
                </ul>

                <div className="callout-actions">
                  <div className="callout-h">What to do next</div>
                  <ol className="callout-steps">
                    <li>Cover bills first (reduce expenses or increase income).</li>
                    <li>Then ensure you can meet minimum payments consistently.</li>
                    <li>Once stable, ClearPath unlocks strategy comparisons and timelines.</li>
                  </ol>
                </div>
              </div>
            ) : (
              <div className="reality-ok">
                <div className="ok-row">
                  <span className="ok-dot" />
                  <span>Feasible. Strategy simulation is live below.</span>
                </div>
              </div>
            )}
          </div>

          {/* Inputs */}
          <div className="card cardInputs">
  <div className="card-top">
    <div>
      <div className="card-title">Inputs</div>
      <div className="card-subtitle">
        Adjust inputs and see outcomes update instantly.
      </div>
    </div>

    <button className="ghost" onClick={resetAll} disabled={loading}>
      Reset
    </button>
  </div>

  {/* 👇 SIMPLE / ADVANCED TOGGLE GOES HERE */}
  <div className="uiModeToggle">
    <button
      className={`toggle ${uiMode === "simple" ? "active" : ""}`}
      onClick={() => setUiMode("simple")}
    >
      Simple
    </button>
    <button
      className={`toggle ${uiMode === "advanced" ? "active" : ""}`}
      onClick={() => setUiMode("advanced")}
    >
      Advanced
    </button>
  </div>

  <div className="hint">
    Simple mode keeps things easy. Advanced mode lets you customize month-by-month.
  </div>

  {/* 👇 EXISTING INPUT GRID STARTS HERE */}
  <div className="grid">
    ...


            </div>

            <div className="grid">
              <div className="field">
                <label>Monthly Income</label>
                <input
                  type="number"
                  value={paycheques?.[0]?.amount ?? 0}
                  onChange={(e) => setPaycheques([{ amount: keepBlankOrNumber(e.target.value, 0) }])}
                />
              </div>

              <div className="field">
                <label>Monthly Bills</label>
                <input
                  type="number"
                  value={bills?.[0]?.amount ?? 0}
                  onChange={(e) => setBills([{ amount: keepBlankOrNumber(e.target.value, 0) }])}
                />
              </div>

              <div className="field field-wide">
                <label>Your goal</label>
                <select value={goal} onChange={(e) => setGoal(e.target.value)}>
                  <option value="speed">Fastest payoff</option>
                  <option value="interest">Lowest interest</option>
                  <option value="stick">Easiest to stick to</option>
                </select>
              </div>

          {/* Payment Mode (Simple vs Advanced wrapper) */}
{uiMode === "simple" ? (
  // SIMPLE MODE: fixed payment only
  <div className="field field-wide">
    <label>Monthly Payment Applied</label>
    <input
      type="number"
      value={monthlyPayment}
      onChange={(e) => setMonthlyPayment(keepBlankOrNumber(e.target.value, 0))}
    />
    <div className="hint">Simple mode uses one steady payment every month.</div>
  </div>
) : (
  // ADVANCED MODE: payment mode toggle + fixed or schedule
  <>
    <div className="field field-wide">
      <label>Payment mode</label>
      <div className="toggle-row">
        <button
          type="button"
          className={`toggle ${paymentMode === "fixed" ? "active" : ""}`}
          onClick={() => setPaymentMode("fixed")}
          disabled={loading}
        >
          Fixed monthly payment
        </button>
        <button
          type="button"
          className={`toggle ${paymentMode === "schedule" ? "active" : ""}`}
          onClick={() => setPaymentMode("schedule")}
          disabled={loading}
        >
          Month-by-month plan
        </button>
      </div>
      <div className="hint">
        In schedule mode, each month can include per-debt allocations (total to that debt, including minimum).
      </div>
    </div>

    {/* Fixed payment input */}
    {paymentMode === "fixed" ? (
      <div className="field field-wide">
        <label>Monthly Payment Applied</label>
        <input
          type="number"
          value={monthlyPayment}
          onChange={(e) => setMonthlyPayment(keepBlankOrNumber(e.target.value, 0))}
        />
      </div>
    ) : (
      <div className="field field-wide">
        <label>Payment schedule</label>

        <div className="schedule-toolbar">
          <button type="button" className="ghost" onClick={() => quickFillSchedule(6)}>
            Quick fill 6 mo
          </button>
          <button type="button" className="ghost" onClick={() => quickFillSchedule(12)}>
            Quick fill 12 mo
          </button>
          <button type="button" className="ghost" onClick={addScheduleMonth}>
            + Add month
          </button>
          <div className="schedule-note">Beyond your last month, ClearPath repeats the last month’s plan.</div>
        </div>

        <div className="schedule-list">
          {(paymentSchedule || []).map((row, idx) => {
            const planInfo = computeScheduleMonthRequiredPayments(activeDebts, row, row.amount);
            const isOpen = openAllocIdx === idx;

            return (
              <div className={`schedule-rowCard ${planInfo.overBudget ? "over" : ""}`} key={idx}>
                <div className="schedule-rowTop">
                  <div className="schedule-topLeft">
                    <div className="field schedule-month">
                      <label>Month</label>
                      <input
                        type="number"
                        value={row.month}
                        onChange={(e) =>
                          setScheduleRow(idx, {
                            month: Math.max(1, Math.floor(clampNumber(e.target.value, 1))),
                          })
                        }
                      />
                    </div>

                    <div className="field schedule-amount">
                      <label>Total payment ($)</label>
                      <input
                        type="number"
                        value={row.amount}
                        onChange={(e) =>
                          setScheduleRow(idx, {
                            amount: Math.max(0, clampNumber(e.target.value, 0)),
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="schedule-topRight">
                    <div className="alloc-summary">
                      <div>
                        Required: <b>${formatMoney(planInfo.requiredSum)}</b>
                      </div>
                      <div>
                        Unassigned: <b>${formatMoney(planInfo.unassigned)}</b>
                      </div>
                    </div>

                    <div className="schedule-actions">
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setOpenAllocIdx(isOpen ? null : idx)}
                      >
                        {isOpen ? "Hide allocations" : "Allocate per debt"}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => removeScheduleMonth(idx)}
                        disabled={(paymentSchedule || []).length <= 1}
                      >
                        Remove month
                      </button>
                    </div>
                  </div>
                </div>

                {planInfo.overBudget && (
                  <div className="alloc-warning">
                    Over budget: your required payments (minimums + allocations) exceed this month’s total payment.
                  </div>
                )}

                {isOpen && (
                  <div className="alloc-panel">
                    <div className="alloc-head">
                      <div className="alloc-title">Per-debt allocations (Total payment to that debt)</div>
                      <div className="alloc-actions">
                        <button type="button" className="ghost" onClick={() => fillMinimumsForMonth(idx)}>
                          Fill minimums
                        </button>
                        <button type="button" className="ghost" onClick={() => clearAllocationsForMonth(idx)}>
                          Clear
                        </button>
                      </div>
                    </div>

                    <div className="alloc-grid">
                      {activeDebts.map((d) => {
                        const current = clampNumber(row?.allocations?.[d.id], 0);
                        const min = d.minimum_payment;

                        return (
                          <div className="alloc-item" key={d.id}>
                            <div className="alloc-name">
                              <div className="alloc-n">{d.name}</div>
                              <div className="alloc-sub">
                                Min est: <b>${formatMoney(min)}</b> · APR: <b>{formatMoney(d.interest_rate)}%</b>
                              </div>
                            </div>

                            <div className="alloc-inputWrap">
                              <label className="small-label">This month pay</label>
                              <input
                                type="number"
                                value={current}
                                placeholder={`${formatMoney(min)} (minimum)`}
                                onChange={(e) => setAllocation(idx, d.id, e.target.value)}
                              />
                              <div className="tiny">
                                If left blank/0, ClearPath pays the minimum automatically.
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className={`alloc-footer ${planInfo.overBudget ? "badbox" : ""}`}>
                      <div>
                        Total payment: <b>${formatMoney(row.amount)}</b>
                      </div>
                      <div>
                        Required (mins + allocations): <b>${formatMoney(planInfo.requiredSum)}</b>
                      </div>
                      <div>
                        Unassigned remainder (strategy allocates): <b>${formatMoney(planInfo.unassigned)}</b>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="tiny muted-note">
          Beyond your last schedule month, ClearPath repeats the last month’s total payment + allocations.
        </div>
      </div>
    )}
  </>
)}

            </div>

            <div className="divider" />

            {/* Debts */}
            <div className="debts-header">
              <div className="card-title" style={{ margin: 0 }}>
                Debts
              </div>
              <div className="debts-total">Total balance: ${formatMoney(totalDebtBalance)}</div>
            </div>

            <div className="debts-list">
              {debtsWithMin.map((d, idx) => (
                <div className="debt-row" key={d.id || idx}>
                  <div className="field debt-name">
                    <label>Debt name</label>
                    <input
                      value={d.name}
                      onChange={(e) => updateDebt(idx, { name: e.target.value })}
                      placeholder="Visa / Loan / LOC..."
                    />
                  </div>

                  <div className="field debt-type">
                    <label>Type</label>
                    <select value={d.type || "credit_card"} onChange={(e) => updateDebt(idx, { type: e.target.value })}>
                      <option value="credit_card">Credit Card</option>
                      <option value="loan">Loan</option>
                      <option value="loc">Line of Credit</option>
                      <option value="other">Other</option>
                    </select>
                  </div>

                  <div className="field debt-balance">
                    <label>Balance ($)</label>
                    <input
                      type="number"
                      value={d.balance}
                      onChange={(e) => updateDebt(idx, { balance: keepBlankOrNumber(e.target.value, 0) })}
                    />
                  </div>

                  <div className="field debt-apr">
                    <label>APR (%)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={d.interest_rate}
                      onChange={(e) => updateDebt(idx, { interest_rate: keepBlankOrNumber(e.target.value, 0) })}
                    />
                  </div>

                  <div className="field debt-min-est">
                    <label>Minimum (est.)</label>
                    <div className="readonly">${formatMoney(estimateMinimumPayment(d))}</div>

                    <button
                      type="button"
                      className="link"
                      onClick={() =>
                        updateDebt(idx, {
                          min_override_enabled: !d.min_override_enabled,
                          min_override_amount: d.min_override_enabled ? d.min_override_amount : round2(d.estimated_minimum_payment),
                        })
                      }
                    >
                      {d.min_override_enabled ? "Hide Use exact numbers" : "Use exact numbers"}
                    </button>

                    {d.min_override_enabled && (
                      <div className="Use exact numbers">
                        <label className="small-label">Override minimum ($)</label>
                        <input
                          type="number"
                          value={d.min_override_amount ?? 0}
                          onChange={(e) => updateDebt(idx, { min_override_amount: keepBlankOrNumber(e.target.value, 0) })}
                        />
                        <div className="tiny">Use your statement minimum if you know it.</div>
                      </div>
                    )}
                  </div>

                  <div className="debt-actions">
                    <button className="ghost" onClick={() => removeDebt(idx)} disabled={loading} type="button">
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button className="ghost add-debt" onClick={addDebt} disabled={loading} type="button">
              + Add debt
            </button>
          </div>

          {/* Live Results */}
          <div className="card cardResults">
            <div className="card-top">
              <div>
                <div className="card-title">Live Strategy Results</div>
                <div className="card-subtitle">
                  Updates instantly. Goal: <b>{goalLabel}</b>.
                </div>
              </div>
              <div className="pill">Mode: {paymentMode === "fixed" ? "Fixed" : "Plan type: Month-by-month"}</div>
            </div>

            {reality.isAtRisk ? (
              <div className="locked">
                <div className="locked-title">Locked (Survival Mode)</div>
                <div className="locked-text">
                  Strategy comparison is disabled until bills and minimums are covered (and month 1 allocations fit inside
                  month 1 payment).
                </div>
              </div>
            ) : !simulation ? (
              <div className="locked">
                <div className="locked-title">Add at least 2 active debts to compare</div>
                <div className="locked-text">Enter two or more debts with balances above $0.</div>
              </div>
            ) : (
              <>
                {monthDetails && (
  <div className="monthBar">
    <div className="monthLeft">
      <div className="monthLabel">Show month</div>
      <select
        value={monthDetails.m}
        onChange={(e) => setSelectedMonth(clampNumber(e.target.value, 1))}
      >
        {Array.from({ length: monthDetails.max }, (_, i) => i + 1).map((m) => (
          <option key={m} value={m}>
            Month {m}
          </option>
        ))}
      </select>
    </div>

    <div className="monthRight">
  <div className="monthChip">
    Monthly payment:{" "}
    <b>${formatMoney(monthDetails.snowMonth.paymentThisMonth)}</b>
  </div>

  <div className="monthChip">
    Must-pay amount:{" "}
    <b>${formatMoney(monthDetails.snowMonth.requiredSum)}</b>
  </div>

  <div className="monthChip">
    Extra you can aim:{" "}
    <b>${formatMoney(monthDetails.snowMonth.unassigned)}</b>
  </div>
</div>

{monthExplanation && (
  <div className="monthExplanation">
    {monthExplanation}
  </div>
)}


<div className="hint">
  Minimums are automatically calculated. “Extra you can aim” is the flexible
  amount the strategy decides how to use.
</div>

  </div>
)}

{monthDetails && (
  <div className="targetsGrid">
    <div className="targetCard">
      <div className="targetH">Snowball target (Month {monthDetails.m})</div>
      <div className="targetName">{monthDetails.snowMonth.targetDebtName || "—"}</div>
      <div className="targetSub">
  Applied to target this month: <b>${formatMoney(monthDetails.snowMonth.appliedToTargetThisMonth)}</b>
</div>
<div className="targetSub muted">
  Extra decided automatically (total): ${formatMoney(monthDetails.snowMonth.extraPaid)}
</div>


    </div>

    <div className="targetCard">
      <div className="targetH">Avalanche target (Month {monthDetails.m})</div>
      <div className="targetName">{monthDetails.avalMonth.targetDebtName || "—"}</div>
      <div className="targetSub">
  Applied to target this month: <b>${formatMoney(monthDetails.avalMonth.appliedToTargetThisMonth)}</b>
</div>
<div className="targetSub muted">
  Extra decided automatically (total): ${formatMoney(monthDetails.avalMonth.extraPaid)}
</div>

    </div>
  </div>
)}

                <div className="result-grid">
                  <div className={`result-card ${simulation.winner === "snowball" ? "winner" : ""}`}>
                    <div
  className="result-h"
  title="Pays off the smallest debt first to build momentum."
>
  Snowball ⓘ
</div>

                    <div className="result-kpi">
                      <div>
                        <div className="kpi-label">Debt-free in</div>
                        <div className="kpi-value">{simulation.snow.monthsToDebtFree} mo</div>
                      </div>
                      <div>
                        <div className="kpi-label">Total interest</div>
                        <div className="kpi-value">${formatMoney(simulation.snow.totalInterest)}</div>
                      </div>
                    </div>
                  </div>

                  <div className={`result-card ${simulation.winner === "avalanche" ? "winner" : ""}`}>
                   <div
  className="result-h"
  title="Pays off the highest-interest debt first to reduce interest."
>
  Avalanche ⓘ
</div>

                    <div className="result-kpi">
                      <div>
                        <div className="kpi-label">Debt-free in</div>
                        <div className="kpi-value">{simulation.aval.monthsToDebtFree} mo</div>
                      </div>
                      <div>
                        <div className="kpi-label">Total interest</div>
                        <div className="kpi-value">${formatMoney(simulation.aval.totalInterest)}</div>
                      </div>
                    </div>
                  </div>

                  <div className="result-summary">
                    <div className="summary-title">Best for your goal</div>
                    <div className="summary-big">{winnerLabel}</div>
                    <div className="summary-sub">
                      Difference: {simulation.monthsDiff} mo • ${formatMoney(simulation.interestDiff)} interest
                    </div>
                  </div>
                </div>

                <div className="why-wrap">
  <button
    type="button"
    className="why-toggle"
    onClick={() => setShowWhy(v => !v)}
  >
    Why this strategy?
    <span className={`chevron ${showWhy ? "open" : ""}`}>▾</span>
  </button>

<div className={`why-body ${showWhy ? "open" : ""}`}>
  <div className="why-inner">
    {simulation.monthsDiff === 0 && simulation.interestDiff === 0 ? (
      <>
        <p>In this scenario, Snowball and Avalanche produce the same result.</p>
        <p>Both strategies target the same debt first, so the timeline and interest naturally match.</p>
      </>
    ) : simulation.winner === "avalanche" ? (
      <>
        <p>Avalanche focuses on paying off the highest-interest debt first.</p>
        <p>In your case, this reduces total interest paid over time, saving more money even if the payoff timeline is similar.</p>
      </>
    ) : (
      <>
        <p>Snowball focuses on paying off the smallest balance first.</p>
        <p>In your case, this reaches debt-free just as fast while helping close accounts sooner and reduce mental load.</p>
      </>
    )}
  </div>
</div>

</div>


                {simulation.monthsDiff === 0 && simulation.interestDiff === 0 && (
                 <div className="strategy-note">
                  In some situations, Snowball and Avalanche produce the same result when they target the same debt.
                  </div>
                )}

                <div className="divider" />

                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Debt</th>
                        <th>APR</th>
                        <th>Snowball payoff</th>
                        <th>Snowball interest</th>
                        <th>Avalanche payoff</th>
                        <th>Avalanche interest</th>
                      </tr>
                    </thead>
                    <tbody>
                      {simulation.snow.perDebt.map((sd) => {
                        const ad = simulation.aval.perDebt.find((x) => x.id === sd.id);
                        return (
                          <tr key={sd.id}>
                            <td className="td-strong">{sd.name}</td>
                            <td>{formatMoney(sd.apr)}%</td>
                            <td>{sd.payoffMonth} mo</td>
                            <td>${formatMoney(sd.interestPaid)}</td>
                            <td>{ad?.payoffMonth ?? "-"} mo</td>
                            <td>${formatMoney(ad?.interestPaid ?? 0)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="tiny muted-note">
                  Allocations are applied first (as totals per debt, with minimums enforced). Any remaining unassigned
                  payment is allocated by the chosen strategy (Snowball/Avalanche).
                </div>
              </>
            )}
          </div>

          {/* Export */}
          <div className="card">
            <div className="card-top">
              <div>
                <div className="card-title">Export</div>
                <div className="card-subtitle">
                  Snapshot PDF (optional). Backend still accepts a single monthly payment; schedule exports using the
                  average of the next 6 months for now.
                </div>
              </div>
            </div>

            <button className="cta cta-dark" onClick={exportPdf} disabled={loading || reality.isAtRisk}>
              {reality.isAtRisk ? "Locked (Survival Mode)" : loading ? "Exporting…" : "Export PDF snapshot"}
            </button>

            {status !== "idle" && <div className={`notice ${status}`}>{statusMessage}</div>}

            {showDonate && (
              <div className="donate">
                <div className="donate-title">Support the tool</div>
                <p className="donate-text">If this helped you gain clarity, you can support ClearPath Debt.</p>
                <a className="donate-btn" href={STRIPE_DONATE_URL} target="_blank" rel="noreferrer">
                  Donate via Stripe
                </a>
              </div>
            )}
          </div>
        </section>

        {/* RIGHT COLUMN */}
        <aside className="right">
          <div className="side-card">
            <div className="side-title">You’re in control of your plan.</div>
            <p className="side-text">
              You choose how much you pay each month and where it goes.
Any leftover amount is handled automatically using your selected strategy.
            </p>

            <div className="side-section">
              <div className="side-h">ClearPath is designed to grow with your situation, without changing how it works.</div>
              <ol className="steps">
              </ol>
            </div>
          </div>

          <footer className="footer">ClearPath Debt · Informational use only · Not financial advice · Your data is private</footer>
        </aside>
      </main>
    </div>
  );
}
