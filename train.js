#!/usr/bin/env node
/*
 * Обучение модели намерений из командной строки.
 *   node train.js
 * Результат: data/model.js (веса для приложения) и data/report.json (метрики).
 */
const fs = require("fs");
const path = require("path");
const NLU = require("./nlu.js");
const DATASET = require("./data/dataset.js");

const t0 = Date.now();
const { model, report } = NLU.trainPipeline(DATASET, {}, (e) => {
  if (e.epoch % 20 === 0 || e.epoch === 1)
    console.log(`эпоха ${String(e.epoch).padStart(3)}  loss=${e.loss.toFixed(4)}  acc=${(e.acc * 100).toFixed(1)}%`);
});

console.log("\nВыборка: всего", report.totalSize, "| обучение", report.trainSize, "| тест", report.testSize);
console.log("Признаков:", report.features, "| классов:", report.labels.length);
console.log(`Точность на тесте (accuracy): ${(report.accuracy * 100).toFixed(1)}%`);
console.log(`Macro F1: ${(report.macroF1 * 100).toFixed(1)}%\n`);
console.log("Класс".padEnd(14), "Precision  Recall   F1     n");
for (const c of report.perClass)
  console.log(c.label.padEnd(14), (c.precision * 100).toFixed(0).padStart(6) + "%", (c.recall * 100).toFixed(0).padStart(6) + "%",
    (c.f1 * 100).toFixed(0).padStart(5) + "%", String(c.support).padStart(4));
if (report.errors.length) {
  console.log("\nОшибки на тесте:");
  for (const e of report.errors) console.log(`  «${e.text}»: ожидалось ${e.expected}, получено ${e.got} (${(e.p * 100).toFixed(0)}%)`);
}

const out = path.join(__dirname, "data");
fs.writeFileSync(path.join(out, "model.js"),
  "/* Сгенерировано train.js — предобученная модель намерений */\n" +
  "(function(r){var M=" + JSON.stringify(model.toJSON()) + ";var R=" + JSON.stringify(report) +
  ";if(typeof module!=='undefined'&&module.exports)module.exports={model:M,report:R};else{r.PRETRAINED=M;r.PRETRAINED_REPORT=R;}})(typeof self!=='undefined'?self:this);\n");
fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(`\nГотово за ${((Date.now() - t0) / 1000).toFixed(1)} с → data/model.js, data/report.json`);
