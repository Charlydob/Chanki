import assert from "node:assert/strict";
import { parseGermanConjugationPaste } from "../lib/verb-conjugation-parser.js";

const expectedVerdienen = `[verdienen]
ich - verdiene
du - verdienst
er / sie / es - verdient
wir - verdienen
ihr - verdient
sie / Sie - verdienen`;

const caseA = `ich verdiene
du verdienst
er/sie/es verdient
wir verdienen
ihr verdient
Sie verdienen`;
assert.equal(parseGermanConjugationPaste(caseA), expectedVerdienen);

const caseB = "ich verdienedu verdienster/sie/es verdientwir verdienenihr verdientSie verdienen";
assert.equal(parseGermanConjugationPaste(caseB), expectedVerdienen);

const caseC = "ich gehedu gehster/sie/es gehtwir gehenihr gehtSie gehen";
assert.equal(
  parseGermanConjugationPaste(caseC),
  `[gehen]
ich - gehe
du - gehst
er / sie / es - geht
wir - gehen
ihr - geht
sie / Sie - gehen`
);

const caseD = "ich bindu bister/sie/es istwir sindihr seidSie sind";
assert.equal(
  parseGermanConjugationPaste(caseD),
  `[sind]
ich - bin
du - bist
er / sie / es - ist
wir - sind
ihr - seid
sie / Sie - sind`
);

console.log("verb conjugation parser tests passed");
