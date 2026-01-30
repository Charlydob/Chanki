import assert from "node:assert/strict";

import { parseChankiImport } from "../lib/parser.js";

const singleOrderInput = `
FOLDER: Test
TAGS: uno,dos
TYPE: ORDER
FRONT: Hola mundo
TOKENS: hola | mundo
LABELS: Int | N
ANSWER: 1,0
---
`;

const parsedSingle = parseChankiImport(singleOrderInput);
assert.equal(parsedSingle.errors.length, 0);
assert.equal(parsedSingle.blocks.length, 1);
assert.equal(parsedSingle.blocks[0].cards.length, 1);
assert.equal(parsedSingle.blocks[0].cards[0].type, "order");
assert.equal(parsedSingle.blocks[0].cards[0].front, "Hola mundo");
assert.deepEqual(
  parsedSingle.blocks[0].cards[0].orderTokens.map((token) => token.text),
  ["hola", "mundo"]
);
assert.deepEqual(parsedSingle.blocks[0].cards[0].orderAnswer, ["t1", "t0"]);

const multipleOrderInput = `
TYPE: ORDER
FRONT: Primera
TOKENS: a | b
LABELS: L1 | L2
ANSWER: 0,1
---
TYPE: ORDER
FRONT: Segunda
TOKENS: c | d | e
LABELS: L3 | L4 | L5
ANSWER: 2,1,0
---
`;

const parsedMultiple = parseChankiImport(multipleOrderInput);
assert.equal(parsedMultiple.errors.length, 0);
assert.equal(parsedMultiple.blocks.length, 1);
assert.equal(parsedMultiple.blocks[0].cards.length, 2);

const noTrailingSeparatorInput = `
TYPE: ORDER
FRONT: Sin separador final
TOKENS: uno | dos
LABELS: L1 | L2
ANSWER: 1,0
`;

const parsedNoSeparator = parseChankiImport(noTrailingSeparatorInput);
assert.equal(parsedNoSeparator.errors.length, 0);
assert.equal(parsedNoSeparator.blocks.length, 1);
assert.equal(parsedNoSeparator.blocks[0].cards.length, 1);

const unknownTypeInput = `
TYPE: RARE
FRONT: Hola
BACK: Adios
---
`;

const parsedUnknown = parseChankiImport(unknownTypeInput);
assert.equal(parsedUnknown.blocks.length, 0);
assert.equal(parsedUnknown.errors.length, 1);
assert.match(parsedUnknown.errors[0].message, /TYPE inválido/i);

console.log("parser tests passed");
