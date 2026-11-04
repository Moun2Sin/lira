/*
 * NLU — модуль понимания естественного языка.
 *
 * Модель: многоклассовая логистическая регрессия (softmax, однослойная нейросеть)
 * над признаками TF-IDF (слова, биграммы слов, символьные триграммы).
 * Обучение: мини-пакетный градиентный спуск с L2-регуляризацией.
 * Оценка: стратифицированное разбиение train/test, accuracy, precision/recall/F1,
 * матрица ошибок.
 *
 * Работает и в браузере (window.NLU), и в Node.js (require('./nlu.js')).
 */
(function (root) {
  "use strict";

  // ---------- Предобработка текста ----------
  const STOP = new Set(["пожалуйста", "ну", "а", "же", "мне", "ка", "давай", "можешь", "скажи-ка"]);

  function normalize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^a-zа-я0-9\s-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenize(text) {
    return normalize(text).split(" ").filter((w) => w && !STOP.has(w));
  }

  // Признаки: слова, биграммы слов, символьные 3-граммы (устойчивы к окончаниям и опечаткам)
  function features(text) {
    const words = tokenize(text);
    const out = [];
    for (let i = 0; i < words.length; i++) {
      out.push("w:" + words[i]);
      if (i > 0) out.push("b:" + words[i - 1] + "_" + words[i]);
      const padded = "<" + words[i] + ">";
      for (let j = 0; j + 3 <= padded.length; j++) out.push("c:" + padded.slice(j, j + 3));
    }
    return out;
  }

  // ---------- Генератор псевдослучайных чисел (воспроизводимость) ----------
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function shuffle(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ---------- Модель ----------
  class IntentClassifier {
    constructor(opts = {}) {
      this.opts = Object.assign({ epochs: 200, lr: 1.2, l2: 0.0005, batch: 16, seed: 42 }, opts);
      this.labels = [];
      this.vocab = {};   // признак -> индекс
      this.idf = [];
      this.W = [];       // [класс][признак]
      this.b = [];
      this.history = [];
      this.trainedAt = null;
    }

    // TF-IDF вектор в разреженном виде: {idx: [], val: []}
    vectorize(text) {
      const counts = new Map();
      for (const f of features(text)) {
        const k = this.vocab[f];
        if (k !== undefined) counts.set(k, (counts.get(k) || 0) + 1);
      }
      const idx = [], val = [];
      let norm = 0;
      for (const [k, c] of counts) {
        const v = (1 + Math.log(c)) * this.idf[k];
        idx.push(k); val.push(v); norm += v * v;
      }
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < val.length; i++) val[i] /= norm;
      return { idx, val };
    }

    logits(x) {
      const z = new Array(this.labels.length);
      for (let c = 0; c < z.length; c++) {
        let s = this.b[c];
        const w = this.W[c];
        for (let i = 0; i < x.idx.length; i++) s += w[x.idx[i]] * x.val[i];
        z[c] = s;
      }
      return z;
    }

    static softmax(z) {
      const m = Math.max(...z);
      const e = z.map((v) => Math.exp(v - m));
      const s = e.reduce((a, b) => a + b, 0);
      return e.map((v) => v / s);
    }

    /**
     * Обучение.
     * @param {Array<{text:string,label:string}>} samples
     * @param {function} onEpoch — колбэк прогресса ({epoch, loss, acc})
     */
    fit(samples, onEpoch) {
      const o = this.opts;
      const rand = rng(o.seed);
      this.labels = [...new Set(samples.map((s) => s.label))].sort();
      const labelIdx = Object.fromEntries(this.labels.map((l, i) => [l, i]));

      // Словарь и IDF
      this.vocab = {};
      const df = [];
      for (const s of samples) {
        const seen = new Set(features(s.text));
        for (const f of seen) {
          if (this.vocab[f] === undefined) { this.vocab[f] = df.length; df.push(0); }
          df[this.vocab[f]]++;
        }
      }
      const N = samples.length;
      this.idf = df.map((d) => Math.log((1 + N) / (1 + d)) + 1);

      const V = df.length, C = this.labels.length;
      this.W = Array.from({ length: C }, () => new Float64Array(V));
      this.b = new Float64Array(C);

      const data = samples.map((s) => ({ x: this.vectorize(s.text), y: labelIdx[s.label] }));
      this.history = [];

      for (let ep = 1; ep <= o.epochs; ep++) {
        shuffle(data, rand);
        const lr = o.lr / (1 + 0.02 * ep); // затухание шага обучения
        let loss = 0, correct = 0;
        for (let start = 0; start < data.length; start += o.batch) {
          const batch = data.slice(start, start + o.batch);
          const gW = new Map(); // "c:k" -> градиент (разреженно)
          const gb = new Float64Array(C);
          for (const { x, y } of batch) {
            const p = IntentClassifier.softmax(this.logits(x));
            loss += -Math.log(Math.max(p[y], 1e-12));
            if (p.indexOf(Math.max(...p)) === y) correct++;
            for (let c = 0; c < C; c++) {
              const g = p[c] - (c === y ? 1 : 0);
              gb[c] += g;
              for (let i = 0; i < x.idx.length; i++) {
                const key = c * V + x.idx[i];
                gW.set(key, (gW.get(key) || 0) + g * x.val[i]);
              }
            }
          }
          const n = batch.length;
          for (const [key, g] of gW) {
            const c = Math.floor(key / V), k = key % V;
            this.W[c][k] -= lr * (g / n + o.l2 * this.W[c][k]);
          }
          for (let c = 0; c < C; c++) this.b[c] -= lr * (gb[c] / n);
        }
        const rec = { epoch: ep, loss: loss / data.length, acc: correct / data.length };
        this.history.push(rec);
        if (onEpoch) onEpoch(rec);
      }
      this.trainedAt = new Date().toISOString();
      return this;
    }

    /** Предсказание: {intent, confidence, ranking:[{intent,p}], known} */
    predict(text) {
      const x = this.vectorize(text);
      const p = IntentClassifier.softmax(this.logits(x));
      const ranking = this.labels
        .map((l, i) => ({ intent: l, p: p[i] }))
        .sort((a, b) => b.p - a.p);
      return { intent: ranking[0].intent, confidence: ranking[0].p, ranking, known: x.idx.length };
    }

    toJSON() {
      return {
        format: "intent-softmax-tfidf/1",
        opts: this.opts,
        labels: this.labels,
        vocab: this.vocab,
        idf: this.idf.map((v) => +v.toFixed(6)),
        W: this.W.map((row) => Array.from(row, (v) => +v.toFixed(6))),
        b: Array.from(this.b, (v) => +v.toFixed(6)),
        history: this.history,
        trainedAt: this.trainedAt
      };
    }

    static fromJSON(j) {
      const m = new IntentClassifier(j.opts);
      m.labels = j.labels; m.vocab = j.vocab; m.idf = j.idf;
      m.W = j.W.map((r) => Float64Array.from(r));
      m.b = Float64Array.from(j.b);
      m.history = j.history || []; m.trainedAt = j.trainedAt;
      return m;
    }
  }

  // ---------- Подготовка данных и оценка качества ----------
  function datasetToSamples(dataset) {
    const out = [];
    for (const label of Object.keys(dataset))
      for (const text of dataset[label]) out.push({ text, label });
    return out;
  }

  // Стратифицированное разбиение: из каждого класса testShare примеров в тест
  function stratifiedSplit(samples, testShare = 0.2, seed = 7) {
    const rand = rng(seed);
    const by = {};
    for (const s of samples) (by[s.label] = by[s.label] || []).push(s);
    const train = [], test = [];
    for (const label of Object.keys(by)) {
      const arr = shuffle(by[label].slice(), rand);
      const k = Math.max(1, Math.round(arr.length * testShare));
      test.push(...arr.slice(0, k));
      train.push(...arr.slice(k));
    }
    return { train, test };
  }

  function evaluate(model, test) {
    const L = model.labels;
    const idx = Object.fromEntries(L.map((l, i) => [l, i]));
    const cm = L.map(() => L.map(() => 0));
    const errors = [];
    for (const s of test) {
      const p = model.predict(s.text);
      cm[idx[s.label]][idx[p.intent]]++;
      if (p.intent !== s.label) errors.push({ text: s.text, expected: s.label, got: p.intent, p: p.confidence });
    }
    const perClass = L.map((l, i) => {
      const tp = cm[i][i];
      const fp = cm.reduce((a, row, r) => a + (r !== i ? row[i] : 0), 0);
      const fn = cm[i].reduce((a, v, c) => a + (c !== i ? v : 0), 0);
      const precision = tp + fp ? tp / (tp + fp) : 0;
      const recall = tp + fn ? tp / (tp + fn) : 0;
      const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
      return { label: l, precision, recall, f1, support: tp + fn };
    });
    const correct = L.reduce((a, _, i) => a + cm[i][i], 0);
    const macroF1 = perClass.reduce((a, c) => a + c.f1, 0) / perClass.length;
    return { accuracy: correct / test.length, macroF1, perClass, confusion: cm, labels: L, errors, n: test.length };
  }

  /**
   * Полный цикл: обучение на train → оценка на test → финальное обучение на всех данных.
   */
  function trainPipeline(dataset, opts = {}, onEpoch) {
    const samples = datasetToSamples(dataset);
    const { train, test } = stratifiedSplit(samples, 0.2);
    const evalModel = new IntentClassifier(opts).fit(train);
    const report = evaluate(evalModel, test);
    const model = new IntentClassifier(opts).fit(samples, onEpoch);
    report.trainSize = train.length;
    report.testSize = test.length;
    report.totalSize = samples.length;
    report.features = Object.keys(model.vocab).length;
    return { model, report };
  }

  const NLU = { normalize, tokenize, features, IntentClassifier, datasetToSamples, stratifiedSplit, evaluate, trainPipeline };
  if (typeof module !== "undefined" && module.exports) module.exports = NLU;
  else root.NLU = NLU;
})(typeof self !== "undefined" ? self : this);
