// Анимации дашборда: счётчики от нуля, появление блоков, рост полос и колец, анимация графика.
// Работает поверх любой отрисовки (app.js, programs.js, curators.js и др.): следит за DOM
// и запускает анимацию, когда элемент впервые появляется на экране.

(function () {
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;
  if (!reduceMotion) root.classList.add('motion');

  // ---------- что анимируем ----------

  // Числа, которые «крутятся» от нуля
  const COUNT_SELECTORS = [
    '[data-count]',
    '#heroTotalCount', '#heroTotalDelta', '#yearProgressPct', '#yearProgressDays',
    '#circleGzVal', '#circleKvcVal', '#circleMfcVal', '#circleOmsuVal',
    '#cardsContainer .text-3xl', '#cardsContainer .font-black', '#cardsContainer strong',
    '#attentionCardsGrid .font-extrabold', '#attentionCardsGrid .font-black', '#attentionCardsGrid strong',
    '#attentionCardsGrid .text-rose-600', '#attentionCardsGrid .text-rose-700',
    '#structureDirections .font-extrabold', '#structureKvc .font-extrabold', '#structureDirNote strong',
    '#summaryTableBody td',
    '#reconcileSummary span',
    '#blockSchedule .font-black', '#blockSchedule .font-extrabold',
    '#blockRating td', '#blockCurators td',
    '#statusWeekPanel strong', '#statusWeekPanel .font-bold'
  ].join(',');

  // Полосы прогресса: растут слева направо
  const BAR_SELECTORS = [
    '#cardsContainer [style*="width"]',
    '#structureDirections [style*="width"]', '#structureKvc [style*="width"]',
    '#blockRating [style*="width"]', '#blockCurators [style*="width"]',
    '#blockSchedule .gantt-bar'
  ].join(',');

  // Блоки, которые плавно появляются при прокрутке
  const REVEAL_SELECTORS = [
    '#sectionDashboard > .grid > *', '#sectionDashboard > div:not(.grid)',
    '#cardsContainer > .kpi-bento-card', '#attentionCardsGrid > *',
    '#circularProgressGrid > *'
  ].join(',');

  // ---------- счётчики ----------

  // число с разделителями разрядов («2 542», «1 993») и необязательной дробной частью через запятую
  const NUM_RE = /\d{1,3}(?:[   ]\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g;
  const DURATION = 1300;
  const easeOutExpo = t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

  function fmt(value, decimals, grouped) {
    const s = value.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    return grouped ? s : s.replace(/[   ]/g, '');
  }

  // Разбор текстового узла на статичные куски и числа. Даты и время («05.10», «22:54») не трогаем.
  function parseTextNode(node) {
    const text = node.nodeValue;
    if (!text || !/\d/.test(text) || /\d[.:]\d/.test(text)) return null;
    const parts = [];
    let last = 0;
    let hasNum = false;
    text.replace(NUM_RE, (m, idx) => {
      const plain = m.replace(/[   ]/g, '');
      const value = parseFloat(plain.replace(',', '.'));
      const isYear = /^20\d\d$/.test(plain);
      if (idx > last) parts.push(text.slice(last, idx));
      if (isYear || !isFinite(value) || value === 0) {
        parts.push(m);
      } else {
        parts.push({ value, decimals: (plain.split(',')[1] || '').length, grouped: /[   ]/.test(m) || value >= 10000 });
        hasNum = true;
      }
      last = idx + m.length;
      return m;
    });
    if (!hasNum) return null;
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  }

  const running = new Set();
  let rafId = null;

  function tick(now) {
    running.forEach(job => {
      const t = Math.min(1, (now - job.start) / job.duration);
      if (t < 0) return;
      const k = easeOutExpo(t);
      job.node.nodeValue = job.parts.map(p => (typeof p === 'string' ? p : fmt(p.value * k, p.decimals, p.grouped && p.value * k >= 1000))).join('');
      if (t >= 1) {
        job.node.nodeValue = job.final;
        running.delete(job);
      }
    });
    rafId = running.size ? requestAnimationFrame(tick) : null;
  }

  function animateCount(el, delay) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const jobs = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.__counting) continue;
      const parts = parseTextNode(node);
      if (!parts) continue;
      const final = node.nodeValue;
      node.__counting = true;
      jobs.push({ node, parts, final, start: performance.now() + delay, duration: DURATION });
      node.nodeValue = parts.map(p => (typeof p === 'string' ? p : fmt(0, p.decimals, false))).join('');
    }
    if (!jobs.length) return;
    el.classList.add('is-counting');
    jobs.forEach(j => running.add(j));
    if (!rafId) rafId = requestAnimationFrame(tick);
    setTimeout(() => {
      el.classList.remove('is-counting');
      jobs.forEach(j => { j.node.__counting = false; });
    }, DURATION + delay + 50);
  }

  // ---------- полосы ----------

  function animateBar(el, delay) {
    el.classList.add('bar-grow');
    el.style.transitionDelay = `${delay}ms`;
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('bar-in')));
  }

  // ---------- появление на экране ----------

  const pending = new WeakMap(); // элемент → функция запуска
  let staggerClock = 0;
  let staggerIndex = 0;
  const nextDelay = () => {
    const now = performance.now();
    if (now - staggerClock > 120) staggerIndex = 0;
    staggerClock = now;
    return Math.min(staggerIndex++ * 45, 450);
  };

  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const run = pending.get(entry.target);
        io.unobserve(entry.target);
        pending.delete(entry.target);
        if (run) run(nextDelay());
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.05 })
    : null;

  function whenVisible(el, run) {
    if (!io) { run(0); return; }
    pending.set(el, run);
    io.observe(el);
  }

  function prepare(el) {
    if (reduceMotion || !(el instanceof Element)) return;
    if (el.matches(REVEAL_SELECTORS) && !el.__revealed) {
      el.__revealed = true;
      el.classList.add('reveal');
      whenVisible(el, delay => {
        el.style.transitionDelay = `${delay}ms`;
        el.classList.add('reveal-in');
        setTimeout(() => { el.style.transitionDelay = ''; }, 900 + delay);
      });
    }
    if (el.matches(BAR_SELECTORS) && !el.__barred) {
      el.__barred = true;
      el.classList.add('bar-grow');
      whenVisible(el, delay => animateBar(el, delay + 120));
    }
    if (el.matches(COUNT_SELECTORS)) {
      whenVisible(el, delay => animateCount(el, delay + 80));
    }
  }

  function scan(node) {
    if (!(node instanceof Element)) return;
    prepare(node);
    node.querySelectorAll(`${COUNT_SELECTORS},${BAR_SELECTORS},${REVEAL_SELECTORS}`).forEach(prepare);
  }

  // ---------- кольца «Процент от плана» ----------

  function animateRings() {
    document.querySelectorAll('#circularProgressGrid circle[id]').forEach(c => c.classList.add('ring-anim'));
  }

  // ---------- Chart.js ----------

  function setupChartDefaults() {
    if (!window.Chart) return;
    const d = Chart.defaults;
    d.font.family = '"Plus Jakarta Sans", Inter, system-ui, sans-serif';
    d.animation.duration = reduceMotion ? 0 : 1100;
    d.animation.easing = 'easeOutQuart';
    d.transitions.active.animation.duration = 200;
    d.plugins.tooltip.usePointStyle = true;
    d.plugins.tooltip.boxPadding = 4;
  }

  // Анимация входа для линейного графика: линии поднимаются от нуля волной слева направо.
  // Только при первой отрисовке: ресайз, переключение серий и подсказки анимируются обычным образом.
  window.motionLineAnimation = function () {
    if (reduceMotion) return {};
    const firstDraw = ctx => ctx.type === 'data' && ctx.mode === 'default' && !ctx.chart.$motionDone;
    return {
      animation: { onComplete: e => { e.chart.$motionDone = true; } },
      animations: {
        y: {
          type: 'number',
          easing: 'easeOutCubic',
          duration: 900,
          from: ctx => (firstDraw(ctx) && ctx.chart.scales.y ? ctx.chart.scales.y.getPixelForValue(0) : undefined),
          delay: ctx => (firstDraw(ctx) ? ctx.dataIndex * 45 + ctx.datasetIndex * 70 : 0)
        }
      }
    };
  };

  // Отложить действие до появления элемента на экране (график динамики)
  window.motionWhenVisible = (el, fn) => (reduceMotion ? fn() : whenVisible(el, () => fn()));

  // ---------- запуск ----------

  function start() {
    setupChartDefaults();
    scan(document.body);
    animateRings();
    new MutationObserver(muts => {
      muts.forEach(m => {
        if (m.type === 'childList') {
          m.addedNodes.forEach(scan);
          // текст заменили в существующем элементе (например, итог в hero-карточке)
          if (m.target instanceof Element && m.addedNodes.length && m.target.matches(COUNT_SELECTORS) && !m.target.classList.contains('is-counting')) {
            const onlyText = [...m.addedNodes].every(n => n.nodeType === Node.TEXT_NODE);
            if (onlyText) whenVisible(m.target, delay => animateCount(m.target, delay));
          }
        }
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
