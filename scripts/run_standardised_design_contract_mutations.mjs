import assert from "node:assert/strict";

import { createRunner } from "./lib/test_harness.mjs";
import {
  loadPinnedInputs,
  validateContractObject,
} from "./validate_standardised_design_contract.mjs";

const run = createRunner({
  name: "standardised_design_contract_mutations",
  importMetaUrl: import.meta.url,
});

function clone(value) {
  return structuredClone(value);
}

function firstResolvedRule(contract, profileName) {
  for (const [sheetName, sheet] of Object.entries(
    contract.profiles[profileName].workbook.sheets,
  )) {
    for (const block of sheet.resolved_conditional_formats) {
      const rule = block.rules.find(
        (candidate) =>
          candidate.dxf !== undefined && candidate.resolved_dxf !== undefined,
      );
      if (rule) return { sheetName, rule };
    }
  }
  throw new Error(`No resolved conditional-format rule for ${profileName}`);
}

const mutations = [
  {
    id: "M01_AUTHORITY_HASH",
    expected: "maximal:AUTHORITY_HASH",
    apply(contract) {
      contract.profiles.maximal.immutable_authority.sha256 = "0".repeat(64);
    },
  },
  {
    id: "M02_EMPTY_TOPOLOGY",
    expected: "net_cash:TOPOLOGY:instruments",
    apply(contract) {
      contract.profiles.net_cash.row_map.semantic_topology.instruments = {};
    },
  },
  {
    id: "M03_EMPTY_STYLE_TABLE",
    expected: "maximal:STYLE_TABLE",
    apply(contract) {
      contract.profiles.maximal.workbook.resolved_style_table = [];
    },
  },
  {
    id: "M04_EMPTY_DXF_TABLE",
    expected: "net_cash:DXF_TABLE",
    apply(contract) {
      contract.profiles.net_cash.workbook.resolved_differential_style_table =
        [];
    },
  },
  {
    id: "M05_UNRESOLVED_DXF",
    expected: "maximal:Operating Model:DXF_RESOLUTION",
    apply(contract) {
      const { rule } = firstResolvedRule(contract, "maximal");
      delete rule.resolved_dxf;
    },
  },
  {
    id: "M06_VIEW_SILENCE_DROPPED",
    expected: "maximal:WORKBOOK_VIEW",
    apply(contract) {
      delete contract.profiles.maximal.raw_package_contract
        .workbook_view_declared_silence;
    },
  },
  {
    id: "M07_PRINT_SILENCE_DROPPED",
    expected: "maximal:Operating Model:VIEW_PRINT",
    apply(contract) {
      delete contract.profiles.maximal.raw_package_contract.worksheets[
        "Operating Model"
      ].page_setup_declared_silence;
    },
  },
  {
    id: "M08_WRONG_FIT_WIDTH",
    expected: "PRINT_CONTRACT",
    apply(contract) {
      contract.production_print_contract.fit_width = 2;
    },
  },
  {
    id: "M09_PERCENTAGE_ACQUISITION_DEBT",
    expected: "ACQUISITION_CONTROL",
    apply(contract) {
      delete contract.production_controls.acquisition.acquisition_debt_amount;
      contract.production_controls.acquisition.acquisition_debt_percentage =
        "legacy defect";
    },
  },
  {
    id: "M10_SCOPE_COLLAPSE",
    expected: "SCOPE_SEPARATION",
    apply(contract) {
      delete contract.scope_separation.production_design_contract;
    },
  },
  {
    id: "M11_FALSE_COLUMN_AGREEMENT",
    expected: "HORIZONTAL_GRAMMAR",
    apply(contract) {
      contract.shared_horizontal_grammar.column_dimensions_are_identical =
        false;
    },
  },
  {
    id: "M12_COLUMN_DRIFT",
    expected: "COLUMN_EQUALITY",
    apply(contract) {
      contract.profiles.net_cash.workbook.sheets[
        "Operating Model"
      ].columns[0].width += 1;
    },
  },
  {
    id: "M13_RED_FONT",
    expected: "maximal:RED_FONT",
    apply(contract) {
      contract.profiles.maximal.workbook.resolved_style_table[0].font.color = {
        rgb: "FFFF0000",
      };
    },
  },
  {
    id: "M14_PRESENTATION_UNOBSERVED",
    expected: "maximal:Operating Model:PRESENTATION",
    apply(contract) {
      delete contract.profiles.maximal.workbook.sheets["Operating Model"]
        .fingerprints.resolved_presentation_surface_sha256;
    },
  },
  {
    id: "M15_CONDITIONAL_FORMAT_UNOBSERVED",
    expected: "net_cash:Operating Model:CF",
    apply(contract) {
      delete contract.profiles.net_cash.workbook.sheets["Operating Model"]
        .fingerprints.resolved_conditional_formats_sha256;
    },
  },
];

function main() {
  const { pins, contract } = loadPinnedInputs();
  const results = mutations.map((mutation) => {
    const candidate = clone(contract);
    mutation.apply(candidate);
    const result = validateContractObject(candidate, pins);
    const caught = result.errors.some((error) => error.id === mutation.expected);
    return {
      mutation: mutation.id,
      expected: mutation.expected,
      caught,
      total_violations: result.errors.length,
      visited: result.visited,
    };
  });
  for (const result of results) {
    run.check(`mutation ${result.mutation} is caught (${result.expected})`, () => {
      assert.ok(
        result.caught,
        `${result.mutation} was accepted; expected finding ${result.expected}`,
      );
      return true;
    });
  }
  const caught = results.filter((result) => result.caught).length;
  run.finish({
    caught,
    total: mutations.length,
    vacuous: results.filter((result) => result.visited === 0).length,
    results,
  });
}

main();
