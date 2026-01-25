import React, { useMemo, useState } from "react";

const emptyDebt = () => ({
  name: "",
  balance: "",
  interest_rate: "",
  minimum_payment: "",
});

export default function DebtsForm({ onChange }) {
  const [debts, setDebts] = useState([emptyDebt()]);

  const totals = useMemo(() => {
    const totalBalance = debts.reduce((sum, d) => sum + (parseFloat(d.balance) || 0), 0);
    return { totalBalance };
  }, [debts]);

  function updateDebt(index, key, value) {
    const next = debts.map((d, i) => (i === index ? { ...d, [key]: value } : d));
    setDebts(next);
    onChange?.(next);
  }

  function addDebt() {
    const next = [...debts, emptyDebt()];
    setDebts(next);
    onChange?.(next);
  }

  function removeDebt(index) {
    const next = debts.filter((_, i) => i !== index);
    const safe = next.length ? next : [emptyDebt()];
    setDebts(safe);
    onChange?.(safe);
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <h3 style={{ marginBottom: 10 }}>Your Debts</h3>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto", gap: 10, fontWeight: 600 }}>
        <div>Name</div>
        <div>Balance ($)</div>
        <div>APR (%)</div>
        <div>Min Payment ($)</div>
        <div></div>
      </div>

      {debts.map((d, idx) => (
        <div
          key={idx}
          style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr auto", gap: 10, marginTop: 8 }}
        >
          <input
            placeholder="Visa / Loan / Line of credit..."
            value={d.name}
            onChange={(e) => updateDebt(idx, "name", e.target.value)}
          />
          <input
            placeholder="5000"
            inputMode="decimal"
            value={d.balance}
            onChange={(e) => updateDebt(idx, "balance", e.target.value)}
          />
          <input
            placeholder="19.99"
            inputMode="decimal"
            value={d.interest_rate}
            onChange={(e) => updateDebt(idx, "interest_rate", e.target.value)}
          />
          <input
            placeholder="150"
            inputMode="decimal"
            value={d.minimum_payment}
            onChange={(e) => updateDebt(idx, "minimum_payment", e.target.value)}
          />
          <button type="button" onClick={() => removeDebt(idx)} style={{ padding: "6px 10px" }}>
            Remove
          </button>
        </div>
      ))}

      <div style={{ display: "flex", gap: 12, marginTop: 12, alignItems: "center" }}>
        <button type="button" onClick={addDebt} style={{ padding: "8px 12px" }}>
          + Add debt
        </button>

        <div style={{ marginLeft: "auto", fontWeight: 600 }}>
          Total balance: ${totals.totalBalance.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </div>
      </div>

      <p style={{ marginTop: 10, color: "#555" }}>
        Tip: Enter each debt separately (credit cards, loans, lines of credit). This is required for Snowball vs Avalanche
        to compare correctly.
      </p>
    </div>
  );
}
