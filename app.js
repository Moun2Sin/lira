/*
 * Лира — голосовой помощник.
 * Архитектура (см. пояснительную записку):
 *   SpeechInput  — распознавание речи (Web Speech API, Google)
 *   SpeechOutput — синтез речи (speechSynthesis)
 *   NLU          — обученный классификатор намерений (nlu.js)
 *   EntityExtractor — извлечение параметров (город, сайт, программа, запрос)
 *   Skills       — обработчики намерений (время, погода, сайты, программы, поиск, Википедия)
 *   DialogManager — связывает всё вместе: текст → намерение → навык → ответ
 *   Store        — настройки и пользовательские примеры (localStorage)
 *   UI           — интерфейс
 */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const INTENT_NAMES = {
    greeting: "приветствие", goodbye: "прощание", thanks: "благодарность", how_are_you: "как дела",
    about: "о помощнике", capabilities: "возможности", time: "время", date: "дата", weather: "погода",
    open_site: "открыть сайт", open_app: "запустить программу", search: "поиск", wikipedia: "справка", stop: "стоп"
  };

  // ================= Store =================
  const Store = {
    key: "lira.v1",
    defaults: { name: "Лира", city: "Алматы", voice: "", rate: 1.05, threshold: 0.4, speak: true, userExamples: [] },
    load() {
      try { return Object.assign({}, this.defaults, JSON.parse(localStorage.getItem(this.key) || "{}")); }
      catch (e) { return Object.assign({}, this.defaults); }
    },
    save(s) { try { localStorage.setItem(this.key, JSON.stringify(s)); } catch (e) { /* хранилище недоступно */ } },
    saveModel(m) { try { localStorage.setItem(this.key + ".model", JSON.stringify(m)); } catch (e) { } },
    loadModel() { try { return JSON.parse(localStorage.getItem(this.key + ".model") || "null"); } catch (e) { return null; } },
    clear() { try { localStorage.removeItem(this.key); localStorage.removeItem(this.key + ".model"); } catch (e) { } }
  };
  const settings = Store.load();

  // ================= Склонения и числа =================
  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  // ================= SpeechOutput =================
  const SpeechOutput = {
    voices: [],
    init() {
      if (!("speechSynthesis" in window)) return;
      const load = () => {
        this.voices = speechSynthesis.getVoices().filter((v) => /^ru/i.test(v.lang));
        UI.fillVoices(this.voices);
      };
      load();
      speechSynthesis.onvoiceschanged = load;
    },
    say(text, onEnd) {
      if (!settings.speak || !("speechSynthesis" in window) || !text) { onEnd && onEnd(); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/[«»]/g, ""));
      u.lang = "ru-RU";
      u.rate = settings.rate;
      const v = this.voices.find((x) => x.name === settings.voice) || this.voices[0];
      if (v) u.voice = v;
      u.onstart = () => UI.setMic("speaking");
      u.onend = u.onerror = () => { UI.setMic(SpeechInput.active ? "listening" : "idle"); onEnd && onEnd(); };
      speechSynthesis.speak(u);
    },
    stop() { if ("speechSynthesis" in window) speechSynthesis.cancel(); UI.setMic(SpeechInput.active ? "listening" : "idle"); }
  };

  // ================= SpeechInput =================
  const SpeechInput = {
    rec: null, active: false, wake: false, supported: false,
    init() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        UI.notice("Распознавание речи не поддерживается этим браузером. Откройте помощника в Google Chrome или Microsoft Edge. Пока можно вводить команды текстом.");
        $("#btnMic").disabled = true;
        return;
      }
      this.supported = true;
      const rec = new SR();
      rec.lang = "ru-RU";
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onstart = () => { this.active = true; UI.setMic("listening"); };
      rec.onresult = (e) => {
        let interim = "", final = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) final += t; else interim += t;
        }
        UI.interim(interim);
        if (final.trim()) this.onFinal(final.trim());
      };
      rec.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") {
          this.wake = false; $("#wakeToggle").checked = false;
          UI.notice("Нет доступа к микрофону. Разрешите микрофон для этой страницы (значок замка в адресной строке) и откройте её через start.bat — по адресу http://localhost:8765.");
        } else if (e.error === "network") {
          UI.notice("Распознаванию речи нужен интернет (сервис Google). Проверьте подключение или вводите команды текстом.");
        }
      };
      rec.onend = () => {
        this.active = false;
        UI.interim("");
        if (this.wake) setTimeout(() => this.start(), 250); // постоянный режим: перезапуск
        else UI.setMic("idle");
      };
      this.rec = rec;
    },
    onFinal(text) {
      if (this.wake) {
        // Постоянный режим: реагируем только на обращение по имени
        const name = NLU.normalize(settings.name);
        const n = NLU.normalize(text);
        const i = n.indexOf(name);
        if (i === -1) return;
        const cmd = n.slice(i + name.length).trim();
        if (!cmd) { DialogManager.respond({ text: "Слушаю." }); return; }
        DialogManager.handle(cmd, "голос");
      } else {
        DialogManager.handle(text, "голос");
      }
    },
    start() {
      if (!this.rec || this.active) return;
      SpeechOutput.stop();
      this.rec.continuous = this.wake;
      try { this.rec.start(); } catch (e) { /* уже запущено */ }
    },
    stop() { if (this.rec) { this.wake && (this.wake = false); this.rec.stop(); } },
    toggle() { this.active ? this.rec.stop() : this.start(); },
    setWake(on) {
      this.wake = on;
      if (this.active) this.rec.stop(); // onend перезапустит в нужном режиме
      else if (on) this.start();
    }
  };

  // ================= EntityExtractor =================
  const SITES = [
    [["яндекс музык"], "Яндекс Музыка", "https://music.yandex.ru"],
    [["гугл карт", "google карт"], "Google Карты", "https://maps.google.com"],
    [["ютуб", "youtube", "ютюб"], "YouTube", "https://www.youtube.com"],
    [["гугл", "google", "гугол"], "Google", "https://www.google.com"],
    [["яндекс", "yandex"], "Яндекс", "https://ya.ru"],
    [["вконтакт", "вк", "vk"], "ВКонтакте", "https://vk.com"],
    [["почт", "gmail", "джимейл"], "Gmail", "https://mail.google.com"],
    [["карт"], "Карты", "https://2gis.kz"],
    [["переводчик", "translate"], "Google Переводчик", "https://translate.google.com"],
    [["гитхаб", "github"], "GitHub", "https://github.com"],
    [["википеди", "wikipedia"], "Википедия", "https://ru.wikipedia.org"],
    [["телеграм", "telegram"], "Telegram Web", "https://web.telegram.org"],
    [["инстаграм", "instagram"], "Instagram", "https://www.instagram.com"],
    [["chatgpt", "чат гпт", "чатгпт"], "ChatGPT", "https://chatgpt.com"],
    [["claude", "клод"], "Claude", "https://claude.ai"]
  ];
  const APPS = [
    [["блокнот", "notepad"], "notepad", "Блокнот"],
    [["калькулятор", "calc"], "calculator", "Калькулятор"],
    [["проводник", "explorer", "файл"], "explorer", "Проводник"],
    [["paint", "пейнт", "паинт"], "paint", "Paint"],
    [["командн", "терминал", "cmd", "консол"], "terminal", "Командная строка"],
    [["диспетчер"], "taskmgr", "Диспетчер задач"],
    [["панел"], "control", "Панель управления"],
    [["настройк", "параметр"], "settings", "Параметры"],
    [["ворд", "word"], "word", "Microsoft Word"],
    [["эксел", "excel", "иксель"], "excel", "Microsoft Excel"],
    [["powerpoint", "пауэрпоинт", "презентац"], "powerpoint", "PowerPoint"],
    [["браузер"], "browser", "Браузер"]
  ];

  const EntityExtractor = {
    findIn(table, text) {
      const words = NLU.normalize(text).split(" ");
      const joined = " " + words.join(" ") + " ";
      for (const row of table)
        for (const key of row[0]) {
          if (key.includes(" ") ? joined.includes(" " + key) : words.some((w) => w.startsWith(key))) return row;
        }
      return null;
    },
    site(text) { const r = this.findIn(SITES, text); return r && { name: r[1], url: r[2] }; },
    app(text) { const r = this.findIn(APPS, text); return r && { id: r[1], name: r[2] }; },
    day(text) {
      const n = NLU.normalize(text);
      if (/послезавтра/.test(n)) return 2;
      if (/завтра/.test(n)) return 1;
      return 0;
    },
    city(text) {
      const n = NLU.normalize(text).replace(/\b(сегодня|завтра|послезавтра|сейчас|будет|погода|погоду|какая|прогноз)\b/g, " ").replace(/\s+/g, " ");
      const m = n.match(/(?:^|\s)(?:в|во|для|по)\s+([а-яa-z-]+(?:\s+[а-яa-z-]+)?)\s*$/) || n.match(/(?:^|\s)(?:в|во)\s+([а-яa-z-]+)/);
      return m ? m[1].trim() : null;
    },
    // Варианты начальной формы для предложного падежа: «в Москве» → «Москва»
    cityVariants(c) {
      const out = [c];
      const w = c.split(" "), last = w.pop(), pre = w.length ? w.join(" ") + " " : "";
      if (/е$/.test(last)) out.push(pre + last.slice(0, -1) + "а", pre + last.slice(0, -1), pre + last.slice(0, -1) + "ь", pre + last.slice(0, -1) + "о");
      if (/и$/.test(last)) out.push(pre + last.slice(0, -1) + "ь", pre + last.slice(0, -1) + "я");
      if (/ске$/.test(last)) out.push(pre + last.slice(0, -1));
      return [...new Set(out)];
    },
    query(text, triggers) {
      let q = " " + NLU.normalize(text) + " ";
      for (const t of triggers) q = q.replace(new RegExp(" " + t + " ", "g"), " ");
      return q.replace(/\s+/g, " ").trim();
    }
  };

  // ================= Внешние сервисы =================
  const WMO = {
    0: "ясно", 1: "преимущественно ясно", 2: "переменная облачность", 3: "пасмурно", 45: "туман", 48: "изморозь и туман",
    51: "лёгкая морось", 53: "морось", 55: "сильная морось", 56: "ледяная морось", 57: "ледяная морось",
    61: "небольшой дождь", 63: "дождь", 65: "сильный дождь", 66: "ледяной дождь", 67: "ледяной дождь",
    71: "небольшой снег", 73: "снег", 75: "сильный снег", 77: "снежная крупа", 80: "ливень", 81: "ливни", 82: "сильные ливни",
    85: "снегопад", 86: "сильный снегопад", 95: "гроза", 96: "гроза с градом", 99: "сильная гроза с градом"
  };
  async function getJSON(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  const WeatherService = {
    async geocode(city) {
      for (const v of EntityExtractor.cityVariants(city)) {
        const j = await getJSON("https://geocoding-api.open-meteo.com/v1/search?count=1&language=ru&name=" + encodeURIComponent(v));
        if (j.results && j.results.length) return j.results[0];
      }
      return null;
    },
    async forecast(place) {
      return getJSON("https://api.open-meteo.com/v1/forecast?latitude=" + place.latitude + "&longitude=" + place.longitude +
        "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
        "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&wind_speed_unit=ms&forecast_days=4");
    }
  };
  const WikiService = {
    async lookup(topic) {
      const s = await getJSON("https://ru.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&format=json&origin=*&srsearch=" + encodeURIComponent(topic));
      const hit = s.query && s.query.search && s.query.search[0];
      if (!hit) return null;
      return getJSON("https://ru.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(hit.title.replace(/ /g, "_")));
    }
  };
  const LocalServer = {
    online: false,
    async ping() {
      if (location.protocol === "file:") { this.online = false; return false; }
      try { const r = await fetch("/api/ping", { cache: "no-store" }); this.online = r.ok && (await r.json()).ok; }
      catch (e) { this.online = false; }
      return this.online;
    },
    async open(app) {
      const r = await fetch("/api/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ app }) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "ошибка запуска");
      return j;
    }
  };

  // ================= Навыки (обработчики намерений) =================
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const Skills = {
    greeting: () => ({ text: pick(["Привет! Чем могу помочь?", "Здравствуйте! Слушаю вас.", "Привет! Спросите время, погоду или попросите что-нибудь открыть."]) }),
    goodbye: () => { SpeechInput.wake && UI.setWake(false); return { text: pick(["До встречи!", "Пока! Обращайтесь.", "Всего доброго!"]) }; },
    thanks: () => ({ text: pick(["Пожалуйста!", "Рада помочь.", "Обращайтесь!"]) }),
    how_are_you: () => ({ text: pick(["Всё отлично, модель обучена и готова к работе. А у вас как?", "Хорошо, спасибо! Чем помочь?"]) }),
    about: () => ({ text: `Я ${settings.name}, голосовой помощник. Ваши команды я понимаю с помощью собственной модели машинного обучения, обученной на ${Model.report ? Model.report.totalSize : "нескольких сотнях"} примерах фраз.` }),
    capabilities: () => ({
      text: "Я умею называть время и дату, рассказывать погоду в любом городе, открывать сайты и программы, искать в интернете и отвечать на вопросы «что такое» и «кто такой» по Википедии.",
      card: '<div class="card"><b>Примеры команд</b><span class="muted">«Который час» · «Погода завтра в Москве» · «Открой YouTube» · «Запусти калькулятор» · «Найди рецепт плова» · «Что такое UML»</span></div>'
    }),
    stop: () => { SpeechOutput.stop(); return { text: "Хорошо.", silent: true }; },

    time: () => {
      const d = new Date(), h = d.getHours(), m = d.getMinutes();
      return {
        text: `Сейчас ${h} ${plural(h, "час", "часа", "часов")} ${m} ${plural(m, "минута", "минуты", "минут")}.`,
        card: `<div class="card"><b style="font:600 32px var(--font-display)">${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}</b><span class="muted">${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}</span></div>`
      };
    },
    date: () => {
      const d = new Date();
      const s = d.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      return { text: "Сегодня " + s.replace(/ г\.$/, " года") + "." };
    },

    async weather(text) {
      const city = EntityExtractor.city(text) || settings.city;
      const day = EntityExtractor.day(text);
      const place = await WeatherService.geocode(city);
      if (!place) return { text: `Не нашла город «${city}». Попробуйте назвать его иначе.` };
      const f = await WeatherService.forecast(place);
      const name = place.name;
      const days = f.daily.time.map((t, i) => {
        const dd = new Date(t + "T12:00");
        return `<span>${i === 0 ? "сегодня" : dd.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric" })} ${Math.round(f.daily.temperature_2m_min[i])}…${Math.round(f.daily.temperature_2m_max[i])}°</span>`;
      }).join("");
      let say, big, line, head;
      if (day === 0) {
        const c = f.current, t = Math.round(c.temperature_2m), fl = Math.round(c.apparent_temperature);
        const desc = WMO[c.weather_code] || "без осадков";
        say = `В городе ${name} сейчас ${t} ${plural(t, "градус", "градуса", "градусов")}, ${desc}. Ощущается как ${fl}. Ветер ${Math.round(c.wind_speed_10m)} метров в секунду.`;
        big = `${t > 0 ? "+" : ""}${t}°`; line = `ощущается ${fl}° · ветер ${Math.round(c.wind_speed_10m)} м/с · влажность ${c.relative_humidity_2m}%`;
        head = desc;
      } else {
        const i = day, mx = Math.round(f.daily.temperature_2m_max[i]), mn = Math.round(f.daily.temperature_2m_min[i]);
        const desc = WMO[f.daily.weather_code[i]] || "без осадков", pp = f.daily.precipitation_probability_max[i];
        say = `${day === 1 ? "Завтра" : "Послезавтра"} в городе ${name} от ${mn} до ${mx} ${plural(mx, "градуса", "градусов", "градусов")}, ${desc}. Вероятность осадков ${pp} процентов.`;
        big = `${mx > 0 ? "+" : ""}${mx}°`; line = `ночью ${mn}° · осадки ${pp}%`;
        head = (day === 1 ? "завтра, " : "послезавтра, ") + desc;
      }
      const card = `<div class="card weather"><span class="t">${big}</span><span class="w">${esc(name)}${place.country ? ", " + esc(place.country) : ""} · ${esc(head)}</span><span class="d">${esc(line)}</span><div class="days">${days}</div></div>`;
      return { text: say, card };
    },

    open_site(text) {
      const s = EntityExtractor.site(text);
      if (!s) return { text: "Какой сайт открыть? Например: YouTube, Google, ВКонтакте, Gmail." };
      const w = window.open(s.url, "_blank", "noopener");
      return {
        text: `Открываю ${s.name}.`,
        card: `<div class="card"><span>${esc(s.name)}${w ? "" : " — браузер заблокировал всплывающее окно, нажмите кнопку"}</span><a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">Открыть ${esc(s.name)}</a></div>`
      };
    },

    async open_app(text) {
      const a = EntityExtractor.app(text);
      if (!a) return { text: "Какую программу запустить? Я знаю блокнот, калькулятор, проводник, Paint, Word, Excel и другие." };
      if (!LocalServer.online) await LocalServer.ping();
      if (!LocalServer.online)
        return { text: `Чтобы запускать программы, откройте меня через файл start.bat — так включится локальный сервер. Сейчас я не могу открыть ${a.name}.` };
      try { await LocalServer.open(a.id); return { text: `Запускаю ${a.name}.` }; }
      catch (e) { return { text: `Не получилось запустить ${a.name}: ${e.message}.` }; }
    },

    search(text) {
      const q = EntityExtractor.query(text, ["найди в интернете", "поищи в интернете", "найди в гугле", "поищи в гугле", "найди в яндексе", "поищи в яндексе",
        "в интернете", "в гугле", "в яндексе", "в сети", "загугли", "найди", "поищи", "поиск", "ищи", "мне", "пожалуйста", "информацию о", "информацию про"]);
      if (!q) return { text: "Что найти?" };
      const url = "https://www.google.com/search?q=" + encodeURIComponent(q);
      const w = window.open(url, "_blank", "noopener");
      return {
        text: `Ищу в интернете: ${q}.`,
        card: `<div class="card"><span>Запрос: <b>${esc(q)}</b>${w ? "" : " — нажмите, чтобы открыть результаты"}</span><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">Результаты поиска</a></div>`
      };
    },

    async wikipedia(text) {
      const topic = EntityExtractor.query(text, ["найди в википедии", "посмотри в википедии", "в википедии", "википедия", "что такое", "кто такой", "кто такая", "кто такие",
        "расскажи про", "расскажи о", "расскажи об", "что известно о", "что известно про", "что означает слово", "что означает", "что значит", "расскажи"]);
      if (!topic) return { text: "О чём рассказать?" };
      const p = await WikiService.lookup(topic);
      if (!p || !p.extract) return { text: `Не нашла в Википедии статью про «${topic}». Могу поискать в интернете.` };
      const sentences = p.extract.replace(/\s*\([^)]*\)/g, "").match(/[^.!?]+[.!?]+/g) || [p.extract];
      const spoken = sentences.slice(0, 2).join(" ").trim();
      const img = p.thumbnail ? `<img src="${esc(p.thumbnail.source)}" alt="">` : "";
      const link = p.content_urls && p.content_urls.desktop ? p.content_urls.desktop.page : "https://ru.wikipedia.org";
      return {
        text: spoken,
        card: `<div class="card wiki">${img}<h4>${esc(p.title)}</h4><span class="muted small">${esc(p.description || "Википедия")}</span><a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Читать в Википедии</a></div>`
      };
    }
  };

  // ================= Модель =================
  const Model = {
    clf: null, report: null,
    allData() {
      const d = JSON.parse(JSON.stringify(window.DATASET));
      for (const ex of settings.userExamples) (d[ex.intent] = d[ex.intent] || []).push(ex.text);
      return d;
    },
    init() {
      const saved = Store.loadModel();
      if (saved && saved.model) { this.clf = NLU.IntentClassifier.fromJSON(saved.model); this.report = saved.report; }
      else if (window.PRETRAINED) { this.clf = NLU.IntentClassifier.fromJSON(window.PRETRAINED); this.report = window.PRETRAINED_REPORT; }
      else this.retrain();
      UI.modelReady();
    },
    retrain() {
      const t0 = performance.now();
      const { model, report } = NLU.trainPipeline(this.allData());
      report.ms = Math.round(performance.now() - t0);
      this.clf = model; this.report = report;
      if (settings.userExamples.length) Store.saveModel({ model: model.toJSON(), report });
      else Store.saveModel(null);
      return report;
    },
    predict(text) { return this.clf.predict(text); }
  };

  // ================= DialogManager =================
  const DialogManager = {
    busy: false,
    async handle(text, via) {
      text = String(text || "").trim();
      if (!text) return;
      UI.hideHints();
      UI.userMsg(text, via);
      const p = Model.predict(text);
      let intent = p.intent;
      // Гибридный подход: словарь сущностей уточняет близкие классы «сайт / программа»
      if (intent === "open_site" || intent === "open_app") {
        const app = EntityExtractor.app(text), site = EntityExtractor.site(text);
        if (app && !site) intent = "open_app";
        else if (site && !app) intent = "open_site";
      }
      const low = p.confidence < settings.threshold || p.known === 0;
      const meta = { intent, confidence: p.confidence, low, text };
      if (low) {
        const alt = p.ranking.slice(0, 2).map((r) => INTENT_NAMES[r.intent]).join(" или ");
        return this.respond({ text: `Я не уверена, что поняла. Вы имели в виду ${alt}? Можно поправить меня — нажмите «исправить» под ответом.` }, meta);
      }
      UI.setMic("thinking");
      try {
        const res = await Skills[intent](text);
        this.respond(res, meta);
      } catch (e) {
        this.respond({ text: "Не удалось получить данные из интернета. Проверьте подключение и попробуйте ещё раз." }, meta);
      }
    },
    respond(res, meta) {
      UI.botMsg(res, meta);
      if (!res.silent) SpeechOutput.say(res.text);
      else UI.setMic(SpeechInput.active ? "listening" : "idle");
    }
  };

  // ================= UI =================
  const UI = {
    log: null,
    init() {
      this.log = $("#log");
      $("#assistantName").textContent = settings.name;
      document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => this.show(t.dataset.view)));
      $("#btnMic").addEventListener("click", () => SpeechInput.toggle());
      $("#textForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const v = $("#textInput").value; $("#textInput").value = "";
        DialogManager.handle(v, "текст");
      });
      document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => DialogManager.handle(c.dataset.say, "подсказка")));
      $("#wakeToggle").addEventListener("change", (e) => this.setWake(e.target.checked));
      document.addEventListener("keydown", (e) => {
        if (e.code === "Space" && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName) && !$("#view-chat").hidden) {
          e.preventDefault(); SpeechInput.toggle();
        }
      });
      this.initTrain();
      this.initSettings();
      this.welcome();
    },
    show(view) {
      document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", t.dataset.view === view));
      document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== "view-" + view));
      if (view === "train") this.renderTrain();
    },
    welcome() {
      this.botMsg({ text: `Здравствуйте! Я ${settings.name}. Нажмите на микрофон и скажите команду — например, «какая погода в ${settings.city}» или «открой YouTube».` });
    },
    notice(text) { this.botMsg({ text }); },
    hideHints() { $("#hints").hidden = true; },
    setMic(state) { $("#btnMic").dataset.state = state; },
    interim(t) { $("#interim").textContent = t; },
    setWake(on) {
      $("#wakeToggle").checked = on;
      SpeechInput.setWake(on);
      if (on) this.notice(`Постоянный режим включён. Обращайтесь по имени: «${settings.name}, который час?»`);
    },
    scroll() { this.log.scrollTop = this.log.scrollHeight; },
    userMsg(text, via) {
      const el = document.createElement("div");
      el.className = "msg user";
      el.innerHTML = `<div class="bubble">${esc(text)}</div><span class="via">${esc(via)}</span>`;
      this.log.appendChild(el); this.scroll();
    },
    botMsg(res, meta) {
      const el = document.createElement("div");
      el.className = "msg bot";
      let html = `<div class="bubble">${esc(res.text)}</div>`;
      if (res.card) html += res.card;
      if (meta) {
        html += `<div class="meta"><span class="intent ${meta.low ? "low" : ""}">${meta.intent} · ${(meta.confidence * 100).toFixed(0)}%</span>` +
          `<button class="fix" type="button">исправить</button></div>`;
      }
      el.innerHTML = html;
      if (meta) {
        el.querySelector(".fix").addEventListener("click", (ev) => {
          const sel = document.createElement("select");
          sel.className = "fix-select";
          sel.setAttribute("aria-label", "Правильное намерение");
          sel.innerHTML = `<option value="">правильное намерение…</option>` +
            Model.clf.labels.map((l) => `<option value="${l}">${l} — ${INTENT_NAMES[l] || l}</option>`).join("");
          sel.addEventListener("change", () => {
            if (!sel.value) return;
            settings.userExamples.push({ text: meta.text, intent: sel.value });
            Store.save(settings);
            Model.retrain();
            this.modelReady();
            const note = document.createElement("span");
            note.textContent = `пример добавлен, модель переобучена`;
            sel.replaceWith(note);
            DialogManager.handle(meta.text, "повтор после обучения");
          });
          ev.target.replaceWith(sel);
          sel.focus();
        });
      }
      this.log.appendChild(el); this.scroll();
    },
    modelReady() {
      const r = Model.report;
      const pill = $("#pillModel");
      pill.textContent = r ? `модель: ${(r.accuracy * 100).toFixed(0)}% на тесте` : "модель готова";
      pill.className = "pill ok";
    },
    serverState(on) {
      const p = $("#pillServer");
      p.textContent = on ? "сервер: подключён" : "сервер: нет (программы не запускаются)";
      p.className = "pill " + (on ? "ok" : "warn");
    },

    // ---------- вкладка «Обучение» ----------
    initTrain() {
      $("#exIntent").innerHTML = Object.keys(window.DATASET).map((l) => `<option value="${l}">${l} — ${INTENT_NAMES[l]}</option>`).join("");
      $("#btnRetrain").addEventListener("click", () => {
        const b = $("#btnRetrain");
        b.disabled = true; $("#trainStatus").textContent = "Обучение…";
        setTimeout(() => {
          const r = Model.retrain();
          this.modelReady(); this.renderTrain();
          $("#trainStatus").textContent = `Модель переобучена за ${(r.ms / 1000).toFixed(1)} с: ${r.totalSize} примеров, ${r.features} признаков.`;
          b.disabled = false;
        }, 30);
      });
      $("#probeForm").addEventListener("submit", (e) => { e.preventDefault(); this.renderProbe(); });
      $("#exampleForm").addEventListener("submit", (e) => {
        e.preventDefault();
        const t = $("#exText").value.trim(); if (!t) return;
        settings.userExamples.push({ text: t, intent: $("#exIntent").value });
        Store.save(settings); $("#exText").value = "";
        this.renderExamples();
        $("#trainStatus").textContent = "Пример добавлен. Нажмите «Переобучить модель», чтобы учесть его.";
      });
      window.addEventListener("resize", () => { if (!$("#view-train").hidden) this.drawChart(); });
    },
    renderTrain() {
      const r = Model.report;
      if (!r) return;
      const m = (v, l, key) => `<div class="metric ${key ? "key" : ""}"><b>${v}</b><span>${l}</span></div>`;
      $("#metrics").innerHTML =
        m((r.accuracy * 100).toFixed(1) + "%", "точность на тесте", true) +
        m((r.macroF1 * 100).toFixed(1) + "%", "macro F1") +
        m(r.totalSize, "примеров всего") +
        m(`${r.trainSize} / ${r.testSize}`, "обучение / тест") +
        m(r.labels.length, "намерений") +
        m(r.features, "признаков");
      if (!$("#trainStatus").textContent)
        $("#trainStatus").textContent = Model.clf.trainedAt ? "Обучена: " + new Date(Model.clf.trainedAt).toLocaleString("ru-RU") + ". Эпох: " + Model.clf.history.length + "." : "";
      $("#classTable").innerHTML = "<tr><th>намерение</th><th>precision</th><th>recall</th><th>F1</th><th>n</th></tr>" +
        r.perClass.map((c) => `<tr><td>${c.label}</td><td>${(c.precision * 100).toFixed(0)}%</td><td>${(c.recall * 100).toFixed(0)}%</td><td>${(c.f1 * 100).toFixed(0)}%</td><td>${c.support}</td></tr>`).join("");
      const max = Math.max(1, ...r.confusion.flat());
      $("#confusion").innerHTML = "<tr><th></th>" + r.labels.map((l) => `<th class="c">${l}</th>`).join("") + "</tr>" +
        r.confusion.map((row, i) => `<tr><th class="r">${r.labels[i]}</th>` + row.map((v, j) => {
          const a = v / max;
          const bg = v === 0 ? "transparent" : i === j ? `color-mix(in srgb, var(--accent) ${Math.round(25 + a * 75)}%, transparent)` : `color-mix(in srgb, var(--listen) ${Math.round(30 + a * 70)}%, transparent)`;
          return `<td style="background:${bg}">${v || ""}</td>`;
        }).join("") + "</tr>").join("");
      this.renderExamples();
      this.renderDataset();
      this.renderProbe();
      this.drawChart();
    },
    renderProbe() {
      const t = $("#probeInput").value;
      if (!t.trim()) { $("#probeOut").innerHTML = ""; return; }
      const p = Model.predict(t);
      $("#probeOut").innerHTML = p.ranking.slice(0, 5).map((r) =>
        `<div class="prob"><span>${r.intent}</span><span class="bar"><i style="width:${(r.p * 100).toFixed(1)}%"></i></span><span class="v">${(r.p * 100).toFixed(1)}%</span></div>`).join("");
    },
    renderExamples() {
      const ul = $("#userExamples");
      ul.innerHTML = settings.userExamples.length ? settings.userExamples.map((e, i) =>
        `<li><span>«${esc(e.text)}» → <code>${e.intent}</code></span><button type="button" data-i="${i}" aria-label="Удалить">✕</button></li>`).join("")
        : `<li class="muted">Своих примеров пока нет.</li>`;
      ul.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
        settings.userExamples.splice(+b.dataset.i, 1); Store.save(settings); this.renderExamples();
      }));
    },
    renderDataset() {
      const d = Model.allData();
      $("#datasetView").innerHTML = Object.keys(d).map((k) =>
        `<div class="ds"><b><span>${k}</span><span>${d[k].length}</span></b><p>${d[k].slice(0, 6).map(esc).join(" · ")}…</p></div>`).join("");
    },
    drawChart() {
      const cv = $("#lossChart"), h = Model.clf.history;
      if (!h || !h.length) return;
      const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = 220;
      cv.width = W * dpr; cv.height = H * dpr;
      const ctx = cv.getContext("2d"); ctx.scale(dpr, dpr);
      const css = getComputedStyle(document.documentElement);
      const col = (n) => css.getPropertyValue(n).trim();
      const pad = { l: 40, r: 40, t: 12, b: 28 }, w = W - pad.l - pad.r, hh = H - pad.t - pad.b;
      const maxLoss = Math.max(...h.map((e) => e.loss));
      const x = (i) => pad.l + (i / (h.length - 1)) * w;
      ctx.font = "11px " + col("--font-mono");
      ctx.strokeStyle = col("--line"); ctx.fillStyle = col("--muted"); ctx.lineWidth = 1;
      for (let k = 0; k <= 4; k++) {
        const y = pad.t + (k / 4) * hh;
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
        ctx.textAlign = "right"; ctx.fillText((maxLoss * (1 - k / 4)).toFixed(2), pad.l - 6, y + 4);
        ctx.textAlign = "left"; ctx.fillText(Math.round(100 * (1 - k / 4)) + "%", W - pad.r + 6, y + 4);
      }
      ctx.textAlign = "center";
      [1, Math.round(h.length / 2), h.length].forEach((ep) => ctx.fillText("эпоха " + ep, x(ep - 1), H - 8));
      const line = (key, color, scale) => {
        ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2;
        h.forEach((e, i) => { const y = pad.t + hh * (1 - e[key] / scale); i ? ctx.lineTo(x(i), y) : ctx.moveTo(x(i), y); });
        ctx.stroke();
      };
      line("loss", col("--listen"), maxLoss);
      line("acc", col("--accent"), 1);
    },

    // ---------- вкладка «Настройки» ----------
    fillVoices(voices) {
      const s = $("#setVoice");
      s.innerHTML = voices.length ? voices.map((v) => `<option ${v.name === settings.voice ? "selected" : ""}>${esc(v.name)}</option>`).join("")
        : "<option>русские голоса не найдены</option>";
    },
    initSettings() {
      const bind = (id, key, fmt) => {
        const el = $(id);
        if (el.type === "checkbox") el.checked = settings[key]; else el.value = settings[key];
        const upd = () => { if (fmt) fmt(); };
        upd();
        el.addEventListener("input", () => {
          settings[key] = el.type === "checkbox" ? el.checked : el.type === "range" ? +el.value : el.value;
          Store.save(settings); upd();
          if (key === "name") $("#assistantName").textContent = settings.name || "Лира";
        });
      };
      bind("#setName", "name"); bind("#setCity", "city"); bind("#setSpeak", "speak");
      bind("#setRate", "rate", () => ($("#rateVal").textContent = (+settings.rate).toFixed(1) + "×"));
      bind("#setThreshold", "threshold", () => ($("#thrVal").textContent = Math.round(settings.threshold * 100) + "%"));
      $("#setVoice").addEventListener("change", (e) => { settings.voice = e.target.value; Store.save(settings); });
      $("#btnTestVoice").addEventListener("click", () => SpeechOutput.say(`Привет! Я ${settings.name}. Так звучит мой голос.`));
      let armed = false;
      $("#btnReset").addEventListener("click", (e) => {
        if (!armed) { armed = true; e.target.textContent = "Нажмите ещё раз для сброса"; return; }
        Store.clear(); Object.assign(settings, JSON.parse(JSON.stringify(Store.defaults)));
        $("#resetNote").textContent = "Сброшено. Перезагрузите страницу.";
        e.target.textContent = "Сбросить настройки и свои примеры"; armed = false;
      });
      const n = Object.values(window.DATASET).reduce((a, v) => a + v.length, 0);
      document.querySelectorAll("#view-settings p").forEach((p) => (p.innerHTML = p.innerHTML.replace("{N}", n)));
    }
  };

  // ================= PWA =================
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); deferredPrompt = e; $("#btnInstall").hidden = false;
  });
  function initPWA() {
    $("#btnInstall").addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $("#btnInstall").hidden = true;
    });
    if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // ================= Запуск =================
  document.addEventListener("DOMContentLoaded", async () => {
    UI.init();
    Model.init();
    SpeechOutput.init();
    SpeechInput.init();
    initPWA();
    UI.serverState(await LocalServer.ping());
  });

  // Для отладки из консоли
  window.Lira = { Model, DialogManager, EntityExtractor, settings };
})();
