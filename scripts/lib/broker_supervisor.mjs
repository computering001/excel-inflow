import fs from "node:fs";

import { assertBrokerFailureDegrades } from "./delivery_constitution.mjs";

const MACHINE = JSON.parse(
  fs.readFileSync(new URL("../../assets/broker-supervisor-state-machine-v1.json", import.meta.url), "utf8"),
);
const RANK = new Map(MACHINE.states.map((state) => [state.id, state.rank]));
const EDGES = new Set(MACHINE.transitions.map(([from, to]) => `${from}->${to}`));

export function assertBrokerSupervisorTransition(from, to) {
  if (!EDGES.has(`${from}->${to}`)) throw new Error(`Illegal broker supervisor transition ${from}->${to}`);
  if (RANK.get(to) < RANK.get(from)) throw new Error(`Non-monotone broker supervisor transition ${from}->${to}`);
}

export function superviseBrokerOutcome({ outcome, reasonCode = null, attemptedSelection = true }) {
  const trace = ["INIT", "ARCHIVED"];
  assertBrokerSupervisorTransition("INIT", "ARCHIVED");
  if (outcome === "usable") {
    assertBrokerSupervisorTransition("ARCHIVED", "SELECTING");
    assertBrokerSupervisorTransition("SELECTING", "AUTHORITY_READY");
    assertBrokerSupervisorTransition("AUTHORITY_READY", "CLOSED");
    trace.push("SELECTING", "AUTHORITY_READY", "CLOSED");
    return { terminal_state: "CLOSED", authority_mode: "selected_cells", trace };
  }
  const reason = reasonCode ?? "broker_zero_usable_houses";
  assertBrokerFailureDegrades(reason);
  if (attemptedSelection) {
    assertBrokerSupervisorTransition("ARCHIVED", "SELECTING");
    assertBrokerSupervisorTransition("SELECTING", "ZERO_AUTHORITY");
    trace.push("SELECTING");
  } else {
    assertBrokerSupervisorTransition("ARCHIVED", "ZERO_AUTHORITY");
  }
  assertBrokerSupervisorTransition("ZERO_AUTHORITY", "CLOSED");
  trace.push("ZERO_AUTHORITY", "CLOSED");
  return {
    terminal_state: "CLOSED",
    authority_mode: "zero_broker_authority",
    selected_cell_count: 0,
    reason_code: reason,
    trace,
  };
}

export function brokerSupervisorMachine() {
  return structuredClone(MACHINE);
}
