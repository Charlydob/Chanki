import assert from "node:assert/strict";
import { parseGermanConjugationPaste, parseConjugationBlocks } from "../lib/verb-conjugation-parser.js";

const caseA = `ich verdiene\ndu verdienst\ner/sie/es verdient\nwir verdienen\nihr verdient\nSie verdienen`;
const parsedA = parseGermanConjugationPaste(caseA);
assert.equal(parsedA.blocks.length, 1);
assert.equal(parsedA.blocks[0].lines[1].value, "verdienst");

const caseB = "ich gehedu gehster/sie/es gehtwir gehenihr gehtSie gehen";
const parsedB = parseGermanConjugationPaste(caseB);
assert.equal(parsedB.blocks[0].lines[2].value, "geht");

const caseE = `INDIKATIV PRÄSENS
ich gehedu gehster/sie/es gehtwir gehenihr gehtSie gehen
INDIKATIV PRÄTERITUM
ich gingdu gingster/sie/es gingwir gingenihr gingtSie gingen
IMPERATIV PRÄSENS
gehe (du)gehen wirgeht ihrgehen Sie
geh (du)gehen wirgeht ihrgehen Sie`;
const blocks = parseConjugationBlocks(caseE);
assert.equal(blocks.length, 3);
assert.equal(blocks[2].heading, "IMPERATIV PRÄSENS");

console.log("verb conjugation parser tests passed");
