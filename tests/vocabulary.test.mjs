import test from "node:test";
import assert from "node:assert/strict";
import { applyRating, mergeVocabularyCards, normalizeArticleAndWord, normalizeVocabularyCard } from "../lib/vocabulary-model.js";
import { getCardWeight, selectWeightedCard } from "../lib/vocabulary-selection.js";
import { mapVocabularyHeaders } from "../lib/vocabulary-headers.js";
import { VocabularyStore } from "../lib/vocabulary-store.js";
import { VocabularySyncService } from "../lib/vocabulary-sync.js";

const base = (extra={}) => normalizeVocabularyCard({ id:"1", word:"Woche", unknownCount:0,badCount:0,goodCount:0,easyCount:0,syncStatus:"synced", ...extra });
test("normaliza artículo y espacios",()=>assert.deepEqual(normalizeArticleAndWord("die","  Woche  "),{article:"die",word:"Woche"}));
test("detecta die Woche",()=>assert.deepEqual(normalizeArticleAndWord(null,"die Woche"),{article:"die",word:"Woche"}));
test("evita die die Woche",()=>assert.deepEqual(normalizeArticleAndWord("die","die die Woche"),{article:"die",word:"Woche"}));
for (const rating of ["unknown","bad","good","easy"]) test(`incrementa ${rating}`,()=>assert.equal(applyRating(base(),rating)[`${rating}Count`],1));
test("aprendida exactamente al llegar a diez fáciles",()=>{assert.equal(applyRating(base({easyCount:8}),"easy").learned,false);assert.equal(applyRating(base({easyCount:9}),"easy").learned,true);});
test("eventId hace la valoración idempotente",()=>{const storage=memory();const store=new VocabularyStore(storage);store.data.cards=[base()];store.rateCard("1","good","evt");store.rateCard("1","good","evt");assert.equal(store.data.cards[0].goodCount,1);});
test("calcula peso y aprendidas conservan peso",()=>{assert.equal(getCardWeight(base()),1);assert.ok(getCardWeight(base({learned:true,easyCount:100}))>0);});
test("excluye las tres recientes con contenido suficiente",()=>{const cards=[1,2,3,4].map(id=>base({id:String(id)}));assert.equal(selectWeightedCard(cards,["1","2","3"],()=>0).id,"4");});
test("mapea encabezados tolerantes",()=>{const result=mapVocabularyHeaders([" PUESTO ","DER DIE DAS","Frase  ","Sabida?"]);assert.deepEqual(result,{position:0,article:1,exampleSentence:2,learned:3});});
test("fusión usa lingüística más reciente",()=>{const merged=mergeVocabularyCards(base({meaning:"viejo",updatedAt:"2026-01-01T00:00:00Z"}),base({meaning:"nuevo",updatedAt:"2026-02-01T00:00:00Z"}));assert.equal(merged.meaning,"nuevo");});
test("fusión conserva contador mayor",()=>assert.equal(mergeVocabularyCards(base({badCount:8}),base({badCount:2})).badCount,8));
test("cola offline persiste",()=>{const storage=memory();new VocabularyStore(storage).createCard({word:"Haus"});assert.equal(new VocabularyStore(storage).data.queue.length,1);});
test("crear sin endpoint queda pendiente",async()=>{const store=new VocabularyStore(memory());store.createCard({word:"Haus"});const result=await new VocabularySyncService(store,{configured:false}).sync();assert.equal(result.pendingConfiguration,true);assert.equal(store.data.queue.length,1);});
test("operación pendiente se reintenta y confirma",async()=>{const store=new VocabularyStore(memory());const card=store.createCard({word:"Haus"});const provider={configured:true,async pushChanges(changes){return{results:changes.map(x=>({eventId:x.eventId,success:true,cardId:card.id,position:9,updatedAt:new Date().toISOString()}))}},async pullChanges(){return{serverTime:new Date().toISOString(),cards:[]}}};await new VocabularySyncService(store,provider).sync();assert.equal(store.data.queue.length,0);assert.equal(store.data.cards[0].position,9);});
function memory(){const values=new Map();return{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};}
