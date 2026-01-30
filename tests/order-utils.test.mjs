import assert from "node:assert/strict";

import {
  buildOrderState,
  evaluateOrderState,
  insertFromAvailable,
  moveSelected,
  shouldShowOrderSolution,
} from "../js/order-utils.js";

const baseCard = {
  id: "card-1",
  orderTokens: [
    { id: "t0", text: "hola" },
    { id: "t1", text: "mundo" },
    { id: "t2", text: "hoy" },
  ],
  orderAnswer: ["t0", "t1", "t2"],
};

const moveState = buildOrderState(baseCard);
moveState.selected = ["t0", "t1", "t2"];
moveSelected(moveState, 0, 2);
assert.deepEqual(moveState.selected, ["t1", "t2", "t0"]);

const insertState = buildOrderState(baseCard);
insertState.selected = ["t0"];
insertState.bank = ["t1", "t2"];
insertFromAvailable(insertState, "t2", 1);
assert.deepEqual(insertState.selected, ["t0", "t2"]);
assert.deepEqual(insertState.bank, ["t1"]);

const correctState = buildOrderState(baseCard);
correctState.selected = ["t0", "t1", "t2"];
const correctEval = evaluateOrderState(correctState);
assert.equal(shouldShowOrderSolution(correctEval), false);

const incorrectState = buildOrderState(baseCard);
incorrectState.selected = ["t1", "t0", "t2"];
const incorrectEval = evaluateOrderState(incorrectState);
assert.equal(shouldShowOrderSolution(incorrectEval), true);

console.log("order utils tests passed");
